import type { Doc } from "./client.js";

// Raw Foundry documents are large; tools return these trimmed views instead.

export function text(html: unknown, max = 4000): string {
  const plain = String(html ?? "")
    .replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

export const summary = (type: string, d: Doc) => ({ type, id: d._id, name: d.name, ...(d.type && { subtype: d.type }) });

export function actorView(a: Doc) {
  return {
    id: a._id,
    name: a.name,
    type: a.type,
    img: a.img,
    // shortcut: system data is passed through as-is, map mgt2e fields once the NPC card needs them
    system: a.system,
    items: (a.items ?? []).map((i: Doc) => ({ id: i._id, name: i.name, type: i.type })),
  };
}

export function sceneView(s: Doc) {
  return {
    id: s._id,
    name: s.name,
    active: s.active,
    thumb: s.thumb,
    background: s.background?.src ?? s.img,
    size: { width: s.width, height: s.height },
    tokens: (s.tokens ?? []).map((t: Doc) => ({ name: t.name, actorId: t.actorId, hidden: t.hidden })),
    notes: (s.notes ?? []).length,
  };
}

export function journalView(j: Doc) {
  return {
    id: j._id,
    name: j.name,
    pages: (j.pages ?? []).map((p: Doc) => ({
      id: p._id,
      name: p.name,
      type: p.type,
      ...(p.type === "text" && { text: text(p.text?.content) }),
      ...(p.src && { src: p.src }),
    })),
  };
}
