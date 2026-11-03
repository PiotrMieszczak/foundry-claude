# CLAUDE.md

foundry-claude: an MCP server (TypeScript, `packages/mcp-server`) that lets AI clients read and write a Foundry VTT v14 world. Read [README.md](README.md) for running it and connecting clients, and [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for the design and the next stages.

- This repo is public. Never commit hostnames, IPs, ports or paths of a real deployment, and never commit secrets. Use `example.com` placeholders. Private deploy scripts go in `deploy.local.sh`, which git ignores.
- Talk to Foundry only through `FoundryClient` (`src/foundry/client.ts`). Tools return trimmed views (`src/foundry/views.ts`), never raw documents.
- `npm test` runs vitest. Add a test with every new view, mapping or auth path.
