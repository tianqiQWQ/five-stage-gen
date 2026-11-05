#!/usr/bin/env node
/* tools/verify-built.mjs — 单文件成品静态验收
 *   node tools/verify-built.mjs --html 五级台生成器.html
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let htmlPath = join(ROOT, '五级台生成器.html');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--html') htmlPath = resolve(args[++i] || '');
}
if (!existsSync(htmlPath)) { console.error('not found: ' + htmlPath); process.exit(1); }

const html = readFileSync(htmlPath, 'utf8');
const checks = [];
function check(name, cond, info) {
  checks.push({ name, ok: !!cond, info });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (info !== undefined ? '  [' + info + ']' : ''));
}

check('文件存在且非空', html.length > 10000, html.length + ' bytes');
check('无残留占位符', !html.includes('<!--INLINE_VENDOR-->') && !html.includes('<!--INLINE_APP-->'));
check('内联 three.js', html.includes('<!-- vendor: three.min.js'));
check('内联 OrbitControls', html.includes('<!-- vendor: OrbitControls.js'));
check('内联应用代码', html.includes('<script data-app-bundle="true">'));
check('无外链 <script src=', !/<script[^>]+src=/i.test(html));
check('无外链样式 <link href=', !/<link[^>]+href=["']https?:/i.test(html));
check('无 @import', !/@import\s+url/i.test(html));
check('无 CSS 远程 url()', !/url\(\s*["']?https?:/i.test(html));
check('体积 < 1.3 MB', html.length < 1.3 * 1024 * 1024, (html.length / 1024).toFixed(1) + ' KiB');

/* 提取 app bundle 并做语法编译 + 关键符号检查 */
const m = html.match(/<script data-app-bundle="true">([\s\S]*?)<\/script>/);
if (!m) { check('app bundle 可提取', false); }
else {
  const code = m[1].replace(/<\\\/script/gi, '</script');
  let compiled = true, err = '';
  try { new Function(code); } catch (e) { compiled = false; err = String(e.message); }
  check('app bundle 语法通过', compiled, err);
  for (const sym of ['FSG.Geometry', 'FSG.Scene', 'FSG.UI', 'FSG.Export', 'triangulateShape', 'sectionCapMesh']) {
    check('包含符号 ' + sym, code.includes(sym));
  }
  check('app 代码无 ES module 语法', !/^\s*(import|export)\s/m.test(code));
  check('app 代码无 fetch / XHR', !/fetch\s*\(/.test(code) && !/XMLHttpRequest/.test(code));
  check('app 代码无外链资源', !/https?:\/\//.test(code.replace(
    /https?:\/\/(schemas\.microsoft\.com|schemas\.openxmlformats\.org|www\.w3\.org)[^\s"']*/g, '')));
}
const vendor = html.match(/<script data-vendor="three.min.js">([\s\S]*?)<\/script>/);
check('three vendor 块可提取', !!vendor);
if (vendor) {
  const vcode = vendor[1].replace(/<\\\/script/gi, '</script');
  let ok = true, e = '';
  try { new Function(vcode); } catch (ex) { ok = false; e = String(ex.message); }
  check('three vendor 语法通过', ok, e);
}

const bad = checks.filter((c) => !c.ok);
console.log('\n' + (bad.length ? 'VERIFY FAILED: ' + bad.length + ' 项' : 'VERIFY OK: ' + checks.length + ' 项全部通过'));
process.exit(bad.length ? 1 : 0);
