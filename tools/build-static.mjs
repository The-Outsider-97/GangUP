// Copies the static client assets next to the compiled JavaScript (dist/js). Run after `tsc -p tsconfig.build.json`.
import { copyFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_DIR, buildManifest } from './audio-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'js', 'client', 'main.js'))) {
  console.error('dist/js/client/main.js is missing: run `tsc -p tsconfig.build.json` first');
  process.exit(1);
}
mkdirSync(dist, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(join(root, 'src', 'client', f), join(dist, f));
// sound files (see assets/audio/README.md): manifest first, then copy the folder next to the game
const audio = await buildManifest();
cpSync(AUDIO_DIR, join(dist, 'assets', 'audio'), { recursive: true, filter: (f) => !/\.md$/i.test(f) });
console.log(audio.summary);
console.log('static assets copied to dist/');
