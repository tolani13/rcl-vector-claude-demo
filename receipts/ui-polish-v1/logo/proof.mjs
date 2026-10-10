// E11 visual-identity proof: render the retired SVG crops and the new rasters at identical CSS sizes in headless
// Chrome (file://, no server), then measure PSNR/SSIM per logo region with ffmpeg and save side-by-side PNGs.
// Usage (repo root): node receipts/ui-polish-v1/logo/proof.mjs <scratch-dir-for-chrome-profile>
// Needs: git (old SVGs are materialised from commit 3d749b2 into ./old/ and removed afterwards), Chrome, ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const scratch = path.resolve(process.argv[2] || path.join(here, '.tmp'));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OLD_COMMIT = '3d749b2';
const OLD = {
  'RCL_Copper_Steel_Mark.svg': 'dc6dff66975563130fc95ed767ca7c15d86e421158571bec1a1df941a3744dc9',
  'RCL_Copper_Steel_Full.svg': 'd68a606c3e9d3a6167f0d166230636471d62eb774bc9883646f94439e7aabaa6',
};
const BOARD_SHA256 = 'eafec047fbb081eaf63e9c967fa6473ca8d66a3f507e8d0bdf2a496ae52a9adb';
const W = 1302, H = 590; // CSS px; must contain every region in proof.css
const REGIONS = { // CSS px, from proof.css
  mark32: [16, 16, 32, 32],
  mark40: [64, 16, 40, 40],
  full814: [16, 72, 814, 502],
  full440: [846, 72, 440, 271], // 440 x 271.35 rendered; the partial last row is excluded
};
const DPRS = [1, 2, 3];
const PAGES = ['old', 'new', 'new-webp', 'control'];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000, ...opts });
  if (r.error) throw r.error;
  return r;
};

// 1. materialise the old SVGs from git and check they are the retired files
const oldDir = path.join(here, 'old');
fs.mkdirSync(oldDir, { recursive: true });
for (const [name, want] of Object.entries(OLD)) {
  const r = spawnSync('git', ['show', `${OLD_COMMIT}:web/assets/${name}`], { cwd: root, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`git show failed for ${name}`);
  if (sha(r.stdout) !== want) throw new Error(`${name} from ${OLD_COMMIT} has unexpected SHA-256`);
  fs.writeFileSync(path.join(oldDir, name), r.stdout);
}
// control input: the PNG embedded in the old mark SVG (must be the unmodified brand board), cropped to its viewBox
const svg = fs.readFileSync(path.join(oldDir, 'RCL_Copper_Steel_Mark.svg'), 'latin1');
const b64 = svg.slice(svg.indexOf('base64,') + 7, svg.indexOf('"', svg.indexOf('base64,')));
const board = Buffer.from(b64, 'base64');
if (sha(board) !== BOARD_SHA256) throw new Error('embedded brand board PNG has unexpected SHA-256');
fs.writeFileSync(path.join(oldDir, 'board.png'), board);
const viewBox = svg.match(/viewBox="(\d+) (\d+) (\d+) (\d+)"/).slice(1).map(Number); // 210 12 350 350
const cr = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(oldDir, 'board.png'), '-vf',
  `crop=${viewBox[2]}:${viewBox[3]}:${viewBox[0]}:${viewBox[1]}`, '-frames:v', '1', path.join(oldDir, 'mark_native_350.png')]);
if (cr.status !== 0) throw new Error(cr.stderr);

// 2. screenshots
const shotDir = path.join(scratch, 'shots');
fs.mkdirSync(shotDir, { recursive: true });
const profile = path.join(scratch, 'chrome-profile');
const shots = {};
for (const page of PAGES) for (const dpr of DPRS) {
  const out = path.join(shotDir, `${page}-dpr${dpr}.png`);
  fs.rmSync(out, { force: true });
  run(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--force-color-profile=srgb', `--user-data-dir=${path.join(profile, `${page}-${dpr}`)}`, `--force-device-scale-factor=${dpr}`,
    `--window-size=${W},${H}`, '--virtual-time-budget=5000', `--screenshot=${out}`, pathToFileURL(path.join(here, `${page}.html`)).href]);
  if (!fs.existsSync(out)) throw new Error(`no screenshot for ${page} @${dpr}x`);
  const png = fs.readFileSync(out);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (w !== W * dpr || h !== H * dpr) throw new Error(`${page} @${dpr}x is ${w}x${h}, expected ${W * dpr}x${H * dpr}`);
  shots[`${page}@${dpr}`] = out;
}

