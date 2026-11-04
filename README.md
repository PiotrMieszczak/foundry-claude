# foundry-mcp

An MCP server that lets AI assistants (Claude, Codex, Gemini CLI, Cursor and other MCP clients) read and write your [Foundry VTT](https://foundryvtt.com) v14 world: actors, items, scenes, journals, chat and dice rolls. It can't delete anything.

It runs as a small Node service next to Foundry. It logs in as a dedicated Foundry user, the same way a browser does, so no browser tab has to stay open.

## Tools

| Tool | What it returns |
|---|---|
| `search_world` | Actors, items, journals, scenes, roll tables and playlists whose name contains some text |
| `get_actor` | One actor, with its system data and item list |
| `get_scene` | One scene: background, size and tokens |
| `get_journal` | One journal entry, with the plain text of its pages |
| `list_compendium` | The world's compendium packs, or the documents in one pack |

Write tools act as the server's Foundry user, so that user's role limits them:

| Tool | What it does |
|---|---|
| `create_npc` | Creates a Mongoose Traveller 2e (`mgt2e`) NPC or traveller from a UPP, skills and gear names. Computes characteristic DMs and hits. |
| `create_journal` | Creates a journal entry from Markdown pages |
| `show_journal_to_players` | Gives players Observer permission on a journal entry and posts a chat link to it |
| `set_active_scene` | Activates a scene, which moves every player to it |
| `post_chat` | Posts a Markdown chat message, for everyone or whispered to GMs |
| `roll` | Rolls dice on the server (Traveller: 2d6 + DM against a difficulty, with Effect) and posts the roll to chat |
| `create_documents` | Creates any documents from raw data: items, scenes, roll tables, folders, macros, or embedded ones such as an item on an actor |
| `update_documents` | Changes fields on documents, in dot notation (`"system.characteristics.STR.value": 9`) |

## Requirements

- Foundry VTT 14.x, with a world that **launches at startup**. The server can only connect while a world is running. Use `--world <id>`, or `FOUNDRY_WORLD=<id>` with the [felddy/foundryvtt](https://github.com/felddy/foundryvtt-docker) image.
- A Foundry user for the server. In your world, go to **Configure Players** and add a user (for example `Claude`) with a strong password. The **Gamemaster** role gives full access; a lower role limits what the AI can see and change.
- Docker, or Node.js 22+.
- For claude.ai and Claude Desktop: a public **HTTPS** URL for the server, provided by a reverse proxy such as Caddy, nginx, Traefik or Cloudflare Tunnel. Local clients can use `http://localhost`.

## Run it

```bash
git clone https://github.com/PiotrMieszczak/foundry-mcp.git
cd foundry-mcp
cp .env.example .env
```

Fill in `.env`:

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | Where clients reach this server, without `/mcp` (for example `https://mcp.example.com`) |
| `OWNER_PASSWORD` | Turns on OAuth. This is the password you type on the sign-in page when a client connects. Required for claude.ai and Claude Desktop. |
| `API_TOKEN` | Turns on a static `Authorization: Bearer` token, for clients that can send headers |
| `FOUNDRY_URL` | Foundry as seen from this server (for example `http://foundry:30000` on a shared Docker network) |
| `FOUNDRY_USER` / `FOUNDRY_PASSWORD` | The Foundry user the server logs in as |
| `DATA_DIR` | Where OAuth registrations and hashed tokens are kept (`/data` in Docker) |

Set at least one of `OWNER_PASSWORD` and `API_TOKEN`. Generate them with `openssl rand -base64 32`.

**With Docker Compose**, next to a Foundry container on the network `foundry-net`:

```bash
docker network create foundry-net
```

```bash
docker network connect foundry-net <your-foundry-container>
```

```bash
mkdir -p data && sudo chown 1000:1000 data
```

```bash
docker compose up -d --build
```

The server listens on port 3000. Point your HTTPS proxy at it.

**Without Docker:**

```bash
npm ci
```

```bash
npm run build
```

```bash
set -a; . ./.env; set +a; node packages/mcp-server/dist/main.js
```

**Check it:**

```bash
curl http://localhost:3000/healthz
```

```bash
set -a; . ./.env; set +a; npm run smoke -w @foundry-mcp/mcp-server
```

The health check prints `ok`. The smoke test logs in to Foundry and prints how many actors, scenes and packs it found.

## Connect your AI client

In the examples below, replace `https://mcp.example.com/mcp` with your `PUBLIC_URL` plus `/mcp`, and `YOUR_API_TOKEN` with your `API_TOKEN`. Each client can sign in with **OAuth**, which opens a browser where you enter `OWNER_PASSWORD`, or with the **static token** sent as a header.

### Claude (claude.ai and Claude Desktop)

Custom connectors are set up on claude.ai and appear in Claude Desktop and mobile too. ([docs](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp))

1. On a personal plan, open **Customize → Connectors → + Add → Add custom connector**. On Team or Enterprise, an owner adds it under **Organization settings → Connectors**.
2. Enter a name (`Foundry`) and the URL `https://mcp.example.com/mcp`.
3. Choose **Sign in** (OAuth) and enter `OWNER_PASSWORD` on the page that opens. Alternatively, put `Authorization: Bearer YOUR_API_TOKEN` under **Request headers**.

The server must be reachable from the internet over HTTPS. `claude_desktop_config.json` only runs local stdio servers, so use connectors for this one.

### Claude Code

([docs](https://code.claude.com/docs/en/mcp))

With OAuth: add the server, then run `/mcp` in Claude Code and sign in.

```bash
claude mcp add --transport http foundry https://mcp.example.com/mcp
```

With the static token:

```bash
claude mcp add --transport http foundry https://mcp.example.com/mcp --header "Authorization: Bearer YOUR_API_TOKEN"
```

Add `--scope user` to make the server available in every project. When a header is set, Claude Code uses it instead of OAuth.

### OpenAI Codex (CLI, IDE extension, ChatGPT desktop)

All three read `~/.codex/config.toml`. ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli))

With OAuth:

```bash
codex mcp add foundry --url https://mcp.example.com/mcp
```

```bash
codex mcp login foundry
```

With the static token, kept in an environment variable:

```toml
[mcp_servers.foundry]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "FOUNDRY_MCP_TOKEN"
```

```bash
export FOUNDRY_MCP_TOKEN=YOUR_API_TOKEN
```

### Gemini CLI

([docs](https://geminicli.com/docs/tools/mcp-server/))

```bash
gemini mcp add --transport http -s user foundry https://mcp.example.com/mcp --header "Authorization: Bearer YOUR_API_TOKEN"
```

Or edit `~/.gemini/settings.json` by hand. Use `httpUrl` (Streamable HTTP), not `url` (SSE):

```json
{
  "mcpServers": {
    "foundry": {
      "httpUrl": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_TOKEN" }
    }
  }
}
```

For OAuth, leave out `headers`, start Gemini CLI, and run `/mcp auth foundry`.

### Cursor

Add the server to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project). ([docs](https://cursor.com/docs/context/mcp))

```json
{
  "mcpServers": {
    "foundry": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:FOUNDRY_MCP_TOKEN}" }
    }
  }
}
```

Leave out `headers` to sign in with OAuth instead.

### Other clients

Any client that supports remote MCP servers over Streamable HTTP works the same way: give it the URL, plus either OAuth or an `Authorization: Bearer` header. For example, VS Code with GitHub Copilot uses `mcp.json` with `"type": "http"` ([docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)).

### Running everything locally

If your client and the server run on the same machine, skip HTTPS. Set `PUBLIC_URL=http://localhost:3000` and `API_TOKEN`, then use `http://localhost:3000/mcp` with the header. claude.ai custom connectors can't reach `localhost`, so they need a public HTTPS URL.

## Security

- Anyone holding a valid token acts as your Foundry user. Keep `OWNER_PASSWORD`, `API_TOKEN` and `.env` secret, use HTTPS, and give the Foundry user only the role it needs. The write tools change your world for real, so back it up. A Player-role user can only write what that player owns.
- OAuth sign-in locks for 15 minutes after five wrong passwords. Tokens are stored hashed.
- Never put a token in a URL. Send it as a header.

## Development

```bash
npm ci
```

```bash
npm test
```

[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) covers the design, the Foundry protocol, the write tools and the planned widgets.

## Licence

MIT
