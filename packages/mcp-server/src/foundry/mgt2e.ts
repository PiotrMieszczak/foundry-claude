// Mongoose Traveller 2e (system "mgt2e") helpers. The system's sheet code doesn't run for socket
// writes, so values it would derive (characteristic DMs, hits) are computed here.

export const CHARACTERISTICS = ["STR", "DEX", "END", "INT", "EDU", "SOC"] as const;
type Characteristic = (typeof CHARACTERISTICS)[number];

// Traveller extended hex: 0-9, then A-Z without I and O.
const EHEX = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The characteristic DM from the core rules table. */
export function dm(value: number): number {
  if (value <= 0) return -3;
  if (value <= 2) return -2;
  if (value <= 5) return -1;
  if (value <= 8) return 0;
  if (value <= 11) return 1;
  if (value <= 14) return 2;
  return 3;
}

/** "789A87" → { STR: 7, DEX: 8, END: 9, INT: 10, EDU: 8, SOC: 7 } */
export function parseUpp(upp: string): Record<Characteristic, number> {
  const digits = upp.replace(/[\s-]/g, "").toUpperCase();
  if (digits.length !== 6) throw new Error(`UPP "${upp}" must have 6 digits`);
  return Object.fromEntries(
    CHARACTERISTICS.map((c, i) => {
      const value = EHEX.indexOf(digits[i]);
      if (value < 0) throw new Error(`UPP "${upp}" has an invalid digit "${digits[i]}"`);
      return [c, value];
    }),
  ) as Record<Characteristic, number>;
}

// MGT2.CHARACTERISTICS from the system's helpers/config.mjs.
const DEFAULT_CHARACTERISTICS: Record<string, { value: number; show: boolean }> = {
  STR: { value: 7, show: true }, DEX: { value: 7, show: true }, END: { value: 7, show: true },
  INT: { value: 7, show: true }, EDU: { value: 7, show: true }, SOC: { value: 7, show: true },
  CHA: { value: 7, show: false }, TER: { value: 0, show: false }, PSI: { value: 0, show: false },
  WLT: { value: 7, show: false }, LCK: { value: 7, show: false }, MRL: { value: 7, show: false },
  STY: { value: 7, show: false }, RES: { value: 7, show: false }, FOL: { value: 0, show: false },
  REP: { value: 0, show: false },
};

export type NpcInput = {
  characteristics: Record<Characteristic, number>;
  /** "broker": 2, or "electronics.computers": 1 for a speciality */
  skills?: Record<string, number>;
  description?: string;
};

/**
 * A complete mgt2e `system` for a new actor. It must be complete: the system's createActor hook,
 * in any open GM browser, fills in missing characteristics and skills by overwriting whole objects.
 * `skillList` is any mgt2e actor's skills; levels are reset to 0. Skills not in it are skipped and
 * returned, so a typo doesn't create a stray key.
 */
export function npcSystem(input: NpcInput, skillList: Record<string, any>) {
  const characteristics = Object.fromEntries(
    Object.entries(DEFAULT_CHARACTERISTICS).map(([c, d]) => {
      const value = input.characteristics[c as Characteristic] ?? d.value;
      return [c, { value, current: value, show: d.show, default: false, dm: dm(value) }];
    }),
  );
  const skills: Record<string, any> = structuredClone(skillList);
  for (const skill of Object.values(skills)) {
    skill.value = 0;
    if ("trained" in skill) skill.trained = false;
    for (const speciality of Object.values<any>(skill.specialities ?? {})) speciality.value = 0;
  }

  const unknownSkills: string[] = [];
  for (const [key, level] of Object.entries(input.skills ?? {})) {
    const [id, speciality] = key.split(".");
    const skill = skills[id];
    if (!skill || (speciality && !skill.specialities?.[speciality])) {
      unknownSkills.push(key);
      continue;
    }
    skill.trained = true;
    if (speciality) skill.specialities[speciality].value = level;
    else skill.value = level;
  }

  const hits = input.characteristics.STR + input.characteristics.DEX + input.characteristics.END;
  const system = {
    characteristics,
    skills,
    hits: { value: hits, max: hits, damage: 0, tmpDamage: 0 },
    ...(input.description && { description: input.description }),
  };
  return { system, unknownSkills };
}
