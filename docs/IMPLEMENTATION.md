# Implementation guide

This guide explains how foundry-mcp is built and what comes next. Read it before you change the server.

## Goal

foundry-mcp lets AI clients such as Claude, Codex, Gemini CLI and Cursor read and write a Foundry VTT v14 world. On clients that support MCP Apps, tool results show up as styled widgets.

- **Target:** Foundry 14.x. Development uses the Mongoose Traveller 2e system (`mgt2e`), so system-specific features such as the NPC card and NPC templates start there.
- **Out of scope:** music and asset hosting.

## Architecture

```
AI client ──HTTPS (OAuth or bearer token)──> foundry-mcp (Node, port 3000)
                                               │ socket.io
                                               ▼
                                             Foundry VTT (a running world)
                                               logged in as a dedicated Foundry user
```

- `packages/mcp-server` holds the Express app, MCP over Streamable HTTP (stateless, one `McpServer` per request), auth, the Foundry client and the tools.
- `packages/widgets` (stage 2) will hold one self-contained HTML file per widget, built with Vite and `vite-plugin-singlefile`.

## Decisions and why

| Decision | Why |
|---|---|
| Headless socket client (`src/foundry/client.ts`) | Foundry has no server API. The server logs in like a browser: `GET /join`, then `POST /join`, then a socket.io connection that carries the `session` cookie. No browser tab has to stay open. In v14 the session travels only in the cookie on the WebSocket upgrade. Reference implementation: [thestranjer/foundry-vtt-mcp](https://github.com/thestranjer/foundry-vtt-mcp) (MIT). |
| `Origin` header set to the origin of `FOUNDRY_URL`, and `userId` in the `POST /join` body | Foundry v14 answers 400 when the Origin differs from the host the request reached, and 401 `ErrorUserDoesNotExist` for the older `userid` field. |
| One shared Foundry connection | `FoundryClient` logs in lazily, and logs in again after a disconnect or a Foundry restart. |
| Trimmed views (`src/foundry/views.ts`) | Raw documents are large (actors with full system data, journal pages in HTML), so tools return only what the model needs. |
| Two auth modes (`src/auth.ts`) | **OAuth** (`OWNER_PASSWORD`): claude.ai and Claude Desktop connectors need OAuth with dynamic client registration. A one-person password page issues codes. Tokens are stored SHA-256 hashed in `DATA_DIR/oauth.json`. Access tokens last 1 hour; refresh tokens last 30 days and rotate on use. Five wrong passwords lock sign-in for 15 minutes. **Static token** (`API_TOKEN`): for clients that send headers (Claude Code, Codex, Gemini CLI, Cursor) and for local use without HTTPS. |
| MCP SDK 1.x (`@modelcontextprotocol/sdk` ^1.32) | It pairs with `@modelcontextprotocol/ext-apps` 1.7.x, which the widgets need. Don't move to the 2.x split packages unless ext-apps moves too. |
| The world must be running | The socket protocol exists only while a world is live. Set the world to launch at Foundry start, for example with `--world <id>` or the felddy image's `FOUNDRY_WORLD`. |

## Stages

| # | Stage | Status |
|---|---|---|
| 1 | Skeleton, Foundry client, read tools, auth, Docker | Done |
| 2 | Widgets: NPC card, and a scene and journal preview | Next |
| 3 | Write tools | Planned (below) |

### Stage 2: widgets (MCP Apps)

Use `@modelcontextprotocol/ext-apps` 1.7.x with SDK 1.x. Copy the pattern from Claude's quickstart: <https://claude.com/docs/connectors/building/mcp-apps/quickstart.md>.

1. Create `packages/widgets`:
   - Use Vite with `vite-plugin-singlefile`, and one entry per widget: `npc-card.html` and `scene-journal.html`.
   - Each page imports `App` from `@modelcontextprotocol/ext-apps`, sets `app.ontoolresult` before `await app.connect()`, and renders from the tool's `structuredContent`.
2. Add a theme in `src/theme.css` with a sci-fi terminal look:
   - Monospace type, ship-terminal panels, an amber `#d9a441` accent and a cyan secondary.
   - Read `hostContext.theme` and apply `applyDocumentTheme`, `applyHostStyleVariables` and `applyHostFonts`.
   - Build the palette from host variables where they exist, so both light and dark modes stay readable. Use a transparent body and `<meta name="color-scheme" content="light dark">`.
3. In the server, switch `get_actor`, `get_scene` and `get_journal` to `registerAppTool`:
   - Set `_meta.ui.resourceUri` (`ui://foundry-mcp/npc-card`, `ui://foundry-mcp/scene-journal`).
   - Return `structuredContent` next to the text JSON.
   - Serve the built HTML with `registerAppResource` (MIME `RESOURCE_MIME_TYPE`), and copy the built files into the Docker image.
4. Build the NPC card from a real actor. Fetch one with `get_actor` and map the actual `mgt2e` `system` fields rather than guessing the schema.
   - Show the name, portrait (`img`), UPP (STR DEX END INT EDU SOC as hex digits), skills with levels, and equipment (`items` grouped by type).
   - Then replace the pass-through of `system` in `actorView` with the mapped view, and remove the `shortcut:` comment there.
   - Other systems fall back to a generic card: name, portrait, item list.
5. The scene and journal widget shows the scene thumbnail (`thumb`, else `background`), name, size and token names. For a journal, it shows its pages as readable text and images.
6. CSP:
   - Images load only from hosts listed in `_meta.ui.csp.resourceDomains`. Read the allowed hosts from an env variable (`WIDGET_IMAGE_HOSTS`) that lists Foundry's public host.
   - Keep tool results well under 150k characters, because larger ones break rendering.
7. Test locally with `basic-host` from the ext-apps repo in light and dark mode, then in claude.ai. Clients without MCP Apps support show the text result.

### Stage 3: write tools

Writes run as the configured Foundry user, so that user's role caps what the server can do. Each tool validates its input with zod and returns the trimmed view of the created or updated document.

**Generic tools.** These work for any system:

| Tool | Foundry call | Notes |
|---|---|---|
| `create_documents` | `modify(type, "create", { data, modifiedTime, render: true })` | `type` is one of Actor, Item, JournalEntry, Scene, RollTable, Macro or Playlist. Embedded documents (an item on an actor, a token on a scene) take `parentUuid`. |
| `update_documents` | `modify(type, "update", { updates: [{ _id, ...changes }], diff: true, modifiedTime, render: true })` | Accepts partial changes in dot notation (`"system.characteristics.STR.value": 9`). |
| `delete_documents` | `modify(type, "delete", { ids, modifiedTime, render: true })` | Requires `confirm: true`. The whole tool is off unless `ALLOW_DELETE=true`. |

**Purpose-built tools.** These are easier for a model to use:

| Tool | What it does |
|---|---|
| `create_npc` | Builds an actor from a per-system template (`src/templates/mgt2e/npc.ts`, based on a real `mgt2e` NPC) from fields like name, UPP, skills and gear. |
| `create_item` | Builds a weapon, armour or equipment item from a system template. |
| `create_journal` | Takes Markdown, converts it to HTML pages, and creates the entry. |
| `create_scene` | Takes a name, a background image path (one already uploaded to Foundry), a grid size and an optional token list. |
| `create_roll_table` | Takes a name, a formula and rows `{ range, text }`. |
| `set_active_scene` | Updates the scene with `{ active: true }`. |
| `show_journal_to_players` | Raises `ownership.default` to OBSERVER (2) and posts a chat message that links the entry. Foundry's own "show players" is a client-side broadcast that this socket can't trigger. |
| `post_chat` | Creates a ChatMessage with `content` and `speaker.alias`. |
| `roll` | Evaluates dice on the server (for mgt2e: 2D6 + DM, with Effect = total − 8) and posts a ChatMessage with the serialized `rolls`. Foundry's client-side Roll and system dialogs don't run here. |

Before you build on any write operation, confirm its exact shape against a live server using one throwaway document. Also check that values a system's sheet computes look right after a server-side write; system client code (derived data, hooks) doesn't run for socket writes. File uploads for scene backgrounds and portraits are a separate later step, using Foundry's `/upload` endpoint.

## Testing

- `npm test` runs vitest on the pure parts: cookie parsing, the views, and auth (OAuth registration, wrong password, lockout, code reuse, refresh rotation, persistence, static token).
- `npm run smoke` is a read-only live check against a running Foundry. It needs the `FOUNDRY_*` env. Run it after every Foundry update, because the socket protocol is undocumented.
- To check a deployment from outside, run `curl -sI -X POST https://<your host>/mcp`. With OAuth on, it should return 401 with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource/mcp`.
