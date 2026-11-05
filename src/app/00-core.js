/* ============================================================
 * 00-core.js — 参数定义 / 派生 / 校验 / URL 状态
 * 五级台生成器 · 昆虫标本针插定位台
 *
 * 坐标约定（与打印姿态一致，单位 mm）：
 *   X: 0 .. W     五级沿 X 排列
 *   Y: 0 .. D     前端面 y=0 开 5 个针孔，向后为 +Y
 *   Z: 0 .. H     底面 z=0，顶面 z=H；大孔从顶面往下钻
 *
 * 长度定义：针孔入口面(y=0) → 大孔最远壁(y=L) 的距离。
 * ============================================================ */
'use strict';

var FSG = (typeof FSG === 'object' && FSG) ? FSG : {};

FSG.VERSION = '1.0.0';
FSG.TITLE = '五级台生成器';
FSG.SUBTITLE = '昆虫标本 · 针插定位台';

/* 五级配色（标注 / 面板共用） */
FSG.LEVEL_COLORS = ['#d97706', '#0e7490', '#7c3aed', '#be123c', '#15803d'];
FSG.LEVEL_NAMES = ['第一级', '第二级', '第三级', '第四级', '第五级'];

/* 默认参数 = 参考模型（第 5 级按确认统一为 Ø8 / Ø1.25） */
FSG.DEFAULT_PARAMS = {
  L: [28, 24, 19, 17, 15],
  boreD: [8, 8, 8, 8, 8],
  pinD: [1.25, 1.25, 1.25, 1.25, 1.25],
  pinDrop: 4,      // 针孔轴心距顶面
  boreDepth: 10,   // 大孔深度（从顶面）
  H: 20,           // 板高
  pitch: 10,       // 级间距
  sideMargin: 10,  // 左右边距
  rearWall: 12,    // 大孔最远壁 → 后立面
  chamfer: 1       // 45° 倒角
};

/* 参考模型（用于「恢复参考值」与回归测试的逐级孔径） */
FSG.REFERENCE = {
  L: [28, 24, 19, 17, 15],
  boreD: [8, 8, 8, 8, 7.5],
  pinD: [1.25, 1.25, 1.25, 1.25, 2.0],
  pinDrop: 4, boreDepth: 10, H: 20, pitch: 10, sideMargin: 10, rearWall: 12, chamfer: 1
};

/* 常用尺寸输入项（UI 用；值统一写入 5 级） */
FSG.SIZE_FIELDS = [
  { key: 'boreD',   label: '大孔直径',     min: 1.0,  max: 20,   step: 0.1, unit: 'mm' },
  { key: 'pinD',    label: '针孔直径',     min: 0.4,  max: 6,    step: 0.05, unit: 'mm' },
  { key: 'pinDrop', label: '针孔离顶面',   min: 0.5,  max: 30,   step: 0.1, unit: 'mm' },
  { key: 'boreDepth', label: '大孔深度',   min: 1,    max: 60,   step: 0.1, unit: 'mm' },
  { key: 'H',       label: '板高',         min: 3,    max: 80,   step: 0.5, unit: 'mm' },
  { key: 'pitch',   label: '级间距',       min: 2,    max: 60,   step: 0.5, unit: 'mm' },
  { key: 'sideMargin', label: '左右边距',  min: 1,    max: 60,   step: 0.5, unit: 'mm' },
  { key: 'rearWall', label: '后壁厚',      min: 1,    max: 60,   step: 0.5, unit: 'mm' },
  { key: 'chamfer', label: '倒角',         min: 0,    max: 3,    step: 0.1, unit: 'mm' }
];

/* ---------- 小工具 ---------- */
FSG.fmt = function (v, digits) {
  const d = (digits === undefined) ? 2 : digits;
  if (!isFinite(v)) return '–';
  let s = Number(v).toFixed(d);
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s;
};
FSG.frac = function (v) {
  const f = Math.abs(v - Math.round(v));
  return f < 1e-9 ? 0 : 2;
};
FSG.clone = function (obj) { return JSON.parse(JSON.stringify(obj)); };
FSG.toNum = function (v, fallback) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};
FSG.uniqSorted = function (arr, eps) {
  const e = eps || 1e-7;
  const out = [];
  for (const v of arr.slice().sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1] > e) out.push(v);
  }
  return out;
};

