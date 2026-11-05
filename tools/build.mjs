#!/usr/bin/env node
/* tools/build.mjs — 把 src/ + vendor/ 打包成单文件 HTML（无依赖）
 *
 *   node tools/build.mjs
 *   node tools/build.mjs --src src/index.html --out 五级台生成器.html
 *
 * 源 HTML 需保留两个占位符：
 *   <!--INLINE_VENDOR-->   three.min.js + OrbitControls.js
 *   <!--INLINE_APP-->      src/app/*.js 按文件名排序合并
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULTS = {
  src: join(ROOT, 'src', 'index.html'),
  out: join(ROOT, '五级台生成器.html'),
  'app-dir': join(ROOT, 'src', 'app'),
  'vendor-dir': join(ROOT, 'vendor'),
  vendor: true,
  mirror: null
};
const VENDOR_SCRIPTS = ['three.min.js', 'OrbitControls.js'];
const P_VENDOR = '<!--INLINE_VENDOR-->';
const P_APP = '<!--INLINE_APP-->';

function fail(msg) { console.error('\nBUILD FAILED: ' + msg + '\n'); process.exit(1); }
function rel(p) { try { return relative(process.cwd(), p) || p; } catch { return p; } }

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail('option ' + a + ' requires a value');
      return v;
    };
    switch (a) {
      case '--src': o.src = resolve(next()); break;
      case '--out': o.out = resolve(next()); break;
      case '--app-dir': o['app-dir'] = resolve(next()); break;
      case '--vendor-dir': o['vendor-dir'] = resolve(next()); break;
      case '--mirror': o.mirror = resolve(next()); break;
      case '--no-vendor': o.vendor = false; break;
      case '-h': case '--help':
        console.log('Usage: node tools/build.mjs [--src file] [--out file] [--app-dir dir] [--vendor-dir dir] [--no-vendor] [--mirror file]');
        process.exit(0); break;
      default: fail('unknown option: ' + a);
    }
  }
  return o;
}

function escapeInline(js) { return js.replace(/<\/script/gi, '<\\/script'); }

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  console.log('five-stage-gen — single-file build');
  if (!existsSync(o.src)) fail('source HTML not found: ' + rel(o.src));
  let html = await readFile(o.src, 'utf8');
  if (!html.includes(P_VENDOR) || !html.includes(P_APP)) fail('placeholders missing in ' + rel(o.src));

  let vendorHtml = '<!-- vendor disabled -->';
  const vendorUsed = [];
  if (o.vendor) {
    const blocks = [];
    for (const name of VENDOR_SCRIPTS) {
      const f = join(o['vendor-dir'], name);
      if (!existsSync(f)) fail('vendor missing: ' + rel(f));
      const src = await readFile(f, 'utf8');
      if (!src.trim()) fail('vendor empty: ' + rel(f));
      blocks.push('<!-- vendor: ' + name + ' (' + Buffer.byteLength(src) + ' bytes) -->\n<script data-vendor="' +
        name + '">\n' + escapeInline(src) + '\n</script>');
      vendorUsed.push({ name, bytes: Buffer.byteLength(src) });
    }
    vendorHtml = blocks.join('\n');
  }

  const appDir = o['app-dir'];
  if (!existsSync(appDir)) fail('app dir missing: ' + rel(appDir));
  const files = (await readdir(appDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.js'))
    .map((e) => e.name).sort();
  if (!files.length) fail('no app js files in ' + rel(appDir));

  const chunks = [];
  const appUsed = [];
  for (const name of files) {
    const src = await readFile(join(appDir, name), 'utf8');
    if (/^\s*(import|export)\s/m.test(src)) fail('app file uses ES module syntax (not supported in classic bundle): ' + name);
    chunks.push('// ==================== ' + name + ' (' + Buffer.byteLength(src) + ' bytes) ====================\n' + src);
    appUsed.push({ name, bytes: Buffer.byteLength(src) });
  }
  const appBundle = chunks.join('\n;\n');
  const appHtml = '<!-- app: ' + files.length + ' file(s) -->\n<script data-app-bundle="true">\n' + escapeInline(appBundle) + '\n</script>';

  html = html.split(P_VENDOR).join(vendorHtml);
  html = html.split(P_APP).join(appHtml);
  if (html.includes(P_VENDOR) || html.includes(P_APP)) fail('placeholders survived');
  if (!/<html[\s>]/i.test(html)) fail('output does not look like HTML');

  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, html, 'utf8');
  if (o.mirror) {
    await mkdir(dirname(o.mirror), { recursive: true });
    await writeFile(o.mirror, html, 'utf8');
  }
  const size = Buffer.byteLength(html);
  console.log('\n  vendor:');
  vendorUsed.forEach((v) => console.log('    ' + v.name.padEnd(18) + String(v.bytes).padStart(9) + ' B'));
  console.log('  app:');
  appUsed.forEach((v) => console.log('    ' + v.name.padEnd(18) + String(v.bytes).padStart(9) + ' B'));
  console.log('\nBUILD OK: ' + o.out);
  if (o.mirror) console.log('MIRROR OK: ' + o.mirror);
  console.log('  size: ' + size.toLocaleString('en-US') + ' bytes (' + (size / 1024).toFixed(1) + ' KiB) in ' +
    (performance.now() - t0).toFixed(0) + ' ms');
}
main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
