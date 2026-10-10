// Static checks of the front-end in web/ (no browser, no server):
//  - index.html loads only same-origin resources; viewport meta with viewport-fit=cover; CSP; landmarks
//  - CSS defines the four RCL brand tokens and the mobile/accessibility basics
//  - the supplied RCL Convergence SVGs are unmodified (pinned SHA-256 of the evidence packet copies)
//  - the copper-and-steel logo rasters are present, correctly sized for their 1x/2x/3x use, small, and documented
//  - DATA TRUTH: no literal tickers, dollar amounts or hard-coded quote objects in web/ code
//  - every module parses and every relative import resolves to a real export
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { largeCapList, BENCHMARKS, KNOWN_TEST_SYMBOLS } from '../../server/data/universe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const web = path.join(root, 'web');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
const allFiles = walk(web);
const jsFiles = allFiles.filter((f) => f.endsWith('.js'));
const indexHtml = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(web, 'styles.css'), 'utf8');
const codeFiles = [...jsFiles, path.join(web, 'index.html'), path.join(web, 'styles.css')];
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('index.html references only local resources', () => {
  // a srcset holds several "url descriptor" candidates; check each candidate URL on its own
  const refs = [...indexHtml.matchAll(/\b(src|href|srcset|poster|data)\s*=\s*"([^"]*)"/gi)]
    .flatMap((m) => (m[1].toLowerCase() === 'srcset' ? m[2].split(',').map((c) => c.trim().split(/\s+/)[0]) : [m[2]]));
  assert.ok(refs.length >= 5, 'expected several resource references');
  for (const r of refs) {
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(r), `external reference in index.html: ${r}`);
    assert.ok(!/^(?:javascript|data):/i.test(r), `inline-scheme reference in index.html: ${r}`);
  }
  // every local src/href (other than in-page anchors) must exist on disk
  for (const r of refs.filter((x) => !x.startsWith('#'))) {
    assert.ok(fs.existsSync(path.join(web, r.split(/[?#]/)[0])), `index.html references missing file: ${r}`);
  }
  assert.ok(!/<link[^>]+rel="?(preconnect|dns-prefetch)/i.test(indexHtml), 'no preconnect to third parties');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(indexHtml), 'no inline scripts (CSP script-src self)');
  assert.ok(!/\sstyle\s*=/i.test(indexHtml), 'no inline style attributes (CSP style-src self)');
});

test('index.html has viewport-fit=cover, a same-origin CSP, language and landmarks', () => {
  const vp = indexHtml.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
  assert.ok(vp, 'viewport meta present');
  assert.match(vp[1], /width=device-width/);
  assert.match(vp[1], /viewport-fit=cover/);
  assert.doesNotMatch(vp[1], /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\D|$)/, 'zoom must not be disabled');
  const csp = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(csp, 'CSP meta present');
  assert.match(csp[1], /default-src 'self'/);
  assert.match(csp[1], /connect-src 'self'/);
  assert.doesNotMatch(csp[1], /https?:|\*/, 'CSP allows no external origins');
  assert.match(indexHtml, /<html lang="en">/);
  assert.match(indexHtml, /<main id="main"/);
  assert.equal((indexHtml.match(/<nav\b/g) || []).length, 2, 'sidebar nav + phone tab bar');
  assert.match(indexHtml, /aria-live="polite"/);
  for (const tab of ['overview', 'research', 'lab', 'journal', 'more']) assert.match(indexHtml, new RegExp(`data-tab="${tab}"`), `phone tab ${tab}`);
  assert.match(indexHtml, /Recursive Chaos Labs/);
  assert.match(indexHtml, /Refining Chaos Into Clarity\./);
  assert.match(indexHtml, />VECTOR</);
});

test('CSS defines the four RCL brand tokens and mobile/accessibility basics', () => {
  const tok = (name, hex) => assert.match(css, new RegExp(`--${name}\\s*:\\s*${hex}\\s*;`, 'i'), `--${name}: ${hex}`);
  tok('obsidian', '#0B0B0B');
  tok('copper', '#B87333');
  tok('steel', '#A7A7A7');
  tok('bone', '#F5F3EE');
  assert.match(css, /body\s*\{[^}]*font:\s*16px/, 'body text 16px');
  assert.match(css, /select, textarea\s*\{[^}]*font:\s*16px/, 'form controls 16px (no iOS zoom)');
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  const tabH = Number((css.match(/--tabbar-h:\s*(\d+)px/) || [])[1]);
  assert.ok(tabH >= 44, `tab bar height ${tabH}px >= 44px`);
  assert.ok(!/@import|url\(\s*['"]?(?:https?:)?\/\//i.test(css), 'no external CSS imports or URLs');
  assert.ok(!/@font-face/i.test(css), 'system font stacks only');
});

test('supplied RCL Convergence SVGs are present and unmodified', () => {
  // SHA-256 of the evidence packet copies (vector_shared/brand-reference), pinned so this check cannot silently skip when the
  // packet folder is not beside the repo. If a packet folder is available it is also compared byte for byte.
  const pinned = {
    'RCL_Convergence_Full_Dark.svg': 'dbd5d590549140121fd99d9abce585f8c287448362cce7f391dd7046b7971465',
    'RCL_Convergence_Full_Light.svg': '55f455e77cda16635c112cbe833a83f7423c76b4cd27443b741f31e3fb2a5207',
    'RCL_Convergence_Mark_Dark.svg': 'abc341bceffc1a48c5df10014f2edb5f3f6d3a39ba81d19c9b44d51292b2a855',
    'RCL_Convergence_Mark_Light.svg': '2932c8b89c428d9117d7a0b022b42c6863dd98928098e4890e1d55e6e88b3f59',
  };
  const packets = [process.env.VECTOR_BRAND_PACKET, path.resolve(root, '..', 'vector_shared', 'brand-reference')].filter(Boolean);
  for (const [name, want] of Object.entries(pinned)) {
    const mine = path.join(web, 'assets', name);
    assert.ok(fs.existsSync(mine), `${name} present`);
    const bytes = fs.readFileSync(mine);
    assert.equal(sha256(bytes), want, `${name} matches the evidence packet SHA-256`);
    for (const p of packets) {
      if (fs.existsSync(path.join(p, name))) assert.ok(bytes.equals(fs.readFileSync(path.join(p, name))), `${name} is byte-identical to ${p}`);
    }
  }
});

test('RCL copper-and-steel logo rasters: present, sized for 1x/2x/3x, small and documented', () => {
  // Owner-approved logo correction (docs/RCL-Logo-Source.md): header, sidebar, More and favicon show the mark crop and About
  // shows the full lockup, as PNG crops of the brand board (backlog E11 replaced the 2.6 MB SVG wrappers).
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngSize = (ref, where) => {
    const f = path.join(web, ref);
    assert.ok(/^assets\/RCL_Copper_Steel_[A-Za-z0-9_]+\.png$/.test(ref) && fs.existsSync(f), `${where}: ${ref} exists in web/assets`);
    const b = fs.readFileSync(f);
    assert.ok(b.subarray(0, 8).equals(PNG_SIG), `${ref} is a PNG`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  const attr = (tag, k) => (tag.match(new RegExp(`\\b${k}\\s*[=:]\\s*["']([^"']*)["']`)) || [])[1];
  // every <img> showing an RCL asset: index.html markup and h('img', {...}) calls in the views
  const imgs = [
    ...[...indexHtml.matchAll(/<img\b[^>]*>/g)].map((m) => ({ where: 'index.html', tag: m[0] })),
    ...jsFiles.flatMap((f) => [...read(f).matchAll(/h\('img',\s*\{[^}]*\}/g)].map((m) => ({ where: rel(f), tag: m[0] }))),
  ].filter((i) => /assets\/RCL_/.test(i.tag));
  assert.ok(imgs.some((i) => i.where === 'index.html' && /_Mark_/.test(attr(i.tag, 'src'))), 'index.html shows the RCL mark');
  assert.ok(imgs.some((i) => i.where.endsWith('views/more.js') && /_Mark_/.test(attr(i.tag, 'src'))), 'More view shows the RCL mark');
  assert.ok(imgs.some((i) => i.where.endsWith('views/about.js') && /_Full_/.test(attr(i.tag, 'src'))), 'About shows the full RCL lockup');
  for (const { where, tag } of imgs) {
    const w = Number(attr(tag, 'width')), hgt = Number(attr(tag, 'height'));
    assert.ok(w > 0 && hgt > 0, `${where}: RCL img keeps width/height attributes`);
    assert.ok((attr(tag, 'alt') || '').includes('Recursive Chaos Labs'), `${where}: RCL img keeps its alt text`);
    // the 1x file has exactly the rendered CSS size, so the crop's aspect ratio is preserved and nothing is upscaled
    assert.deepEqual(pngSize(attr(tag, 'src'), where), [w, hgt], `${where}: ${attr(tag, 'src')} is ${w}x${hgt}`);
    const srcset = attr(tag, 'srcset');
    if (!srcset) continue;
    for (const cand of srcset.split(',')) {
      const [ref, d = '1x'] = cand.trim().split(/\s+/);
      const x = Number(d.replace(/x$/, ''));
      assert.ok(x >= 1, `${where}: density descriptor ${d}`);
      assert.deepEqual(pngSize(ref, where), [w * x, hgt * x], `${where}: ${ref} is ${w * x}x${hgt * x} for ${d}`);
    }
  }
  // favicon: same-origin PNG(s) whose declared sizes match the file
  const icons = [...indexHtml.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map((m) => m[0]);
  assert.ok(icons.length >= 1, 'index.html declares an RCL favicon');
  for (const tag of icons) {
    assert.equal(attr(tag, 'type'), 'image/png', 'favicon is a PNG');
    const [n, m] = (attr(tag, 'sizes') || '').split('x').map(Number);
    assert.deepEqual(pngSize(attr(tag, 'href'), 'favicon'), [n, m], `favicon ${attr(tag, 'href')} matches sizes="${attr(tag, 'sizes')}"`);
  }
  // the retired multi-MB SVG wrappers are gone; every RCL copper-and-steel file is small and listed (with SHA-256) in the doc
  for (const f of codeFiles) assert.doesNotMatch(read(f), /RCL_Copper_Steel_(?:Mark|Full)\.svg/, `${rel(f)} references a retired SVG`);
  const doc = read(path.join(root, 'docs', 'RCL-Logo-Source.md'));
  const rasters = fs.readdirSync(path.join(web, 'assets')).filter((n) => n.startsWith('RCL_Copper_Steel_'));
  assert.ok(rasters.length >= 2, 'copper-and-steel rasters present');
  for (const n of rasters) {
    const b = fs.readFileSync(path.join(web, 'assets', n));
    assert.ok(b.length <= 512 * 1024, `${n} is ${b.length} bytes (<= 512 KiB)`);
    assert.ok(doc.includes(n) && doc.includes(sha256(b)), `${n} and its SHA-256 are recorded in docs/RCL-Logo-Source.md`);
  }
});

test('DATA TRUTH: no literal tickers in web/ code', () => {
  const syms = [...new Set([...largeCapList(), ...BENCHMARKS, ...KNOWN_TEST_SYMBOLS])];
  for (const f of codeFiles) {
    const src = read(f);
    for (const sym of syms) {
      const quoted = new RegExp(`(['"\`])${sym.replace('.', '\\.')}\\1`);
      const cashtag = new RegExp(`\\$${sym}\\b`);
      assert.ok(!quoted.test(src), `${rel(f)} contains quoted ticker literal ${sym}`);
      assert.ok(!cashtag.test(src), `${rel(f)} contains cashtag ${sym}`);
    }
  }
});

test('DATA TRUTH: no hard-coded dollar amounts or quote objects in web/ code', () => {
  for (const f of codeFiles) {
    const src = read(f);
    const dollars = src.match(/\$\s?\d[\d,]*(?:\.\d+)?/g);
    assert.equal(dollars, null, `${rel(f)} contains dollar literal(s): ${dollars}`);
    const quoteObj = src.match(/\b(?:bid|ask|priceU|retPct|last_price|close|bidSize|askSize|mid)\s*:\s*-?\d/g);
    assert.equal(quoteObj, null, `${rel(f)} contains a hard-coded market field: ${quoteObj}`);
    const symField = src.match(/\bsym\s*:\s*['"`][A-Z]/g);
    assert.equal(symField, null, `${rel(f)} contains a hard-coded symbol field: ${symField}`);
  }
});

test('web/ never imports from test/ or remote origins; external URLs are documentation links only', () => {
  const allowedUrls = new Set(['https://www.iex.io/legal/hist-data-terms']);
  for (const f of jsFiles) {
    const src = read(f);
    for (const m of src.matchAll(/(?:import\s[^'"]*from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../'), `${rel(f)} non-relative import ${m[1]}`);
      assert.ok(!/(^|\/)test\//.test(path.relative(web, path.resolve(path.dirname(f), m[1])).replace(/\\/g, '/')) && !path.resolve(path.dirname(f), m[1]).startsWith(path.join(root, 'test')), `${rel(f)} imports from test/`);
      assert.ok(path.resolve(path.dirname(f), m[1]).startsWith(web), `${rel(f)} imports outside web/: ${m[1]}`);
    }
    for (const u of src.match(/https?:\/\/[^\s'"`)]+/g) || []) {
      if (/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(u)) continue; // documented local model endpoint example (text only)
      if (u === 'http://www.w3.org/2000/svg') continue; // SVG namespace, not a request
      assert.ok(allowedUrls.has(u), `${rel(f)} unexpected URL ${u}`);
    }
    assert.ok(!/\bnew\s+(WebSocket|EventSource)\s*\(/.test(src), `${rel(f)} opens a socket`);
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), `${rel(f)} writes raw HTML`);
  }
  const fetchers = jsFiles.filter((f) => /\bfetch\s*\(/.test(read(f)));
  assert.deepEqual(fetchers.map(rel), ['web/js/api.js'], 'only api.js calls fetch');
  assert.match(read(path.join(web, 'js', 'api.js')), /path\.startsWith\('\/api\/'\)/, 'api.js only requests same-origin /api/ paths');
});

test('mutations send the required headers', () => {
  const src = read(path.join(web, 'js', 'api.js'));
  assert.match(src, /'Content-Type': 'application\/json'/);
  assert.match(src, /'X-Vector-Client': 'web'/);
});

test('every web module parses and every named import resolves to an export', () => {
  const exportsOf = (f) => new Set([...read(f).matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]));
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel(f)} syntax error: ${r.stderr}`);
    for (const m of read(f).matchAll(/import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+)\s+from\s+'([^']+)'/g)) {
      const target = path.resolve(path.dirname(f), m[2]);
      assert.ok(fs.existsSync(target), `${rel(f)} imports missing ${m[2]}`);
      if (m[1]) {
        const ex = exportsOf(target);
        for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          assert.ok(ex.has(name), `${rel(f)} imports ${name} which ${m[2]} does not export`);
        }
      }
    }
  }
});

test('required status vocabulary and labels appear in the UI code', () => {
  const all = jsFiles.map(read).join('\n');
  for (const s of ['NO_VERIFIED_DATA', 'UNAVAILABLE_NOT_VERIFIED', 'NO_VERIFIED_OPTIONS_DATA', 'MODEL DISCONNECTED / ASSESSMENT NOT RUN',
    'SIGNAL METRICS — NOT RECOMMENDATIONS', 'ESTIMATED PAPER FILL', 'EXPLORATORY DEFAULTS — NOT VALIDATED', 'PAPER ONLY — NO LIVE TRADING',
    'RETROSPECTIVE — uses data after each signal; never visible to agents', 'IMPORTED_UNVERIFIED', 'SEC_USER_AGENT', 'VECTOR_MODEL_PROVIDER']) {
    assert.ok(all.includes(s), `UI code mentions ${s}`);
  }
  for (const route of ['overview', 'research', 'lab', 'agents', 'replay', 'journal', 'sources', 'about', 'more']) {
    assert.ok(fs.existsSync(path.join(web, 'js', 'views', `${route}.js`)), `view module for #/${route}`);
  }
});
