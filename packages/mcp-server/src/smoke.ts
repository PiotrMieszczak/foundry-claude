// Read-only check that the Foundry protocol still works: npm run smoke (needs the FOUNDRY_* env).
import { foundryOptions } from "./config.js";
import { FoundryClient } from "./foundry/client.js";

const foundry = new FoundryClient(foundryOptions());
try {
  const [actors, scenes, world] = await Promise.all([foundry.get("Actor"), foundry.get("Scene"), foundry.world()]);
  console.log(`world ${world.world?.id ?? "?"}: ${actors.length} actors, ${scenes.length} scenes, ${(world.packs ?? []).length} packs`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  foundry.close();
}
