/* ============================================================
 * 10-geometry.js — 解析法精确网格
 *
 * 实体 = 倒角长方体
 *        − 5 个垂直大孔（顶面开口，平底）
 *        − 5 个水平针孔（前端面开口，打穿大孔近壁）
 *
 * 坐标（打印姿态）：
 *   X 0..W  Y 0..D（前端面 y=0）  Z 0..H（底面 z=0，顶面 z=H）
 *
 * 关键解析关系：
 *   大孔圆心    yc = L − R
 *   针孔轴      z  = zPin = H − pinDrop
 *   针孔穿透点  α = asin((r/R)·cosφ)（α 为大孔壁参数角）
 *   交线        y = yc − sqrt(R² − r²cos²φ)
 * 大孔壁与针孔壁共用同一批交线顶点，因此网格天然水密。
 * ============================================================ */
'use strict';

FSG.Geometry = (function () {
  'use strict';

  var PHI_SAMPLES = 48;        // 针孔圆周采样
  var ALPHA_UNIFORM = 96;      // 大孔壁圆周采样
  var WELD = 1e5;              // 1e-5 mm 位置焊接

  /* ---------- 向量 ---------- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function normalize(a) { var l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /* ---------- 网格构建器（按位置焊接） ---------- */
  function MeshBuilder() {
    this.pos = [];
    this.idx = [];
    this.map = new Map();
  }
  MeshBuilder.prototype.key = function (x, y, z) {
    return Math.round(x * WELD) + ',' + Math.round(y * WELD) + ',' + Math.round(z * WELD);
  };
  MeshBuilder.prototype.vertex = function (p) {
    var k = this.key(p[0], p[1], p[2]);
    var i = this.map.get(k);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(p[0], p[1], p[2]);
      this.map.set(k, i);
    }
    return i;
  };
  MeshBuilder.prototype.tri = function (a, b, c) {
    if (a === b || b === c || a === c) return;
    this.idx.push(a, b, c);
  };
  MeshBuilder.prototype.triPts = function (a, b, c) {
    this.tri(this.vertex(a), this.vertex(b), this.vertex(c));
  };
  MeshBuilder.prototype.mesh = function () {
    return {
      positions: new Float32Array(this.pos),
      indices: new Uint32Array(this.idx)
    };
  };

  /* ---------- 平面多边形（支持孔） ---------- */
  /* 选择 2D 基 u,v 使 u × v = n；earcut 输出在 (u,v) 内逆时针，
     映射回 3D 后法向即为 n（外法向），因此点序无关紧要。 */
  function basisFor(n) {
    var a = (Math.abs(n[2]) < 0.9) ? [0, 0, 1] : [1, 0, 0];
    var u = normalize(cross(n, a));
    var v = cross(n, u);
    return { u: u, v: v };
  }
  function addPlanar(mb, outer, holes, normal) {
    var n = normalize(normal);
    var b = basisFor(n);
    var u = b.u, v = b.v;
    function proj(p) { return new THREE.Vector2(dot(p, u), dot(p, v)); }
    var contour = outer.map(proj);
    var holeLoops = (holes || []).map(function (h) { return h.map(proj); });
    var tris = THREE.ShapeUtils.triangulateShape(contour, holeLoops);
    var all = outer.slice();
    (holes || []).forEach(function (h) { all = all.concat(h); });
    var vi = all.map(function (p) { return mb.vertex(p); });
    for (var t = 0; t < tris.length; t++) {
      var tri = tris[t];
      mb.tri(vi[tri[0]], vi[tri[1]], vi[tri[2]]);
    }
    return tris.length;
  }

  /* ---------- 单级：大孔 + 针孔 ---------- */
  function buildLevel(mb, lv, d) {
    var R = lv.R, r = lv.r, xc = lv.x, yc = lv.yc;
    var zPin = d.zPin, zFloor = d.zFloor, H = d.H;
    var k = Math.min(0.999999, r / R);
    var asm = Math.asin(k);        /* 针孔穿透大孔壁的最大参数角 */
    var M = PHI_SAMPLES;

    var phi = [], cs = [], sn = [];
    for (var j = 0; j < M; j++) {
      var p = 2 * Math.PI * j / M;
      phi.push(p);
      cs.push(Math.cos(p));
      sn.push(Math.sin(p));
    }

    /* 针孔入口圆（前端面）与交线（大孔壁）—— 共用 x,z，保证顶点一致 */
    var rim = [], end = [];
    for (var j = 0; j < M; j++) {
      var px = xc + r * cs[j];
      var pz = zPin + r * sn[j];
      rim.push([px, 0, pz]);
      var yy = yc - Math.sqrt(Math.max(0, R * R - r * r * cs[j] * cs[j]));
      end.push([px, yy, pz]);
    }

    /* 大孔壁上的孔边界列（对应 φ = 0..M/2 上半支） */
    var holeCols = [];
    for (var j = 0; j <= M / 2; j++) {
      holeCols.push({
        alpha: Math.asin(k * cs[j]),
        j: j,
        high: end[j],
        low: end[(M - j) % M]
      });
    }

    /* 均匀 α 列 + 孔边界列；剔除落在孔范围内的均匀列，保证边界顶点完全一致 */
    var alpha0 = -3 * Math.PI / 4;
    var step = 2 * Math.PI / ALPHA_UNIFORM;
    var cols = [];
    for (var j = 0; j < ALPHA_UNIFORM; j++) {
      var a = alpha0 + j * step;
      var wrap = Math.atan2(Math.sin(a), Math.cos(a));   /* 归一到 (-π, π] */
      if (Math.abs(wrap) < asm - 1e-9) continue;         /* 落在针孔穿透范围内 */
      cols.push({ alpha: a, j: -1 });
    }
    for (var q = 0; q < holeCols.length; q++) cols.push(holeCols[q]);
    cols.sort(function (p1, p2) { return p1.alpha - p2.alpha; });
    cols.push({ alpha: alpha0 + 2 * Math.PI, j: -1, seam: true });

    /* 列顶点 */
    var colPts = cols.map(function (c) {
      var a = c.alpha;
      var x = xc + R * Math.sin(a);
      var y = yc - R * Math.cos(a);
      var o = { inside: c.j >= 0, floor: [x, y, zFloor], top: [x, y, H] };
      if (c.j >= 0) { o.low = c.low; o.high = c.high; }
      return o;
    });

    /* 大孔壁：在 (α,z) 图内按 CCW 顺序取多边形，映射后反向绕序 → 法向指向轴心。
       start 取扇心：5 边形过渡条带里有一条共线边，必须避开共线顶点作扇心。 */
    function emitReversed(pts, start) {
      var n = pts.length, s = start || 0;
      for (var i = 1; i < n - 1; i++) {
        var a = pts[(s) % n], b = pts[(s + i) % n], c = pts[(s + i + 1) % n];
        mb.tri(mb.vertex(c), mb.vertex(b), mb.vertex(a));
      }
    }
    for (var ci = 0; ci < colPts.length - 1; ci++) {
      var A = colPts[ci], B = colPts[ci + 1];
      if (A.inside && B.inside) {
        emitReversed([A.floor, B.floor, B.low, A.low]);
        emitReversed([A.high, B.high, B.top, A.top]);
      } else if (!A.inside && !B.inside) {
        emitReversed([A.floor, B.floor, B.top, A.top]);
      } else if (!A.inside) {           /* B 为孔端点（low=high） */
        emitReversed([A.floor, B.floor, B.low, B.top, A.top]);
      } else {                           /* A 为孔端点：从 B.top 起扇，避开共线点 */
        emitReversed([A.floor, B.floor, B.top, A.top, A.low], 2);
      }
    }

    /* 孔底圆盘（法向 +Z） */
    var distinct = cols.slice(0, cols.length - 1);
    var center = [xc, yc, zFloor];
    var cf = mb.vertex(center);
    var prev = -1, first = -1;
    for (var q2 = 0; q2 < distinct.length; q2++) {
      var a2 = distinct[q2].alpha;
      var bp = [xc + R * Math.sin(a2), yc - R * Math.cos(a2), zFloor];
      var vv = mb.vertex(bp);
      if (prev < 0) first = vv; else mb.tri(cf, prev, vv);
      prev = vv;
    }
    mb.tri(cf, prev, first);

    /* 针孔壁：入口圆 → 交线（法向指向针孔轴心） */
    for (var j2 = 0; j2 < M; j2++) {
      var j3 = (j2 + 1) % M;
      mb.triPts(rim[j2], rim[j3], end[j3]);
      mb.triPts(rim[j2], end[j3], end[j2]);
    }

    /* 顶面圆孔多边形（供顶面 face 使用） */
    var topCircle = [];
    for (var q3 = 0; q3 < distinct.length; q3++) {
      var a3 = distinct[q3].alpha;
      topCircle.push([xc + R * Math.sin(a3), yc - R * Math.cos(a3), H]);
    }
    return { topCircle: topCircle, frontCircle: rim };
  }

  /* ---------- 倒角长方体外壳 ---------- */
  function buildShell(mb, W, D, H, c, topHoles, frontHoles) {
    var cEff = Math.max(0, c);
    var corners = [
      [0, 0, 0], [W, 0, 0], [0, D, 0], [W, D, 0],
      [0, 0, H], [W, 0, H], [0, D, H], [W, D, H]
    ].map(function (q) {
      var cx = q[0], cy = q[1], cz = q[2];
      var sx = cx === 0 ? 1 : -1;
      var sy = cy === 0 ? 1 : -1;
      var sz = cz === 0 ? 1 : -1;
      return {
        c: [cx, cy, cz], s: [sx, sy, sz],
        pz: [cx + sx * cEff, cy + sy * cEff, cz],              /* 落在 z 面 */
        py: [cx + sx * cEff, cy, cz + sz * cEff],              /* 落在 y 面 */
        px: [cx, cy + sy * cEff, cz + sz * cEff]               /* 落在 x 面 */
      };
    });
    function at(x, y, z) {
      for (var i = 0; i < corners.length; i++) {
        var q = corners[i].c;
        if (q[0] === x && q[1] === y && q[2] === z) return corners[i];
      }
      throw new Error('corner not found');
    }

    var F = {
      bottom: { n: [0, 0, -1], pick: 'pz', corners: [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]] },
      top:    { n: [0, 0, 1],  pick: 'pz', corners: [[0, 0, H], [W, 0, H], [W, D, H], [0, D, H]], holes: topHoles },
      front:  { n: [0, -1, 0], pick: 'py', corners: [[0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H]], holes: frontHoles },
      back:   { n: [0, 1, 0],  pick: 'py', corners: [[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]] },
      left:   { n: [-1, 0, 0], pick: 'px', corners: [[0, 0, 0], [0, D, 0], [0, D, H], [0, 0, H]] },
      right:  { n: [1, 0, 0],  pick: 'px', corners: [[W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H]] }
    };
    Object.keys(F).forEach(function (key) {
      var f = F[key];
      var outer = f.corners.map(function (q) { return at(q[0], q[1], q[2])[f.pick]; });
      addPlanar(mb, outer, f.holes || [], f.n);
    });

    if (cEff <= 1e-9) return;

    /* 12 条棱的倒角带 */
    var EDGES = [
      { a: [0, 0, 0], b: [W, 0, 0], f1: 'bottom', f2: 'front' },
      { a: [0, D, 0], b: [W, D, 0], f1: 'bottom', f2: 'back' },
      { a: [0, 0, H], b: [W, 0, H], f1: 'top', f2: 'front' },
      { a: [0, D, H], b: [W, D, H], f1: 'top', f2: 'back' },
      { a: [0, 0, 0], b: [0, D, 0], f1: 'bottom', f2: 'left' },
      { a: [W, 0, 0], b: [W, D, 0], f1: 'bottom', f2: 'right' },
      { a: [0, 0, H], b: [0, D, H], f1: 'top', f2: 'left' },
      { a: [W, 0, H], b: [W, D, H], f1: 'top', f2: 'right' },
      { a: [0, 0, 0], b: [0, 0, H], f1: 'front', f2: 'left' },
      { a: [W, 0, 0], b: [W, 0, H], f1: 'front', f2: 'right' },
      { a: [0, D, 0], b: [0, D, H], f1: 'back', f2: 'left' },
      { a: [W, D, 0], b: [W, D, H], f1: 'back', f2: 'right' }
    ];
    EDGES.forEach(function (e) {
      var c0 = at(e.a[0], e.a[1], e.a[2]);
      var c1 = at(e.b[0], e.b[1], e.b[2]);
      var f1 = F[e.f1], f2 = F[e.f2];
      var quad = [
        c0[f1.pick], c1[f1.pick], c1[f2.pick], c0[f2.pick]
      ];
      var n = [f1.n[0] + f2.n[0], f1.n[1] + f2.n[1], f1.n[2] + f2.n[2]];
      addPlanar(mb, quad, [], n);
    });

    /* 8 个角三角面：外法向指向“被切掉的角”，即 -(sx,sy,sz) */
    corners.forEach(function (q) {
      addPlanar(mb, [q.pz, q.py, q.px], [], [-q.s[0], -q.s[1], -q.s[2]]);
    });
  }

  /* ---------- 审计 ---------- */
  function auditMesh(mesh) {
    var pos = mesh.positions, idx = mesh.indices;
    var nv = pos.length / 3, nt = idx.length / 3;
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < nv; i++) {
      for (var k = 0; k < 3; k++) {
        var v = pos[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    var und = new Map();       /* 无向边计数 */
    var dir = new Map();       /* 有向边计数 */
    var volume = 0, area = 0, degenerate = 0;
    function ek(a, b) { return a < b ? a + ',' + b : b + ',' + a; }
    for (var t = 0; t < nt; t++) {
      var ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
      var ax = pos[ia * 3], ay = pos[ia * 3 + 1], az = pos[ia * 3 + 2];
      var bx = pos[ib * 3], by = pos[ib * 3 + 1], bz = pos[ib * 3 + 2];
      var cx = pos[ic * 3], cy = pos[ic * 3 + 1], cz = pos[ic * 3 + 2];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var a2 = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
      if (a2 < 1e-10) degenerate++;
      area += a2;
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      var e1 = ek(ia, ib), e2 = ek(ib, ic), e3 = ek(ic, ia);
      und.set(e1, (und.get(e1) || 0) + 1);
      und.set(e2, (und.get(e2) || 0) + 1);
      und.set(e3, (und.get(e3) || 0) + 1);
      var d1 = ia + ',' + ib, d2 = ib + ',' + ic, d3 = ic + ',' + ia;
      dir.set(d1, (dir.get(d1) || 0) + 1);
      dir.set(d2, (dir.get(d2) || 0) + 1);
      dir.set(d3, (dir.get(d3) || 0) + 1);
    }
    var open = 0, nonManifold = 0, boundary = 0;
    und.forEach(function (cnt) {
      if (cnt === 1) open++;
      if (cnt > 2) nonManifold++;
      if (cnt !== 2) boundary++;
    });
    var dirDup = 0;
    dir.forEach(function (cnt) { if (cnt > 1) dirDup++; });

    /* 连通域（按共享顶点并查集） */
    var parent = new Int32Array(nv);
    for (var q = 0; q < nv; q++) parent[q] = q;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }
    for (var t2 = 0; t2 < nt; t2++) union(idx[t2 * 3], idx[t2 * 3 + 1]), union(idx[t2 * 3 + 1], idx[t2 * 3 + 2]);
    var roots = new Set();
    for (var t3 = 0; t3 < nt; t3++) roots.add(find(idx[t3 * 3]));

    return {
      ok: (open === 0 && nonManifold === 0 && dirDup === 0 && degenerate === 0 && roots.size === 1 && volume > 0),
      watertight: open === 0 && nonManifold === 0 && dirDup === 0,
      openEdges: open,
      nonManifoldEdges: nonManifold,
      boundaryEdges: boundary,
      inconsistentDirectedEdges: dirDup,
      degenerateTriangles: degenerate,
      components: roots.size,
      vertices: nv,
      triangles: nt,
      volume: volume,
      area: area,
      bboxMin: min,
      bboxMax: max
    };
  }

  function signedVolume(mesh) {
    var pos = mesh.positions, idx = mesh.indices;
    var v = 0;
    for (var t = 0; t < idx.length; t += 3) {
      var a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      var ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      var bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      var cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return v;
  }

  function flipAll(mesh) {
    var idx = mesh.indices;
    for (var t = 0; t < idx.length; t += 3) {
      var tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
    }
  }

  /* ---------- 构建 ---------- */
  function build(params) {
    var d = FSG.derive(params);
    if (!d.ok) {
      var err = new Error('参数无效：' + d.errors.slice(0, 3).join('；'));
      err.derived = d;
      throw err;
    }
    var mb = new MeshBuilder();
    var topHoles = [], frontHoles = [];
    for (var i = 0; i < d.n; i++) {
      var feat = buildLevel(mb, d.levels[i], d);
      topHoles.push(feat.topCircle);
      frontHoles.push(feat.frontCircle);
    }
    buildShell(mb, d.W, d.D, d.H, d.params.chamfer, topHoles, frontHoles);

    var mesh = mb.mesh();
    if (signedVolume(mesh) < 0) { flipAll(mesh); }
    var audit = auditMesh(mesh);
    return {
      positions: mesh.positions,
      indices: mesh.indices,
      audit: audit,
      derived: d
    };
  }

  /* ---------- 剖面多边形（2D，用于剖面视图封盖） ---------- */
  function sectionPolygon(params, z) {
    var d = FSG.derive(params);
    var W = d.W, D = d.D, H = d.H, c = Math.max(0, d.params.chamfer);
    var zz = (z === undefined) ? d.zPin : z;

    /* 先用半平面裁剪得到倒角矩形在该高度的截面 */
    var poly = [[0, 0], [W, 0], [W, D], [0, D]];
    var planes = [
      [0, 1, (H - zz) - c],      /* 顶-前 */
      [0, -1, (H - zz) + D - c], /* 顶-后 */
      [1, 0, (H - zz) - c],      /* 顶-左 */
      [-1, 0, (H - zz) + W - c], /* 顶-右 */
      [0, 1, zz - c],            /* 底-前 */
      [0, -1, zz + D - c],       /* 底-后 */
      [1, 0, zz - c],            /* 底-左 */
      [-1, 0, zz + W - c],       /* 底-右 */
      [1, 1, -c],                /* 角 (0,0) */
      [-1, 1, W - c],            /* 角 (W,0) */
      [1, -1, D - c],            /* 角 (0,D) */
      [-1, -1, W + D - c]        /* 角 (W,D) */
    ];
    function clip(pg, a, b, cc) {
      var out = [];
      for (var i = 0; i < pg.length; i++) {
        var p = pg[i], q = pg[(i + 1) % pg.length];
        var fp = a * p[0] + b * p[1] + cc;
        var fq = a * q[0] + b * q[1] + cc;
        if (fp >= -1e-9) out.push(p);
        if ((fp > 1e-9 && fq < -1e-9) || (fp < -1e-9 && fq > 1e-9)) {
          var t = fp / (fp - fq);
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      return out;
    }
    for (var i = 0; i < planes.length; i++) {
      poly = clip(poly, planes[i][0], planes[i][1], planes[i][2]);
      if (poly.length < 3) break;
    }
    /* 仅当截面正好穿过针孔轴时，才挖 keyhole 缺口 */
    var needKeys = Math.abs(zz - d.zPin) < 1e-6 && zz > d.zFloor && zz < H;
    if (!needKeys || poly.length < 3) return { points: poly, closed: false };

    /* 以 y 最小的一边作为“入口边”，在该边上插入 5 个 keyhole */
    var yFront = Math.min.apply(null, poly.map(function (p) { return p[1]; }));
    var onFront = poly.filter(function (p) { return Math.abs(p[1] - yFront) < 1e-7; });
    var xL = Math.min.apply(null, onFront.map(function (p) { return p[0]; }));
    var xR = Math.max.apply(null, onFront.map(function (p) { return p[0]; }));
    var part = poly.filter(function (p) { return Math.abs(p[1] - yFront) > 1e-7; });

    var seq = [[xL, yFront]];
    var levels = d.levels.slice().sort(function (a, b) { return a.x - b.x; });
    var ARC = 40;
    levels.forEach(function (lv) {
      var R = lv.R, r = lv.r;
      var join = lv.yc - Math.sqrt(Math.max(0, R * R - r * r));
      var tL = Math.atan2(join - lv.yc, -r);
      var tR = Math.atan2(join - lv.yc, r) - 2 * Math.PI;
      seq.push([lv.x - r, yFront]);
      seq.push([lv.x - r, join]);
      for (var s = 1; s <= ARC; s++) {
        var tt = tL + (tR - tL) * (s / ARC);
        seq.push([lv.x + R * Math.cos(tt), lv.yc + R * Math.sin(tt)]);
      }
      seq.push([lv.x + r, yFront]);
    });
    seq.push([xR, yFront]);

    /* 其余顶点按原顺序拼接：从最右端入口点之后开始绕行 */
    var out = seq.slice();
    var startIdx = -1;
    for (var k = 0; k < part.length; k++) {
      if (part[k][0] >= xR - 1e-7) { startIdx = k; break; }
    }
    if (startIdx < 0) startIdx = 0;
    for (var k2 = 1; k2 < part.length; k2++) {
      var p2 = part[(startIdx + k2) % part.length];
      if (Math.abs(p2[1] - yFront) < 1e-7) continue;
      out.push([p2[0], p2[1]]);
    }
    return { points: out, closed: true };
  }

  function sectionCapMesh(params) {
    var d = FSG.derive(params);
    var sp = sectionPolygon(params, d.zPin);
    if (!sp.closed || sp.points.length < 3) return null;
    var pts = sp.points.map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var tris = THREE.ShapeUtils.triangulateShape(pts, []);
    var pos = [], idx = [];
    sp.points.forEach(function (p) { pos.push(p[0], p[1], d.zPin); });
    for (var t = 0; t < tris.length; t++) {
      idx.push(tris[t][0], tris[t][1], tris[t][2]);
    }
    /* 封盖朝上：确保法向 +Z */
    var mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
    if (signedVolume(mesh) < 0) flipAll(mesh);
    return mesh;
  }

  return {
    build: build,
    auditMesh: auditMesh,
    signedVolume: signedVolume,
    sectionPolygon: sectionPolygon,
    sectionCapMesh: sectionCapMesh,
    constants: { PHI_SAMPLES: PHI_SAMPLES, ALPHA_UNIFORM: ALPHA_UNIFORM }
  };
})();
