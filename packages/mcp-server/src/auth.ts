import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider, OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

// OAuth for one person: the owner logs in with OWNER_PASSWORD on our own page.
// Clients come from dynamic registration (claude.ai does that); tokens are stored hashed.

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

type Grant = { clientId: string; scopes: string[]; resource?: string; expiresAt: number };
type Store = { clients: Record<string, OAuthClientInformationFull>; access: Record<string, Grant>; refresh: Record<string, Grant> };
type PendingCode = { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class OwnerAuthProvider implements OAuthServerProvider {
  private readonly store: Store;
  private readonly codes = new Map<string, PendingCode>();
  private failures: number[] = [];

  constructor(
    private readonly ownerPassword: string,
    private readonly file: string,
  ) {
    try {
      this.store = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.store = { clients: {}, access: {}, refresh: {} };
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.store.clients[id],
      registerClient: (meta) => {
        const client = { ...meta, client_id: randomUUID(), client_id_issued_at: now() };
        this.store.clients[client.client_id] = client;
        this.save();
        return client;
      },
    };
  }

  /** Shows the login page; the form posts to /login, handled by `login` below. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const hidden = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      state: params.state ?? "",
      code_challenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(" "),
      resource: params.resource?.toString() ?? "",
    };
    res.type("html").send(loginPage(client.client_name ?? "An MCP client", hidden));
  }

  login = async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const client = body.client_id ? this.store.clients[body.client_id] : undefined;
    if (!client || !body.redirect_uri || !client.redirect_uris.includes(body.redirect_uri) || !body.code_challenge) {
      res.status(400).send("Invalid authorization request");
      return;
    }
    this.failures = this.failures.filter((t) => Date.now() - t < LOCKOUT_MS);
    if (this.failures.length >= MAX_FAILURES) {
      res.status(429).send("Too many failed attempts. Try again in 15 minutes.");
      return;
    }
    if (!this.passwordMatches(body.password ?? "")) {
      this.failures.push(Date.now());
      res.status(401).type("html").send(loginPage(client.client_name ?? "An MCP client", body, "Wrong password"));
      return;
    }

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      client,
      params: {
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        state: body.state || undefined,
        scopes: body.scope ? body.scope.split(" ") : [],
        resource: body.resource ? new URL(body.resource) : undefined,
      },
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(body.redirect_uri);
    target.searchParams.set("code", code);
    if (body.state) target.searchParams.set("state", body.state);
    res.redirect(target.toString());
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.pending(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string) {
    const pending = this.pending(client, code);
    this.codes.delete(code);
    if (redirectUri && redirectUri !== pending.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, pending.params.scopes ?? [], pending.params.resource?.toString());
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string) {
    const key = hash(refreshToken);
    const grant = this.store.refresh[key];
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt < now()) throw new InvalidGrantError("Invalid refresh token");
    delete this.store.refresh[key];
    return this.issue(grant.clientId, grant.scopes, grant.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.store.access[hash(token)];
    if (!grant || grant.expiresAt < now()) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt, resource: grant.resource ? new URL(grant.resource) : undefined };
  }

  private pending(client: OAuthClientInformationFull, code: string) {
    const pending = this.codes.get(code);
    if (!pending || pending.expiresAt < Date.now() || pending.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return pending;
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const t = now();
    for (const [k, g] of Object.entries(this.store.access)) if (g.expiresAt < t) delete this.store.access[k];
    for (const [k, g] of Object.entries(this.store.refresh)) if (g.expiresAt < t) delete this.store.refresh[k];
    this.store.access[hash(access)] = { clientId, scopes, resource, expiresAt: t + ACCESS_TTL_S };
    this.store.refresh[hash(refresh)] = { clientId, scopes, resource, expiresAt: t + REFRESH_TTL_S };
    this.save();
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
  }

  private passwordMatches(candidate: string) {
    return timingSafeEqual(Buffer.from(hash(candidate)), Buffer.from(hash(this.ownerPassword)));
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.store), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Accepts a fixed API token (for clients that send headers) in addition to OAuth tokens. */
export function withStaticToken(oauth: OAuthTokenVerifier | undefined, apiToken: string | undefined): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (apiToken && timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(apiToken)))) {
        return { token, clientId: "api-token", scopes: [] };
      }
      if (!oauth) throw new InvalidTokenError("Invalid token");
      return oauth.verifyAccessToken(token);
    },
  };
}

function loginPage(clientName: string, fields: Record<string, string | undefined>, error?: string) {
  const inputs = Object.entries(fields)
    .filter(([k]) => k !== "password")
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v ?? "")}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>foundry-claude sign-in</title><style>
body{font:16px/1.5 ui-monospace,Menlo,monospace;background:#0d1117;color:#e6e1d3;display:grid;place-items:center;min-height:100vh;margin:0}
form{border:1px solid #d9a441;padding:24px;max-width:340px;width:calc(100% - 32px)}h1{font-size:18px;color:#d9a441;margin:0 0 8px}
input[type=password],button{width:100%;box-sizing:border-box;padding:10px;margin-top:12px;font:inherit}button{background:#d9a441;border:0;color:#0d1117;cursor:pointer}
.err{color:#ff8a80}</style></head><body><form method="post" action="/login"><h1>foundry-claude</h1>
<p>${escape(clientName)} wants access to your Foundry world.</p>${error ? `<p class="err" role="alert">${escape(error)}</p>` : ""}
<label for="pw">Owner password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
${inputs}<button type="submit">Allow</button></form></body></html>`;
}
