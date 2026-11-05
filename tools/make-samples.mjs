#!/usr/bin/env node
/* tools/make-samples.mjs — 用与网页完全相同的几何/导出代码生成默认样例
 *   node tools/make-samples.mjs
 * 输出：
 *   samples/五级台_28-24-19-17-15.stl
 *   samples/五级台_28-24-19-17-15.3mf
 *   samples/五级台_28-24-19-17-15.参数.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function loadThree() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor', 'three.min.js'), 'utf8');
  const mod = { exports: {} };
  return new Function('module', 'exports', 'self', 'window', 'document',
    src + '\nreturn module.exports;')(mod, mod.exports, {}, {}, undefined);
}
function loadFSG(THREE) {
  const files = ['00-core.js', '10-geometry.js', '20-export.js'];
  const code = files.map((f) => fs.readFileSync(path.join(ROOT, 'src', 'app', f), 'utf8')).join('\n;\n');
  return new Function('THREE', code + '\nreturn FSG;')(THREE);
}

const THREE = loadThree();
const FSG = loadFSG(THREE);
const params = FSG.defaults();
const res = FSG.Geometry.build(params);
const d = res.derived;
const base = '五级台_' + d.levels.map((l) => FSG.fmt(l.L, 1)).join('-');
const outDir = path.join(ROOT, 'samples');
fs.mkdirSync(outDir, { recursive: true });

/* XY 居中（与网页导出一致） */
const pos = new Float32Array(res.positions.length);
for (let i = 0; i < pos.length; i += 3) {
  pos[i] = res.positions[i] - d.W / 2;
  pos[i + 1] = res.positions[i + 1] - d.D / 2;
  pos[i + 2] = res.positions[i + 2];
}
const mesh = { positions: pos, indices: res.indices };

const stl = FSG.Export.writeSTL(mesh);
fs.writeFileSync(path.join(outDir, base + '.stl'), Buffer.from(stl));

const mf = FSG.Export.write3MF(mesh, { name: '五级台' });
fs.writeFileSync(path.join(outDir, base + '.3mf'), Buffer.from(mf));

const txt = FSG.paramsReport(d, [
  '网格: ' + res.audit.triangles + ' 面 / ' + res.audit.vertices + ' 顶点 / 水密 ' + (res.audit.watertight ? '是' : '否'),
  '体积: ' + FSG.fmt(res.audit.volume / 1000, 2) + ' cm³，表面积 ' + FSG.fmt(res.audit.area / 100, 1) + ' cm²',
  '包围盒: [' + res.audit.bboxMin.map((v) => FSG.fmt(v, 2)).join(', ') + '] → [' +
    res.audit.bboxMax.map((v) => FSG.fmt(v, 2)).join(', ') + ']',
  '说明: STL/3MF 均已 XY 居中、底面 z=0；3MF 已按 Bambu 热床 256mm 置于 (128,128,0)。'
]);
fs.writeFileSync(path.join(outDir, base + '.参数.txt'), txt, 'utf8');

console.log('samples written:');
for (const f of fs.readdirSync(outDir)) {
  const s = fs.statSync(path.join(outDir, f));
  console.log('  ' + f.padEnd(42) + String(s.size).padStart(9) + ' B');
}
console.log('\naudit: ' + JSON.stringify({
  tris: res.audit.triangles, verts: res.audit.vertices,
  watertight: res.audit.watertight, volume: +res.audit.volume.toFixed(2),
  bbox: [res.audit.bboxMin, res.audit.bboxMax]
}));