FSG.defaults = function () { return FSG.clone(FSG.DEFAULT_PARAMS); };
FSG.reference = function () { return FSG.clone(FSG.REFERENCE); };

/* 把常用尺寸统一写入 5 级 */
FSG.setSizeParam = function (p, key, value) {
  const v = Number(value);
  if (key === 'boreD' || key === 'pinD') {
    p[key] = p[key].map(function () { return v; });
  } else {
    p[key] = v;
  }
};

/* ---------- 派生 + 校验 ---------- */
FSG.derive = function (params) {
  const p = params || FSG.defaults();
  const errors = [];
  const warnings = [];
  const L = (p.L || []).map(Number);
  const boreD = (p.boreD || []).map(Number);
  const pinD = (p.pinD || []).map(Number);
  const n = L.length;

  function bad(msg) { errors.push(msg); }
  function warn(msg) { warnings.push(msg); }

  if (n < 1 || n > 8) bad('级数必须在 1–8 之间（当前 ' + n + ' 级）');
  if (boreD.length !== n || pinD.length !== n) bad('长度/孔径数组长度不一致');
  if (!(p.pinDrop > 0)) bad('针孔离顶面必须 > 0');
  if (!(p.boreDepth > 0)) bad('大孔深度必须 > 0');
  if (!(p.H > 0)) bad('板高必须 > 0');
  if (!(p.pitch > 0)) bad('级间距必须 > 0');
  if (!(p.sideMargin > 0)) bad('左右边距必须 > 0');
  if (!(p.rearWall > 0)) bad('后壁厚必须 > 0');
  if (!(p.chamfer >= 0)) bad('倒角不能为负');

  const nums = L.concat(boreD, pinD, [p.pinDrop, p.boreDepth, p.H, p.pitch, p.sideMargin, p.rearWall, p.chamfer]);
  if (nums.some(function (v) { return !isFinite(v); })) bad('存在非法数值（空值或非数字）');

  const W = 2 * p.sideMargin + (n - 1) * p.pitch;
  const D = Math.max.apply(null, L) + p.rearWall;
  const H = p.H;
  const zTop = H;
  const zFloor = H - p.boreDepth;
  const zPin = H - p.pinDrop;
  const levels = [];
  for (let i = 0; i < n; i++) {
    const R = boreD[i] / 2;
    const r = pinD[i] / 2;
    const x = p.sideMargin + i * p.pitch;
    const yc = L[i] - R;
    levels.push({
      i: i, x: x, yc: yc, R: R, r: r,
      L: L[i], boreD: boreD[i], pinD: pinD[i],
      slotLen: L[i] - boreD[i],   // 针孔直线段长度 = L - 大孔直径
      angleMax: Math.asin(Math.min(0.999999, r / Math.max(R, 1e-6)))
    });
  }

  const maxBore = Math.max.apply(null, boreD);
  const maxPin = Math.max.apply(null, pinD);

  for (let i = 0; i < n; i++) {
    if (!(boreD[i] > 0)) bad('第 ' + (i + 1) + ' 级大孔直径必须 > 0');
    if (!(pinD[i] >= 0.4)) bad('第 ' + (i + 1) + ' 级针孔直径不能小于 0.4 mm');
    if (pinD[i] >= boreD[i] - 0.2) bad('第 ' + (i + 1) + ' 级针孔直径必须明显小于大孔直径');
    if (L[i] < boreD[i] + 1) bad('第 ' + (i + 1) + ' 级长度太小：至少 = 大孔直径 + 1 mm（' + FSG.fmt(boreD[i] + 1, 1) + '）');
    if (L[i] - boreD[i] < p.chamfer + 1) bad('第 ' + (i + 1) + ' 级大孔离入口面太近（会被倒角切到）');
    if (levels[i].x - levels[i].R < p.chamfer + 0.5) bad('第 ' + (i + 1) + ' 级大孔超出左侧倒角范围');
    if (levels[i].x + levels[i].R > W - p.chamfer - 0.5) bad('第 ' + (i + 1) + ' 级大孔超出右侧倒角范围');
  }

  if (p.pinDrop - maxPin / 2 <= p.chamfer + 0.5) bad('针孔离顶面太近：会切到顶面倒角（需 > ' + FSG.fmt(p.chamfer + maxPin / 2 + 0.5, 1) + '）');
  if (p.pinDrop + maxPin / 2 >= p.boreDepth - 0.5) bad('针孔离顶面太远：会切到大孔孔底（需 < ' + FSG.fmt(p.boreDepth - maxPin / 2 - 0.5, 1) + '）');
  if (p.boreDepth > H - 2) bad('大孔太深：孔底至少留 2 mm（板高 − 深度 ≥ 2）');
  if (p.pitch < maxBore + 1.5) bad('级间距太小：相邻大孔至少留 1.5 mm 壁厚');
  if (p.sideMargin < maxBore / 2 + 2) bad('左右边距太小：大孔到侧边至少留 2 mm');
  if (p.rearWall < 2) bad('后壁太薄：至少 2 mm');
  if (p.chamfer > 0) {
    const limit = Math.min(p.sideMargin - maxBore / 2 - 1, p.rearWall - 1.5, H / 2 - 1, 2.5);
    if (p.chamfer > limit + 1e-9) bad('倒角太大：当前参数下最多 ' + FSG.fmt(Math.max(0, limit), 1) + ' mm');
  }
  if (W > 400 || D > 400) bad('外形超过 400 mm，超出常见桌面打印机范围');

  if (p.pinDrop - maxPin / 2 < p.chamfer + 1) warn('针孔离顶面偏近，打印后边缘可能偏薄');
  if (maxPin < 0.8) warn('针孔 < 0.8 mm，FDM 打印后可能需要通针');
  if (p.pitch - maxBore < 2) warn('级间壁厚 ' + FSG.fmt(p.pitch - maxBore, 1) + ' mm，偏薄');
  if (W > 256 || D > 256) warn('外形 ' + FSG.fmt(W, 1) + ' × ' + FSG.fmt(D, 1) + ' mm，超出常见 256 mm 热床');
  if (p.chamfer <= 0) warn('倒角为 0：棱边为直角，手感/打印都更锋利');

  return {
    ok: errors.length === 0,
    errors: errors, warnings: warnings,
    params: p,
    n: n, W: W, D: D, H: H,
    zTop: zTop, zFloor: zFloor, zPin: zPin,
    maxBore: maxBore, maxPin: maxPin,
    levels: levels
  };
};

