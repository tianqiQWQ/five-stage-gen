#!/usr/bin/env node
/* tools/test-geometry.mjs — Node 单测：几何内核 / 导出回归
 *
 * 运行：
 *   & $NODE tools/test-geometry.mjs
 * 说明：three.js 的 UMD 包在 Node 下可直接加载（见 loadThree）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, info) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg + (info !== undefined ? '  [' + info + ']' : ''));
  console.error('  ✗ ' + msg + (info !== undefined ? '  [' + info + ']' : ''));
  return false;
}
function near(a, b, tol, msg) {
  const d = Math.abs(a - b);
  return ok(d <= tol, msg, 'got ' + a + ' want ' + b + ' ±' + tol);
}
function between(a, lo, hi, msg) { return ok(a >= lo && a <= hi, msg, 'got ' + a + ' in [' + lo + ', ' + hi + ']'); }
function section(name) { console.log('\n== ' + name + ' =='); }

function loadThree() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor', 'three.min.js'), 'utf8');
  const mod = { exports: {} };
  const THREE = new Function('module', 'exports', 'self', 'window', 'document',
    src + '\nreturn module.exports;')(mod, mod.exports, {}, {}, undefined);
  return THREE;
}

function loadFSG(THREE) {
  const files = ['00-core.js', '10-geometry.js', '20-export.js'];
  const code = files.map((f) => fs.readFileSync(path.join(ROOT, 'src', 'app', f), 'utf8')).join('\n;\n');
  const factory = new Function('THREE', code + '\nreturn FSG;');
  return factory(THREE);
}

/* Möller–Trumbore */
function rayMesh(origin, dir, mesh) {
  const pos = mesh.positions, idx = mesh.indices;
  let best = Infinity, bestTri = -1;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = dir[0], dy = dir[1], dz = dir[2];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 1e-9 && tt < best) { best = tt; bestTri = t / 3; }
  }
  return { t: best, tri: bestTri };
}

function bbox(mesh) {
  const pos = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function areaAtZ(mesh, z0, tol) {
  const pos = mesh.positions, idx = mesh.indices;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const ids = [idx[t], idx[t + 1], idx[t + 2]];
    let all = true;
    for (const id of ids) if (Math.abs(pos[id * 3 + 2] - z0) > (tol || 1e-6)) { all = false; break; }
    if (!all) continue;
    const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  }
  return area;
}

function insideAnalytic(x, y, z, d) {
  const W = d.W, D = d.D, H = d.H, c = d.params.chamfer;
  if (x < 0 || x > W || y < 0 || y > D || z < 0 || z > H) return false;
  if (c > 0) {
    const tests = [
      x + y - c, W - x + y - c, x + D - y - c, W - x + D - y - c,
      x + z - c, W - x + z - c, x + H - z - c, W - x + H - z - c,
      y + z - c, D - y + z - c, y + H - z - c, D - y + H - z - c
    ];
    for (const t of tests) if (t < 0) return false;
    /* 8 个角三角面：(W−x) 形式的对称角约束 */
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      const tx = sx > 0 ? x : (W - x);
      const ty = sy > 0 ? y : (D - y);
      const tz = sz > 0 ? z : (H - z);
      if (tx + ty + tz < 2 * c) return false;
    }
  }
  for (const lv of d.levels) {
    if (z >= d.zFloor && (x - lv.x) * (x - lv.x) + (y - lv.yc) * (y - lv.yc) < lv.R * lv.R) return false;
    const dx = x - lv.x, dz = z - d.zPin;
    if (dx * dx + dz * dz < lv.r * lv.r) {
      const yWall = lv.yc - Math.sqrt(Math.max(0, lv.R * lv.R - dx * dx));
      if (y < yWall) return false;
    }
  }
  return true;
}

