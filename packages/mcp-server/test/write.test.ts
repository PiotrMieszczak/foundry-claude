import { describe, expect, it } from "vitest";
import { rollDice } from "../src/foundry/dice.js";
import { dm, npcSystem, parseUpp } from "../src/foundry/mgt2e.js";

describe("mgt2e", () => {
  it("maps characteristics to DMs", () => {
    expect([0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15].map(dm)).toEqual([-3, -2, -2, -1, -1, 0, 0, 1, 1, 2, 2, 3]);
  });
  it("parses a UPP in Traveller hex", () => {
    expect(parseUpp("789A8C")).toEqual({ STR: 7, DEX: 8, END: 9, INT: 10, EDU: 8, SOC: 12 });
    expect(() => parseUpp("789A8")).toThrow();
    expect(() => parseUpp("789I87")).toThrow();
  });
  it("builds a complete system and skips unknown skills", () => {
    const list = {
      broker: { id: "broker", value: "2", trained: true },
      electronics: { id: "electronics", value: 0, trained: false, specialities: { computers: { id: "computers", value: "1" } } },
    };
    const { system, unknownSkills } = npcSystem(
      { characteristics: parseUpp("569888"), skills: { "electronics.computers": 1, pilto: 1, "electronics.radar": 1 } },
      list,
    );
    expect(system.characteristics.STR).toEqual({ value: 5, current: 5, show: true, default: false, dm: -1 });
    expect(system.characteristics.TER).toMatchObject({ value: 0, show: false, dm: -3 });
    expect(Object.keys(system.characteristics)).toHaveLength(16);
    expect(system.hits).toMatchObject({ value: 20, max: 20 });
    expect(system.skills.broker).toMatchObject({ value: 0, trained: false });
    expect(system.skills.electronics).toMatchObject({ trained: true, specialities: { computers: { value: 1 } } });
    expect(list.broker.value).toBe("2");
    expect(unknownSkills).toEqual(["pilto", "electronics.radar"]);
  });
});

describe("rollDice", () => {
  it("rolls with a modifier and serializes a Foundry roll", () => {
    const r = rollDice("2d6", -1, () => 4);
    expect(r).toMatchObject({ formula: "2d6 - 1", results: [4, 4], total: 7 });
    const roll = JSON.parse(r.roll);
    expect(roll).toMatchObject({ class: "Roll", total: 7, evaluated: true });
    expect(roll.terms.map((t: { class: string }) => t.class)).toEqual(["Die", "OperatorTerm", "NumericTerm"]);
  });
  it("keeps rolls in range", () => {
    for (let i = 0; i < 200; i++) expect(rollDice("d6").total).toBeGreaterThanOrEqual(1);
    expect(() => rollDice("2x6")).toThrow();
  });
});
