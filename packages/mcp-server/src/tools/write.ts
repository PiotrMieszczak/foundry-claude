import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { marked } from "marked";
import { z } from "zod";
import type { Doc, FoundryClient } from "../foundry/client.js";
import { rollDice } from "../foundry/dice.js";
import { CHARACTERISTICS, npcSystem, parseUpp } from "../foundry/mgt2e.js";
import { actorView, journalView, sceneView, summary } from "../foundry/views.js";
import { findOne, json, lookup } from "./world.js";

// Writes run as the configured Foundry user, so its role caps what they can do. There is no
// delete tool on purpose.

const WORLD_TYPES = ["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Macro", "Playlist", "Folder"] as const;
const EMBEDDED_TYPES = ["Item", "ActiveEffect", "JournalEntryPage", "Token", "Note", "TableResult", "PlaylistSound"] as const;
const TYPES = [...new Set([...WORLD_TYPES, ...EMBEDDED_TYPES])] as [string, ...string[]];
const OBSERVER = 2;

const parent = z
  .string()
  .regex(/^[A-Za-z]+\.[A-Za-z0-9]{16}$/)
  .optional()
  .describe('For embedded documents, the parent as "Type.id", e.g. "Actor.aDOK1cdoOsEjCk59" for an item on that actor');

const html = (markdown: string) => marked.parse(markdown, { async: false });

/** Strips what Foundry assigns itself, so a copied document can be created again. */
function copyable({ _id, _stats, folder, sort, ownership, ...rest }: Doc) {
  return rest;
}

