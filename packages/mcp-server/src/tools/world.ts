import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FoundryClient } from "../foundry/client.js";
import { actorView, journalView, sceneView, summary } from "../foundry/views.js";

const SEARCHABLE = ["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Playlist"] as const;

export const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export const lookup = { id: z.string().optional().describe("Document id"), name: z.string().optional().describe("Exact document name") };

export async function findOne(foundry: FoundryClient, type: string, { id, name }: { id?: string; name?: string }) {
  if (!id && !name) throw new Error("Give an id or a name");
  const [doc] = await foundry.get(type, id ? { _id: id } : { name });
  if (!doc) throw new Error(`${type} ${id ?? name} not found`);
  return doc;
}

export function registerWorldTools(server: McpServer, foundry: FoundryClient) {
  const one = (type: string, args: { id?: string; name?: string }) => findOne(foundry, type, args);

  server.registerTool(
    "search_world",
    {
      title: "Search the Foundry world",
      description: "Find actors, items, journals, scenes, roll tables and playlists whose name contains the text.",
      inputSchema: {
        text: z.string().min(1),
        types: z.array(z.enum(SEARCHABLE)).optional().describe("Limit to these document types"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ text, types }) => {
      const needle = text.toLowerCase();
      const found = await Promise.all(
        (types ?? SEARCHABLE).map(async (type) =>
          (await foundry.get(type)).filter((d) => String(d.name).toLowerCase().includes(needle)).map((d) => summary(type, d)),
        ),
      );
      return json(found.flat().slice(0, 50));
    },
  );

  server.registerTool(
    "get_actor",
    { title: "Get an actor", description: "An actor (PC, NPC, ship) with its system data and items.", inputSchema: lookup, annotations: { readOnlyHint: true } },
    async (args) => json(actorView(await one("Actor", args))),
  );

  server.registerTool(
    "get_scene",
    { title: "Get a scene", description: "A scene with its background, size and tokens.", inputSchema: lookup, annotations: { readOnlyHint: true } },
    async (args) => json(sceneView(await one("Scene", args))),
  );

  server.registerTool(
    "get_journal",
    { title: "Get a journal entry", description: "A journal entry with the text of its pages.", inputSchema: lookup, annotations: { readOnlyHint: true } },
    async (args) => json(journalView(await one("JournalEntry", args))),
  );

  server.registerTool(
    "list_compendium",
    {
      title: "List compendiums",
      description: "Without a pack: the world's compendium packs. With a pack id: the documents in it.",
      inputSchema: { pack: z.string().optional().describe('Pack id, e.g. "world.test" or "mgt2e.items"') },
      annotations: { readOnlyHint: true },
    },
    async ({ pack }) => {
      const packs = ((await foundry.world()).packs ?? []) as { id?: string; name: string; packageName?: string; label: string; type: string }[];
      const withId = packs.map((p) => ({ id: p.id ?? `${p.packageName}.${p.name}`, label: p.label, type: p.type }));
      if (!pack) return json(withId);
      const meta = withId.find((p) => p.id === pack);
      if (!meta) throw new Error(`Pack ${pack} not found`);
      return json((await foundry.get(meta.type, {}, pack)).map((d) => summary(meta.type, d)));
    },
  );
}
