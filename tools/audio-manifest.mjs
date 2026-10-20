// Scans assets/audio, writes assets/audio/manifest.json (which file belongs to which cue) and prints what is still missing.
// Used by `npm run build` (quietly) and `npm run audio:check` (full report). Needs the compiled catalogue in dist/js.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIO_DIR = join(root, 'assets', 'audio');

export async function buildManifest({ verbose = false } = {}) {
  const catalogue = join(root, 'dist', 'js', 'client', 'audio', 'cues.js');
  if (!existsSync(catalogue)) throw new Error('dist/js/client/audio/cues.js is missing: run `tsc -p tsconfig.build.json` first');
  const { CUES, cueOfFile } = await import(pathToFileURL(catalogue).href);
  const manifest = {};
  const unknown = [];
  for (const f of existsSync(AUDIO_DIR) ? readdirSync(AUDIO_DIR).sort() : []) {
    if (f === 'manifest.json' || /\.md$/i.test(f) || f.startsWith('.')) continue;
    const cue = cueOfFile(f);
    if (cue) (manifest[cue] ??= []).push(f);
    else unknown.push(f);
  }
  writeFileSync(join(AUDIO_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const ids = Object.keys(CUES);
  const missing = (core) => ids.filter((id) => CUES[id].core === core && !manifest[id]);
  const have = Object.keys(manifest).length;
  const summary = `audio: ${have}/${ids.length} cues have files (${missing(true).length} of your requested cues and ${missing(false).length} extras still silent)`;
  if (!verbose) return { summary, manifest, unknown };
  const lines = [summary, ''];
  const groups = [...new Set(ids.map((id) => CUES[id].group))];
  for (const g of groups) {
    lines.push(`${g}`);
    for (const id of ids.filter((x) => CUES[x].group === g)) {
      const n = manifest[id]?.length ?? 0;
      lines.push(`  ${n ? '[x]' : '[ ]'} ${id.padEnd(20)} ${CUES[id].core ? 'requested' : 'extra    '}  ${n ? `${n} file${n > 1 ? 's' : ''}` : 'no file'}  - ${CUES[id].desc}`);
    }
  }
  if (unknown.length) lines.push('', 'Files that match no cue (check the spelling):', ...unknown.map((f) => '  ' + f));
  return { summary: lines.join('\n'), manifest, unknown };
}

if (process.argv[1] && process.argv[1].endsWith('audio-manifest.mjs')) {
  buildManifest({ verbose: true }).then((r) => console.log(r.summary)).catch((e) => { console.error(e.message); process.exit(1); });
}
