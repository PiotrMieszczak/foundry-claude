import { describe, expect, it } from "vitest";
import { sessionFromSetCookie } from "../src/foundry/client.js";
import { journalView, text } from "../src/foundry/views.js";

describe("sessionFromSetCookie", () => {
  it("finds the session among several cookies", () => {
    expect(sessionFromSetCookie(["foo=1; Path=/", "session=abc123; Path=/; HttpOnly"])).toBe("abc123");
  });
  it("returns undefined when there is none", () => {
    expect(sessionFromSetCookie(["mysession=x"])).toBeUndefined();
  });
});

describe("views", () => {
  it("turns page html into plain text", () => {
    expect(text("<p>Hello &amp; <b>welcome</b></p><p>Line&nbsp;2</p>")).toBe("Hello & welcome\nLine 2");
  });
  it("truncates long text", () => {
    expect(text("x".repeat(10), 4)).toBe("xxxx…");
  });
  it("keeps only text page content in journals", () => {
    const view = journalView({
      _id: "j1",
      name: "Clarke",
      pages: [
        { _id: "p1", name: "Port", type: "text", text: { content: "<p>Busy</p>" } },
        { _id: "p2", name: "Map", type: "image", src: "maps/clarke.webp" },
      ],
    });
    expect(view.pages).toEqual([
      { id: "p1", name: "Port", type: "text", text: "Busy" },
      { id: "p2", name: "Map", type: "image", src: "maps/clarke.webp" },
    ]);
  });
});