function mcVolume(d, samples, seed) {
  let s = (seed || 12345) >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  let hit = 0;
  const W = d.W, D = d.D, H = d.H;
  for (let i = 0; i < samples; i++) {
    if (insideAnalytic(rnd() * W, rnd() * D, rnd() * H, d)) hit++;
  }
  return hit / samples * W * D * H;
}

function main() {
  const THREE = loadThree();
  const FSG = loadFSG(THREE);
  console.log('three r' + THREE.REVISION + ' / FSG ' + FSG.VERSION);

  /* ---------------- 默认参数 ---------------- */
  section('默认参数：水密 / 尺寸 / 长度');
  const p = FSG.defaults();
  const t0 = Date.now();
  const res = FSG.Geometry.build(p);
  const buildMs = Date.now() - t0;
  const A = res.audit;
  console.log('  build ' + buildMs + ' ms, ' + A.vertices + ' verts, ' + A.triangles + ' tris, ' +
    (A.volume / 1000).toFixed(2) + ' cm³, area ' + (A.area / 100).toFixed(1) + ' cm²');

  ok(A.watertight, '默认网格水密');
  ok(A.openEdges === 0, '无开边', A.openEdges);
  ok(A.nonManifoldEdges === 0, '无非流形边', A.nonManifoldEdges);
  ok(A.inconsistentDirectedEdges === 0, '绕序一致', A.inconsistentDirectedEdges);
  ok(A.degenerateTriangles === 0, '无退化三角', A.degenerateTriangles);
  ok(A.components === 1, '单一连通域', A.components);
  ok(A.volume > 0, '有向体积为正', A.volume.toFixed(2));
  ok(A.triangles > 800 && A.triangles < 40000, '三角面数量合理', A.triangles);
  ok(buildMs < 3000, '构建耗时 ' + buildMs + ' ms < 3000 ms');

  const bb = bbox(res);
  near(bb.min[0], 0, 1e-6, 'bbox minX = 0');
  near(bb.min[1], 0, 1e-6, 'bbox minY = 0');
  near(bb.min[2], 0, 1e-6, 'bbox minZ = 0');
  near(bb.max[0], 60, 1e-6, 'bbox maxX = 60');
  near(bb.max[1], 40, 1e-6, 'bbox maxY = 40');
  near(bb.max[2], 20, 1e-6, 'bbox maxZ = 20');

  const d = res.derived;
  ok(d.levels.length === 5, '5 级');
  for (const lv of d.levels) {
    const hit = rayMesh([lv.x, -10, d.zPin], [0, 1, 0], res);
    if (ok(hit.t < Infinity, '第 ' + (lv.i + 1) + ' 级射线命中远壁')) {
      near(hit.t, lv.L + 10, 0.02, '第 ' + (lv.i + 1) + ' 级长度 L=' + lv.L + '（入口面→大孔远壁）');
    }
  }

  /* 孔位 / 半径 */
  section('孔径 / 位置');
  const pos = res.positions;
  for (const lv of d.levels) {
    let rmin = Infinity, rmax = -Infinity, n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 2] - 20) > 1e-6) continue;
      const dx = pos[i] - lv.x, dy = pos[i + 1] - lv.yc;
      if (dx * dx + dy * dy > (lv.R * 1.4) * (lv.R * 1.4)) continue;
      const rr = Math.hypot(dx, dy);
      rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr); n++;
    }
    ok(n > 40, '第 ' + (lv.i + 1) + ' 级顶面圆孔顶点数 ' + n);
    near(rmax, lv.R, 0.01, '第 ' + (lv.i + 1) + ' 级大孔半径 ' + lv.R);
    near(rmin, lv.R, 0.01, '第 ' + (lv.i + 1) + ' 级大孔圆度');
  }
  for (const lv of d.levels) {
    let rmin = Infinity, rmax = -Infinity, n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 1]) > 1e-6) continue;
      const dx = pos[i] - lv.x, dz = pos[i + 2] - d.zPin;
      if (dx * dx + dz * dz > (lv.r * 1.6) * (lv.r * 1.6)) continue;
      const rr = Math.hypot(dx, dz);
      rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr); n++;
    }
    ok(n > 20, '第 ' + (lv.i + 1) + ' 级针孔顶点数 ' + n);
    near(rmax, lv.r, 0.005, '第 ' + (lv.i + 1) + ' 级针孔半径 ' + lv.r);
  }

  /* 顶面面积：58×38 − 5×πR² */
  const topArea = areaAtZ(res, 20);
  let expectTop = 58 * 38;
  for (const lv of d.levels) expectTop -= Math.PI * lv.R * lv.R;
  near(topArea, expectTop, 1.5, '顶面面积（外框 − 5 个圆孔）');
  const frontArea = areaAtZ(res, 0) + 0; /* 前端面 y=0，另测 */
  let fa = 0;
  {
    const idx = res.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const ids = [idx[t], idx[t + 1], idx[t + 2]];
      if (!ids.every((id) => Math.abs(pos[id * 3 + 1]) < 1e-6)) continue;
      const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      fa += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    }
  }
  let expectFront = 58 * 18;
  for (const lv of d.levels) expectFront -= Math.PI * lv.r * lv.r;
  near(fa, expectFront, 1.0, '前端面面积（58×18 − 5 个针孔）');

  /* 体积：蒙特卡洛独立校验 */
  section('体积独立校验（蒙特卡洛）');
  const mc = mcVolume(d, 400000, 7);
  console.log('  mesh ' + A.volume.toFixed(1) + ' mm³ / MC ' + mc.toFixed(1) + ' mm³');
  ok(Math.abs(A.volume - mc) / mc < 0.005, '网格体积与解析实体一致 (<0.5%)',
    ((A.volume - mc) / mc * 100).toFixed(3) + '%');

  /* ---------------- 黄金基准：参考模型 ---------------- */
  section('黄金基准：复刻参考 STEP/3MF');
  const ref = FSG.reference();
  const r2 = FSG.Geometry.build(ref);
  const A2 = r2.audit;
  console.log('  ' + A2.triangles + ' tris, volume ' + A2.volume.toFixed(3) + ' mm³');
  ok(A2.watertight, '参考件网格水密');
  near(A2.volume, 45221.885, 45221.885 * 0.003, '参考件体积 45221.885 mm³ (±0.3%)');
  const bb2 = bbox(r2);
  near(bb2.max[0] - bb2.min[0], 60, 1e-6, '参考件 60 长');
  near(bb2.max[1] - bb2.min[1], 40, 1e-6, '参考件 40 深');
  near(bb2.max[2] - bb2.min[2], 20, 1e-6, '参考件 20 高');
  const topArea2 = areaAtZ(r2, 20);
  near(topArea2, 1958.883, 2.0, '参考件顶面面积 1958.883 mm²');
  const d2 = r2.derived;
  const expectY = [24, 20, 15, 13, 11.25];
  d2.levels.forEach((lv, i) => near(lv.yc, expectY[i], 1e-9, '参考件第 ' + (i + 1) + ' 级大孔圆心 y'));
  const hit5 = rayMesh([d2.levels[4].x, -10, d2.zPin], [0, 1, 0], r2);
  near(hit5.t, 15 + 10, 0.02, '参考件第 5 级 L=15');

  /* ---------------- 导出回归 ---------------- */
  section('STL / 3MF 导出回归');
  const stl = FSG.Export.writeSTL(res);
  ok(stl.length === 84 + A.triangles * 50, 'STL 长度与面数一致', stl.length);
  const parsed = FSG.Export.parseSTL(stl);
  ok(parsed.triangles === A.triangles, 'STL 面数回读一致', parsed.triangles);
  near(parsed.max[0] - parsed.min[0], 60, 1e-4, 'STL 包围盒 X');
  near(parsed.max[2] - parsed.min[2], 20, 1e-4, 'STL 包围盒 Z');

  const f3 = FSG.Export.write3MF(res);
  ok(f3.length > 1000, '3MF 非空', f3.length);
  const entries = FSG.Export.unzipStore(f3);
  ok(!!entries['3D/3dmodel.model'], '3MF 含 3D/3dmodel.model');
  ok(!!entries['[Content_Types].xml'], '3MF 含 Content_Types');
  const model = new TextDecoder().decode(entries['3D/3dmodel.model']);
  const nv = (model.match(/<vertex /g) || []).length;
  const nt = (model.match(/<triangle /g) || []).length;
  ok(nv === A.vertices, '3MF 顶点数一致', nv);
  ok(nt === A.triangles, '3MF 三角数一致', nt);
  ok(/transform="1 0 0 0 1 0 0 0 1 128 128 0"/.test(model), '3MF 放在热床中心 (128,128,0)');
  ok(/unit="millimeter"/.test(model), '3MF 单位 mm');

  /* ---------------- 剖面 ---------------- */
  section('剖面多边形 / 封盖');
  const sp = FSG.Geometry.sectionPolygon(p, d.zPin);
  ok(sp.closed, '剖面为闭合 keyhole 轮廓');
  ok(sp.points.length > 200, '剖面点数 ' + sp.points.length);
  let areaPoly = 0;
  for (let i = 0; i < sp.points.length; i++) {
    const a = sp.points[i], b = sp.points[(i + 1) % sp.points.length];
    areaPoly += a[0] * b[1] - b[0] * a[1];
  }
  ok(areaPoly / 2 > 1000, '剖面面积 > 1000 mm²', (areaPoly / 2).toFixed(1));
  const cap = FSG.Geometry.sectionCapMesh(p);
  ok(cap && cap.indices.length > 300, '剖面封盖网格生成', cap ? cap.indices.length / 3 : 0);

  /* ---------------- 边界情况 ---------------- */
  section('边界情况');
  const noChamfer = FSG.defaults(); noChamfer.chamfer = 0;
  const rc = FSG.Geometry.build(noChamfer);
  ok(rc.audit.watertight, '倒角=0 时水密', rc.audit.openEdges);
  near(rc.audit.volume, res.audit.volume + 250, 400, '倒角=0 体积更大（少切 12 条棱）', rc.audit.volume - res.audit.volume);

  const tiny = FSG.defaults(); tiny.L = [10, 10, 10, 10, 10];
  const rt = FSG.Geometry.build(tiny);
  ok(rt.audit.watertight, '最小长度（针孔段 2 mm）水密');

  const bad = FSG.defaults(); bad.L[0] = 5;
  const bd = FSG.derive(bad);
  ok(!bd.ok && bd.errors.length > 0, '非法长度被拒绝', bd.errors[0]);
  let threw = false;
  try { FSG.Geometry.build(bad); } catch (e) { threw = true; }
  ok(threw, '非法参数构建抛错');

  const bad2 = FSG.defaults(); bad2.pinD = [8, 8, 8, 8, 8];
  ok(!FSG.derive(bad2).ok, '针孔 ≥ 大孔被拒绝');

  /* hash 往返 */
  const st = { view: 'section', dims: 1, section: 1, pins: 1, pose: 'use', ui: 1 };
  const hash = FSG.hashFromParams(p, st);
  const back = FSG.paramsFromHash(hash);
  ok(back.params.L.join(',') === p.L.join(','), 'hash 长度往返一致');
  ok(Math.abs(back.params.pinDrop - p.pinDrop) < 1e-9, 'hash 参数往返一致');
  ok(back.state.view === 'section' && back.state.pose === 'use', 'hash 视图状态往返一致');

  /* ---------------- 汇总 ---------------- */
  console.log('\n========================================');
  console.log('PASS ' + pass + ' / ' + (pass + fail) + (fail ? '  FAIL ' + fail : '  全绿'));
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main();