/* ---------- URL hash ---------- */
FSG.hashState = {
  view: 'iso', dims: 1, section: 0, pins: 0, pose: 'print',
  wire: 0, auto: 0, ui: 1, freeze: 0
};

FSG.paramsFromHash = function (hash) {
  const p = FSG.defaults();
  const state = FSG.clone(FSG.hashState);
  if (!hash) return { params: p, state: state };
  const body = String(hash).replace(/^#/, '');
  const kv = {};
  body.split('&').forEach(function (part) {
    if (!part) return;
    const eq = part.indexOf('=');
    if (eq < 0) { kv[part] = ''; return; }
    kv[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
  });
  function numList(raw, fallback) {
    if (raw === undefined) return fallback;
    const arr = String(raw).split(',').map(function (s) { return Number(s); });
    if (arr.length === 1) return fallback.map(function () { return arr[0]; });
    if (arr.length !== fallback.length || arr.some(function (v) { return !isFinite(v); })) return fallback;
    return arr;
  }
  p.L = numList(kv.L, p.L);
  p.L = p.L.map(function (v) { return isFinite(v) ? v : 0; });
  p.boreD = numList(kv.bore, p.boreD);
  p.pinD = numList(kv.pin, p.pinD);
  ['pinDrop:drop', 'boreDepth:depth', 'H:h', 'pitch', 'sideMargin:margin', 'rearWall:rear', 'chamfer']
    .forEach(function (spec) {
      const pair = spec.split(':');
      const key = pair[0], alias = pair[1];
      const raw = (kv[key] !== undefined) ? kv[key] : (alias ? kv[alias] : undefined);
      if (raw !== undefined && raw !== '' && isFinite(Number(raw))) p[key] = Number(raw);
    });
  if (kv.view !== undefined) state.view = kv.view;
  ['dims', 'section', 'pins', 'wire', 'auto', 'ui', 'freeze'].forEach(function (k) {
    if (kv[k] !== undefined) state[k] = kv[k] === '1' || kv[k] === 'true' ? 1 : 0;
  });
  if (kv.pose === 'use' || kv.pose === 'print') state.pose = kv.pose;
  return { params: p, state: state };
};

FSG.hashFromParams = function (p, state) {
  const parts = [];
  parts.push('L=' + p.L.map(function (v) { return FSG.fmt(v, 2); }).join(','));
  const uniform = function (arr) {
    const allSame = arr.every(function (v) { return Math.abs(v - arr[0]) < 1e-9; });
    return allSame ? FSG.fmt(arr[0], 2) : arr.map(function (v) { return FSG.fmt(v, 2); }).join(',');
  };
  parts.push('bore=' + uniform(p.boreD));
  parts.push('pin=' + uniform(p.pinD));
  parts.push('drop=' + FSG.fmt(p.pinDrop, 2));
  parts.push('depth=' + FSG.fmt(p.boreDepth, 2));
  parts.push('h=' + FSG.fmt(p.H, 2));
  parts.push('pitch=' + FSG.fmt(p.pitch, 2));
  parts.push('margin=' + FSG.fmt(p.sideMargin, 2));
  parts.push('rear=' + FSG.fmt(p.rearWall, 2));
  parts.push('chamfer=' + FSG.fmt(p.chamfer, 2));
  const st = state || {};
  if (st.view && st.view !== 'iso') parts.push('view=' + st.view);
  if (st.dims) parts.push('dims=1');
  if (st.section) parts.push('section=1');
  if (st.pins) parts.push('pins=1');
  if (st.pose && st.pose !== 'print') parts.push('pose=' + st.pose);
  if (st.wire) parts.push('wire=1');
  if (st.auto) parts.push('auto=1');
  if (st.ui === 0) parts.push('ui=0');
  if (st.freeze) parts.push('freeze=1');
  return '#' + parts.join('&');
};

/* ---------- 参数导出文本 ---------- */
FSG.paramsReport = function (d, extra) {
  const p = d.params;
  const lines = [];
  lines.push('五级台 · 参数摘要（' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '）');
  lines.push('========================================');
  lines.push('外形 (W×D×H): ' + FSG.fmt(d.W, 2) + ' × ' + FSG.fmt(d.D, 2) + ' × ' + FSG.fmt(d.H, 2) + ' mm');
  lines.push('');
  lines.push('级别 / 长度L / 大孔Ø / 针孔Ø / 大孔圆心距入口 / 针孔段长');
  d.levels.forEach(function (lv) {
    lines.push('  ' + (lv.i + 1) + '   ' + FSG.fmt(lv.L, 2) + '   ' + FSG.fmt(lv.boreD, 2) + '   ' +
      FSG.fmt(lv.pinD, 2) + '   ' + FSG.fmt(lv.yc, 2) + '   ' + FSG.fmt(lv.slotLen, 2));
  });
  lines.push('');
  lines.push('公共尺寸: 针孔离顶面 ' + FSG.fmt(p.pinDrop, 2) + ' / 大孔深 ' + FSG.fmt(p.boreDepth, 2) +
    ' / 板高 ' + FSG.fmt(p.H, 2) + ' / 级距 ' + FSG.fmt(p.pitch, 2) + ' / 边距 ' + FSG.fmt(p.sideMargin, 2) +
    ' / 后壁 ' + FSG.fmt(p.rearWall, 2) + ' / 倒角 ' + FSG.fmt(p.chamfer, 2));
  lines.push('长度定义: 针孔入口面(y=0) → 大孔最远壁(y=L)');
  if (extra) {
    lines.push('');
    extra.forEach(function (s) { lines.push(s); });
  }
  return lines.join('\n') + '\n';
};
