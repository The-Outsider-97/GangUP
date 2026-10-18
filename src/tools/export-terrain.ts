/** Writes the (static, public) arena terrain so training logs can omit it. Usage: tsx src/tools/export-terrain.ts slai/data/terrain.json */
import { makeArena } from '../engine/arena.js';
import * as fs from 'node:fs';

const a = makeArena();
const out = {
  ref: 'arena-v1',
  width: a.width,
  height: a.height,
  obstacles: a.obstacles,
  supply: a.supply,
  zones: a.zones.map((z) => ({ x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 })),
};
fs.writeFileSync(process.argv[2] ?? 'slai/data/terrain.json', JSON.stringify(out, null, 1));
console.log('terrain exported');
