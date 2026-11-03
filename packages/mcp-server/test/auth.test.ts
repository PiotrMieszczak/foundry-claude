import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { OwnerAuthProvider, withStaticToken } from "../src/auth.js";

describe("withStaticToken", () => {
  it("accepts the API token and rejects others when OAuth is off", async () => {
    const verifier = withStaticToken(undefined, "s3cret-token");
    expect((await verifier.verifyAccessToken("s3cret-token")).clientId).toBe("api-token");
    await expect(verifier.verifyAccessToken("wrong")).rejects.toThrow();
  });
});

function fakeRes() {
  const res = { statusCode: 200, location: "", body: "" } as any;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.type = () => res;
  res.send = (b: string) => ((res.body = b), res);
  res.redirect = (url: string) => ((res.statusCode = 302), (res.location = url), res);
  return res as Response & { statusCode: number; location: string; body: string };
}

async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "fc-auth-")), "oauth.json");
  const provider = new OwnerAuthProvider("correct horse", file);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" });
  const form = { client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "s1", code_challenge: "ch" };
  return { file, provider, client, form };
}

describe("OwnerAuthProvider", () => {
  it("issues a code only for the right password and exchanges it once", async () => {
    const { provider, client, form } = await setup();

    const wrong = fakeRes();
    await provider.login({ body: { ...form, password: "nope" } } as Request, wrong);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain("nope");

    const ok = fakeRes();
    await provider.login({ body: { ...form, password: "correct horse" } } as Request, ok);
    const url = new URL(ok.location);
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code")!;

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe("ch");
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(client.client_id);
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();

    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
    expect((await provider.verifyAccessToken(rotated.access_token)).clientId).toBe(client.client_id);
  });

  it("rejects unregistered redirect URIs", async () => {
    const { provider, form } = await setup();
    const res = fakeRes();
    await provider.login({ body: { ...form, redirect_uri: "https://evil.example/cb", password: "correct horse" } } as Request, res);
    expect(res.statusCode).toBe(400);
  });

  it("locks out after five wrong passwords", async () => {
    const { provider, form } = await setup();
    for (let i = 0; i < 5; i++) await provider.login({ body: { ...form, password: "x" } } as Request, fakeRes());
    const res = fakeRes();
    await provider.login({ body: { ...form, password: "correct horse" } } as Request, res);
    expect(res.statusCode).toBe(429);
  });

  it("keeps clients and tokens across restarts", async () => {
    const { file, provider, client, form } = await setup();
    const res = fakeRes();
    await provider.login({ body: { ...form, password: "correct horse" } } as Request, res);
    const tokens = await provider.exchangeAuthorizationCode(client, new URL(res.location).searchParams.get("code")!);
    const reloaded = new OwnerAuthProvider("correct horse", file);
    expect(await reloaded.clientsStore.getClient(client.client_id)).toBeTruthy();
    expect((await reloaded.verifyAccessToken(tokens.access_token)).clientId).toBe(client.client_id);
  });
});
