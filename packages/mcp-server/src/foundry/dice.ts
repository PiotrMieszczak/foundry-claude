import { randomInt } from "node:crypto";

// Foundry's Roll class runs only in browsers, so dice are rolled here and serialized in the
// shape Foundry's chat log renders as a roll.

export type Rolled = { formula: string; results: number[]; total: number; roll: string };

/** Rolls "2d6", "d6" or "3d6" plus a modifier. */
export function rollDice(dice: string, modifier = 0, face = (faces: number) => randomInt(1, faces + 1)): Rolled {
  const match = /^\s*(\d*)\s*d\s*(\d+)\s*$/i.exec(dice);
  if (!match) throw new Error(`Dice "${dice}" must look like 2d6`);
  const number = Number(match[1] || 1);
  const faces = Number(match[2]);
  if (number < 1 || number > 100 || faces < 2 || faces > 1000) throw new Error(`Dice "${dice}" are out of range`);

  const results = Array.from({ length: number }, () => face(faces));
  const total = results.reduce((a, b) => a + b, 0) + modifier;
  const terms: object[] = [
    { class: "Die", options: {}, evaluated: true, number, faces, modifiers: [], results: results.map((result) => ({ result, active: true })) },
  ];
  if (modifier) {
    terms.push({ class: "OperatorTerm", options: {}, evaluated: true, operator: modifier < 0 ? "-" : "+" });
    terms.push({ class: "NumericTerm", options: {}, evaluated: true, number: Math.abs(modifier) });
  }
  const formula = `${number}d${faces}${modifier ? ` ${modifier < 0 ? "-" : "+"} ${Math.abs(modifier)}` : ""}`;
  const roll = JSON.stringify({ class: "Roll", options: {}, dice: [], formula, terms, total, evaluated: true });
  return { formula, results, total, roll };
}
