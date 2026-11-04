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
| 3 | Write tools | Done (v0.2.0) |

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

Writes run as the configured Foundry user, so that user's role caps what the server can do. The tools are in `src/tools/write.ts`; each validates its input with zod. There is no delete tool on purpose.

| Tool | Foundry call | Notes |
|---|---|---|
| `create_documents` | `modify(type, "create", { data, parentUuid? })` | World types plus embedded ones (`Item` on an actor, `Token` or `Note` on a scene, `JournalEntryPage`, `TableResult`, `PlaylistSound`). |
| `update_documents` | `modify(type, "update", { updates, diff: true, parentUuid? })` | Dot-notation keys deep-merge. |
| `create_npc` | one `create` with a complete `system`, then items with `parentUuid` | See below. |
| `create_journal` | `create` with `pages` of type `text` (`format: 1`, HTML) | Markdown goes through `marked`. |
| `show_journal_to_players` | `update` of `ownership.default` to 2, then a chat message with `@UUID[JournalEntry.id]{name}` | Foundry's own "show players" is a client-side broadcast this socket can't send. |
| `set_active_scene` | one `update` that sets `active: false` on the current scene and `active: true` on the new one | Switching between two scenes isn't tested live yet, because it moves every connected player. |
| `post_chat`, `roll` | `create` a ChatMessage | `author` (the logged-in user id) is required in v14. Whispers go to every user with role 3 or 4. |

What the live server taught us (Foundry 14.370, mgt2e 0.23):

- **A nested object you create replaces the defaults for that object.** Creating an actor with `system.characteristics.STR` alone stores only STR. Updates in dot notation deep-merge.
- **mgt2e fills new actors from a GM browser.** Its `createActor` hook runs only in an open GM client and writes whole `characteristics` and `skills` objects for any that are missing, overwriting values set by a later update. So `create_npc` sends both complete in the create: the 16 characteristics from `MGT2.CHARACTERISTICS` (`src/foundry/mgt2e.ts`) and the skill list copied from an existing mgt2e character with every level reset to 0. With no GM online nothing fills them, so they must be complete either way.
- **Derived values don't compute.** The sheet's code doesn't run for socket writes, so `create_npc` stores characteristic DMs and hits (STR + DEX + END) itself.
- **Rolls.** `src/foundry/dice.ts` rolls with `crypto.randomInt` and serializes a `Roll` (`Die`, `OperatorTerm`, `NumericTerm` terms); Foundry's chat log renders it as a roll.

Not built yet: file uploads for portraits and scene backgrounds (Foundry's `/upload` endpoint), and purpose-built `create_item`, `create_scene` and `create_roll_table` (use `create_documents`).

## Testing

- `npm test` runs vitest on the pure parts: cookie parsing, the views, and auth (OAuth registration, wrong password, lockout, code reuse, refresh rotation, persistence, static token).
- Before changing a write tool, check its shape against a live server on a throwaway document and delete it afterwards. The socket protocol is undocumented.
- `npm run smoke` is a read-only live check against a running Foundry. It needs the `FOUNDRY_*` env. Run it after every Foundry update, because the socket protocol is undocumented.
- To check a deployment from outside, run `curl -sI -X POST https://<your host>/mcp`. With OAuth on, it should return 401 with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource/mcp`.