// 3. per-region PSNR / SSIM (RGB) of each candidate page against old.html
const crop = ([x, y, w, h], dpr) => `crop=${w * dpr}:${h * dpr}:${x * dpr}:${y * dpr}`;
function metric(a, b, region, dpr, kind) {
  const f = `[0]${crop(region, dpr)},format=rgb24[a];[1]${crop(region, dpr)},format=rgb24[b];[a][b]${kind}`;
  const r = run('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', f, '-f', 'null', '-']);
  const m = kind === 'psnr' ? r.stderr.match(/average:(\S+)/) : r.stderr.match(/All:(\S+)/);
  if (!m) throw new Error(`no ${kind} for ${region} @${dpr}x:\n${r.stderr.slice(-800)}`);
  return m[1] === 'inf' ? 'inf' : Number(m[1]);
}
const results = [];
for (const cand of ['new', 'new-webp', 'control']) for (const dpr of DPRS) for (const [name, region] of Object.entries(REGIONS)) {
  results.push({ candidate: cand, dpr, region: name, cssBox: region,
    psnr_dB: metric(shots[`old@${dpr}`], shots[`${cand}@${dpr}`], region, dpr, 'psnr'),
    ssim: metric(shots[`old@${dpr}`], shots[`${cand}@${dpr}`], region, dpr, 'ssim') });
}

// 4. side-by-side PNGs: old | new | |old-new| x8  (native pixels, no rescaling)
function sideBySide(regionNames, dpr, outName, cand = 'new') {
  const inputs = ['-i', shots[`old@${dpr}`], '-i', shots[`${cand}@${dpr}`]];
  const parts = []; const rows = [];
  regionNames.forEach((n, i) => {
    const c = crop(REGIONS[n], dpr);
    parts.push(`[0]${c},format=rgb24,split[o${i}][od${i}]`, `[1]${c},format=rgb24,split[n${i}][nd${i}]`,
      `[od${i}][nd${i}]blend=all_mode=difference,lutrgb=r='min(val*8,255)':g='min(val*8,255)':b='min(val*8,255)'[d${i}]`,
      `[o${i}][n${i}][d${i}]hstack=3${regionNames.length > 1 ? `[r${i}]` : ''}`);
    rows.push(`[r${i}]`);
  });
  const graph = parts.join(';') + (rows.length > 1 ? `;${rows.join('')}vstack=${rows.length}` : '');
  const out = path.join(here, outName);
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-frames:v', '1', out]);
  if (r.status !== 0) throw new Error(r.stderr);
  return path.relative(root, out).replace(/\\/g, '/');
}
const sides = [];
for (const dpr of DPRS) sides.push(sideBySide(['mark32'], dpr, `side-by-side-mark32-dpr${dpr}.png`), sideBySide(['mark40'], dpr, `side-by-side-mark40-dpr${dpr}.png`));
sides.push(sideBySide(['full814'], 1, 'side-by-side-full814-dpr1.png'), sideBySide(['full440'], 2, 'side-by-side-full440-dpr2.png'),
  sideBySide(['full814'], 1, 'side-by-side-full814-webp-candidate-dpr1.png', 'new-webp'));

// 5. bytes before / after
const assets = path.join(root, 'web', 'assets');
const after = fs.readdirSync(assets).filter((f) => /^RCL_Copper_Steel_.*\.(png|webp|jpe?g)$/.test(f)).sort()
  .map((f) => ({ file: f, bytes: fs.statSync(path.join(assets, f)).size, sha256: sha(fs.readFileSync(path.join(assets, f))) }));
const before = Object.keys(OLD).map((f) => ({ file: f, bytes: fs.statSync(path.join(oldDir, f)).size }));
const sum = (a) => a.reduce((s, x) => s + x.bytes, 0);
const chromeVer = run('powershell', ['-NoProfile', '-Command', `(Get-Item '${CHROME}').VersionInfo.ProductVersion`]).stdout.trim();
const ffVer = run('ffmpeg', ['-hide_banner', '-version']).stdout.split('\n')[0];
const report = { generated: new Date().toISOString(), chrome: chromeVer, ffmpeg: ffVer, windowCss: [W, H], dprs: DPRS,
  method: 'headless Chrome --force-color-profile=srgb screenshots (fresh profile per shot) of old.html (retired SVGs) vs new.html (shipped markup, PNG everywhere), new-webp.html (NOT shipped: WebP lockup candidate, blocked by the server static allow-list) and control.html (native-resolution viewBox crops scaled only by Chrome); ffmpeg psnr/ssim on rgb24 crops of each logo region',
  results, sideBySide: sides, bytesBefore: { files: before, total: sum(before) }, bytesAfter: { files: after, total: sum(after) } };
fs.writeFileSync(path.join(here, 'proof-results.json'), JSON.stringify(report, null, 2) + '\n');

// 6. clean up the materialised old SVGs and the Chrome profile
fs.rmSync(oldDir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });

const fmt = (v) => (v === 'inf' ? 'inf' : v.toFixed(v > 1 ? 2 : 4));
console.log(`Chrome ${chromeVer}; ${ffVer}`);
console.log('candidate  dpr region   PSNR(dB)  SSIM');
for (const r of results) console.log(`${r.candidate.padEnd(9)} ${String(r.dpr).padStart(3)}x ${r.region.padEnd(8)} ${fmt(r.psnr_dB).padStart(8)}  ${fmt(r.ssim)}`);
console.log(`bytes before ${sum(before)} (${before.map((b) => `${b.file} ${b.bytes}`).join(', ')})`);
console.log(`bytes after  ${sum(after)} (${after.map((b) => `${b.file} ${b.bytes}`).join(', ')})`);
