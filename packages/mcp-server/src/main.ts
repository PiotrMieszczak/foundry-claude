import { join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OwnerAuthProvider, withStaticToken } from "./auth.js";
import { foundryOptions } from "./config.js";
import { FoundryClient } from "./foundry/client.js";
import { registerWorldTools } from "./tools/world.js";
import { registerWriteTools } from "./tools/write.js";

const port = Number(process.env.PORT ?? 3000);
const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${port}`);
const mcpUrl = new URL("/mcp", publicUrl);
const ownerPassword = process.env.OWNER_PASSWORD;
const apiToken = process.env.API_TOKEN;
if (!ownerPassword && !apiToken) throw new Error("Set OWNER_PASSWORD (OAuth), API_TOKEN (static bearer token), or both");
const foundry = new FoundryClient(foundryOptions());

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1)); // usually behind a TLS-terminating proxy
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => {
  res.send("ok");
});

let oauth: OwnerAuthProvider | undefined;
if (ownerPassword) {
  oauth = new OwnerAuthProvider(ownerPassword, join(process.env.DATA_DIR ?? "data", "oauth.json"));
  app.use(mcpAuthRouter({ provider: oauth, issuerUrl: publicUrl, resourceServerUrl: mcpUrl, resourceName: "foundry-mcp" }));
  app.post("/login", express.urlencoded({ extended: false }), oauth.login);
}

const auth = requireBearerAuth({
  verifier: withStaticToken(oauth, apiToken),
  ...(oauth && { resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }),
});

// Stateless Streamable HTTP: a fresh MCP server per request, sharing one Foundry connection.
app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req, res) => {
  const server = new McpServer({ name: "foundry-mcp", version: "0.2.0" });
  registerWorldTools(server, foundry);
  registerWriteTools(server, foundry);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all("/mcp", auth, (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method not allowed");
});

app.listen(port, "::", () => console.log(`foundry-mcp listening on [::]:${port}, MCP endpoint ${mcpUrl}`));