export function registerWriteTools(server: McpServer, foundry: FoundryClient) {
  async function chat(content: string, options: { alias?: string; whisperToGm?: boolean; rolls?: string[] } = {}) {
    const author = await foundry.user();
    const gms = options.whisperToGm ? (((await foundry.world()).users ?? []) as Doc[]).filter((u) => u.role >= 3).map((u) => u._id) : [];
    const ack = await foundry.modify("ChatMessage", "create", {
      data: [{ author, content, speaker: { alias: options.alias ?? "Claude" }, whisper: gms, ...(options.rolls && { rolls: options.rolls }) }],
    });
    return ack.result?.[0] as Doc;
  }

  /** The skill list of an existing mgt2e character, from the world or the system's compendium. */
  async function skillList() {
    const isCharacter = (a: Doc) => ["npc", "traveller"].includes(a.type) && Object.keys(a.system?.skills ?? {}).length > 0;
    const actor =
      (await foundry.get("Actor")).find(isCharacter) ?? (await foundry.get("Actor", {}, "mgt2e.base-actors").catch(() => [] as Doc[])).find(isCharacter);
    if (!actor) throw new Error("No mgt2e character to copy the skill list from; create one character in Foundry first");
    return actor.system.skills as Record<string, any>;
  }

  server.registerTool(
    "create_documents",
    {
      title: "Create documents",
      description:
        "Create Foundry documents of one type from raw data, for anything the other create tools don't cover (items, scenes, roll tables, folders, macros). Data follows the world's system; read a similar document first with get_actor, get_scene or list_compendium to copy its shape. A nested object you send replaces the system's defaults for that object, so send whole objects or set nested fields afterwards with update_documents.",
      inputSchema: {
        type: z.enum(TYPES),
        documents: z.array(z.record(z.string(), z.any())).min(1).max(50).describe("Document data, e.g. { name, type, system }"),
        parent,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ type, documents, parent }) => {
      const ack = await foundry.modify(type, "create", { data: documents, ...(parent && { parentUuid: parent }) });
      return json((ack.result ?? []).map((d: Doc) => summary(type, d)));
    },
  );

  server.registerTool(
    "update_documents",
    {
      title: "Update documents",
      description:
        'Change fields on existing documents. Each update has the document\'s _id plus the fields to change, in dot notation for nested values, e.g. { "_id": "…", "system.characteristics.STR.value": 9 }. Fields you leave out stay as they are.',
      inputSchema: {
        type: z.enum(TYPES),
        updates: z.array(z.object({ _id: z.string() }).catchall(z.any())).min(1).max(50),
        parent,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ type, updates, parent }) => {
      const ack = await foundry.modify(type, "update", { updates, diff: true, ...(parent && { parentUuid: parent }) });
      return json({ updated: (ack.result ?? []).map((d: Doc) => d._id) });
    },
  );

  server.registerTool(
    "create_npc",
    {
      title: "Create a Traveller NPC",
      description:
        "Create a Mongoose Traveller 2e (mgt2e) actor from a UPP, skills and gear. Computes characteristic DMs and hits. Gear is copied by exact name from the world's items or the mgt2e item compendium.",
      inputSchema: {
        name: z.string().min(1),
        type: z.enum(["npc", "traveller"]).default("npc"),
        upp: z.string().describe('Six characteristics STR DEX END INT EDU SOC in Traveller hex, e.g. "789A87"'),
        skills: z
          .record(z.string(), z.number().int().min(0).max(15))
          .optional()
          .describe('Skill ids from the mgt2e sheet, e.g. { "broker": 2, "guncombat.slug": 1, "electronics.computers": 1 }'),
        gear: z.array(z.string()).optional().describe('Item names, e.g. ["Autopistol", "Cloth"]'),
        species: z.string().optional(),
        description: z.string().optional().describe("Markdown"),
        img: z.string().optional().describe("Portrait path or URL already reachable by Foundry"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, type, upp, skills, gear, species, description, img }) => {
      const characteristics = parseUpp(upp);
      const { system, unknownSkills } = npcSystem(
        { characteristics, skills, description: description && html(description) },
        await skillList(),
      );
      const [actor] = (await foundry.modify("Actor", "create", { data: [{ name, type, system, ...(img && { img }) }] })).result as Doc[];
      // Set by path: a whole `sophont` object would replace the system's other defaults in it.
      if (species) await foundry.modify("Actor", "update", { updates: [{ _id: actor._id, "system.sophont.species": species }], diff: true });

      const missingGear: string[] = [];
      if (gear?.length) {
        const worldItems = await foundry.get("Item");
        const packItems = await foundry.get("Item", {}, "mgt2e.base-items").catch(() => [] as Doc[]);
        const found = gear.map((wanted) => {
          const match = (d: Doc) => String(d.name).toLowerCase() === wanted.toLowerCase();
          const item = worldItems.find(match) ?? packItems.find(match);
          if (!item) missingGear.push(wanted);
          return item;
        });
        const data = found.filter(Boolean).map((i) => copyable(i!));
        if (data.length) await foundry.modify("Item", "create", { data, parentUuid: `Actor.${actor._id}` });
      }

      const created = actorView((await foundry.get("Actor", { _id: actor._id }))[0]);
      return json({
        id: created.id,
        name: created.name,
        upp: CHARACTERISTICS.map((c) => `${c} ${characteristics[c]}`).join(", "),
        items: created.items,
        ...(unknownSkills.length && { skippedUnknownSkills: unknownSkills }),
        ...(missingGear.length && { gearNotFound: missingGear }),
      });
    },
  );

  server.registerTool(
    "create_journal",
    {
      title: "Create a journal entry",
      description: "Create a journal entry with one or more text pages written in Markdown. Players can't see it until show_journal_to_players.",
      inputSchema: {
        name: z.string().min(1),
        pages: z.array(z.object({ name: z.string().min(1), markdown: z.string() })).min(1).max(50),
        folder: z.string().optional().describe("Name of an existing journal folder"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, pages, folder }) => {
      let folderId: string | undefined;
      if (folder) {
        folderId = (await foundry.get("Folder", { type: "JournalEntry" })).find((f) => f.name === folder)?._id;
        if (!folderId) throw new Error(`Journal folder "${folder}" not found`);
      }
      const data = {
        name,
        ...(folderId && { folder: folderId }),
        pages: pages.map((p, sort) => ({ name: p.name, type: "text", sort: sort * 100, text: { content: html(p.markdown), format: 1 } })),
      };
      const [entry] = (await foundry.modify("JournalEntry", "create", { data: [data] })).result as Doc[];
      return json(journalView(entry));
    },
  );

  server.registerTool(
    "show_journal_to_players",
    {
      title: "Show a journal entry to players",
      description: "Let every player read a journal entry (Observer permission) and post a chat link to it.",
      inputSchema: lookup,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const entry = await findOne(foundry, "JournalEntry", args);
      if ((entry.ownership?.default ?? 0) < OBSERVER) {
        await foundry.modify("JournalEntry", "update", { updates: [{ _id: entry._id, "ownership.default": OBSERVER }], diff: true });
      }
      await chat(`<p>@UUID[JournalEntry.${entry._id}]{${entry.name}}</p>`);
      return json({ shown: entry.name });
    },
  );

  server.registerTool(
    "set_active_scene",
    {
      title: "Activate a scene",
      description: "Make a scene the active one, which moves every player to it.",
      inputSchema: lookup,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const scene = await findOne(foundry, "Scene", args);
      // Explicitly off for the old one: not verified that the server does it for socket writes.
      const others = (await foundry.get("Scene")).filter((s) => s.active && s._id !== scene._id).map((s) => ({ _id: s._id, active: false }));
      await foundry.modify("Scene", "update", { updates: [...others, { _id: scene._id, active: true }], diff: true });
      return json(sceneView((await foundry.get("Scene", { _id: scene._id }))[0]));
    },
  );

  server.registerTool(
    "post_chat",
    {
      title: "Post to chat",
      description: "Post a chat message, in Markdown, for everyone or whispered to the GMs.",
      inputSchema: {
        markdown: z.string().min(1),
        speaker: z.string().optional().describe("Name shown as the speaker, e.g. an NPC. Defaults to Claude."),
        whisperToGm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ markdown, speaker, whisperToGm }) => {
      const message = await chat(html(markdown), { alias: speaker, whisperToGm });
      return json({ posted: message._id });
    },
  );

  server.registerTool(
    "roll",
    {
      title: "Roll dice",
      description:
        "Roll dice on the server and post the roll to chat. Traveller checks are 2d6 + DM against a difficulty (Average 8); Effect is the total minus the difficulty, and the check succeeds at Effect 0 or more.",
      inputSchema: {
        dice: z.string().default("2d6"),
        dm: z.number().int().min(-20).max(20).default(0),
        difficulty: z.number().int().min(2).max(20).optional().describe("Target number, e.g. 8 for Average"),
        label: z.string().optional().describe('What the roll is for, e.g. "Jax: Pilot check"'),
        speaker: z.string().optional(),
        whisperToGm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ dice, dm, difficulty, label, speaker, whisperToGm }) => {
      const rolled = rollDice(dice, dm);
      const effect = difficulty === undefined ? undefined : rolled.total - difficulty;
      const outcome = effect === undefined ? "" : ` vs ${difficulty}: ${effect >= 0 ? "success" : "failure"}, Effect ${effect >= 0 ? "+" : ""}${effect}`;
      const line = `${label ? `${label}: ` : ""}${rolled.formula} = ${rolled.total}${outcome}`;
      await chat(`<p>${line.replace(/</g, "&lt;")}</p>`, { alias: speaker, whisperToGm, rolls: [rolled.roll] });
      return json({ ...rolled, roll: undefined, ...(effect !== undefined && { effect, success: effect >= 0 }) });
    },
  );
}
