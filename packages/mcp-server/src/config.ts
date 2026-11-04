import type { FoundryOptions } from "./foundry/client.js";

export function env(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
}

export const foundryOptions = (): FoundryOptions => ({
  url: env("FOUNDRY_URL"),
  user: env("FOUNDRY_USER"),
  password: env("FOUNDRY_PASSWORD"),
});
