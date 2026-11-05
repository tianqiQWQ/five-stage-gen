/* ============================================================
 * 40-ui.js — 参数面板 / 校验 / 导出 / 视图开关
 * ============================================================ */
'use strict';

FSG.UI = (function () {
  'use strict';

  var params = null, state = null, result = null;
  var onResult = null, sceneApi = null;
  var inputsL = [], inputsSize = {};
  var timer = null;
  var lastGood = null;
  var els = {};

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(msg, isErr) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ''; }, 2200);
  }
  function fmtMM(v) { return FSG.fmt(v, 2); }
  function fileBase() {
    var d = result ? result.derived : FSG.derive(params);
    return '五级台_' + d.levels.map(function (l) { return FSG.fmt(l.L, 1); }).join('-');
  }

  /* ---------- 面板构建 ---------- */
  function buildLevelInputs() {
    var host = $('levels');
    host.innerHTML = '';
    inputsL = [];
    for (var i = 0; i < params.L.length; i++) {
      var row = el('div', 'lv');
      var chip = el('span', 'chip');
      chip.style.background = FSG.LEVEL_COLORS[i % FSG.LEVEL_COLORS.length];
      var lab = el('label', '', FSG.LEVEL_NAMES[i] || ('第 ' + (i + 1) + ' 级'));
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.1';
      inp.min = '1';
      inp.max = '200';
      inp.setAttribute('inputmode', 'decimal');
      inp.value = FSG.fmt(params.L[i], 1);
      inp.dataset.level = String(i);
      var unit = el('span', 'unit', 'mm');
      row.appendChild(chip); row.appendChild(lab); row.appendChild(inp); row.appendChild(unit);
      host.appendChild(row);
      inputsL.push(inp);
      bindInput(inp);
    }
  }

  function buildSizeInputs() {
    var host = $('sizes');
    host.innerHTML = '';
    inputsSize = {};
    FSG.SIZE_FIELDS.forEach(function (f) {
      var wrap = el('div', 'fld');
      var lab = el('label');
      lab.appendChild(el('span', '', f.label));
      lab.appendChild(el('span', '', f.unit));
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.step = String(f.step);
      inp.min = String(f.min);
      inp.max = String(f.max);
      inp.setAttribute('inputmode', 'decimal');
      inp.dataset.key = f.key;
      var cur = params[f.key];
      inp.value = FSG.fmt(cur, 2);
      wrap.appendChild(lab); wrap.appendChild(inp);
      host.appendChild(wrap);
      inputsSize[f.key] = inp;
      bindInput(inp);
    });
  }

  function bindInput(inp) {
    inp.addEventListener('input', schedule);
    inp.addEventListener('change', schedule);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { schedule(); }
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { readInputs(); rebuild(false); }, 90);
  }

  /* ---------- 读/写参数 ---------- */
  function readInputs() {
    for (var i = 0; i < inputsL.length; i++) {
      var v = parseFloat(inputsL[i].value);
      params.L[i] = isFinite(v) ? v : NaN;
    }
    FSG.SIZE_FIELDS.forEach(function (f) {
      var raw = inputsSize[f.key].value;
      var v = parseFloat(raw);
      if (f.key === 'boreD' || f.key === 'pinD') {
        params[f.key] = params[f.key].map(function () { return isFinite(v) ? v : NaN; });
      } else {
        params[f.key] = isFinite(v) ? v : NaN;
      }
    });
  }
  function writeInputs() {
    for (var i = 0; i < inputsL.length; i++) inputsL[i].value = FSG.fmt(params.L[i], 1);
    FSG.SIZE_FIELDS.forEach(function (f) {
      var cur = params[f.key];
      var v = (f.key === 'boreD' || f.key === 'pinD') ? cur[0] : cur;
      inputsSize[f.key].value = FSG.fmt(v, 2);
    });
  }
  function markInputs() {
    for (var i = 0; i < inputsL.length; i++) {
      var v = params.L[i];
      inputsL[i].classList.toggle('bad', !isFinite(v) || v <= 0);
    }
    FSG.SIZE_FIELDS.forEach(function (f) {
      var cur = params[f.key];
      var v = (f.key === 'boreD' || f.key === 'pinD') ? cur[0] : cur;
      inputsSize[f.key].classList.toggle('bad', !isFinite(v) || v <= 0);
    });
  }

  /* ---------- 重建 ---------- */
  function rebuild(silent) {
    var d = FSG.derive(params);
    markInputs();
    if (!d.ok) {
      showProblems(d);
      setExportEnabled(false);
      return false;
    }
    var res;
    try {
      res = FSG.Geometry.build(params);
    } catch (e) {
      showProblems({ errors: [String(e.message || e)], warnings: [] });
      setExportEnabled(false);
      return false;
    }
    result = res;
    lastGood = res;
    if (onResult) onResult(res);
    updateReadout(res);
    showStatus(res);
    setExportEnabled(true);
    document.documentElement.setAttribute('data-watertight', res.audit.watertight ? '1' : '0');
    document.documentElement.setAttribute('data-tris', String(res.audit.triangles));
    document.documentElement.setAttribute('data-volume', res.audit.volume.toFixed(2));
    if (!silent) updateHash();
    return true;
  }

  function showProblems(d) {
    var dot = $('dot'), st = $('stText'), stats = $('stStats');
    dot.className = 'dot err';
    st.textContent = '参数需修正';
    stats.textContent = '';
    var msgs = $('msgs');
    msgs.innerHTML = '';
    (d.errors || []).forEach(function (m) {
      var li = el('li', 'err', m);
      msgs.appendChild(li);
    });
    (d.warnings || []).forEach(function (m) {
      var li = el('li', 'warn', m);
      msgs.appendChild(li);
    });
    document.documentElement.setAttribute('data-watertight', '0');
    if (d.errors && d.errors.length) toast('参数不合法：' + d.errors[0], true);
  }

  function showStatus(res) {
    var a = res.audit;
    var ok = a.watertight && a.components === 1 && a.volume > 0 && a.openEdges === 0;
    var dot = $('dot');
    dot.className = 'dot ' + (ok ? 'ok' : 'err');
    $('stText').textContent = ok ? '水密网格' : '网格异常';
    $('stStats').textContent = a.triangles.toLocaleString('en-US') + ' 面 · ' + a.components + ' 连通域';
    var msgs = $('msgs');
    msgs.innerHTML = '';
    var d = res.derived;
    (d.warnings || []).forEach(function (m) {
      msgs.appendChild(el('li', 'warn', m));
    });
    if (!ok) {
      msgs.appendChild(el('li', 'err', '网格审计未通过：开边 ' + a.openEdges +
        ' / 非流形 ' + a.nonManifoldEdges + ' / 绕序 ' + a.inconsistentDirectedEdges +
        ' / 退化 ' + a.degenerateTriangles + '，请反馈。'));
    }
  }

  function updateReadout(res) {
    var d = res.derived, a = res.audit;
    $('roSize').textContent = fmtMM(d.W) + ' × ' + fmtMM(d.D) + ' × ' + fmtMM(d.H) + ' mm';
    $('roVol').textContent = FSG.fmt(a.volume / 1000, 2) + ' cm³';
    var solidG = a.volume / 1000 * 1.24;
    $('roWeight').textContent = FSG.fmt(solidG, 1) + ' g';
    var shell = Math.min(a.volume, a.area * 1.26);
    var est = (shell + (a.volume - shell) * 0.15) / 1000 * 1.24;
    $('roWeight2').textContent = '约 ' + FSG.fmt(est, 1) + ' g';
    $('roWeight2').title = '按 3 层墙(1.26mm) + 15% 填充估算，实际以切片为准';
  }

  function setExportEnabled(on) {
    ['btnSTL', 'btn3MF', 'btnJSON', 'btnTXT', 'btnShot'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = !on;
    });
  }

  /* ---------- 导出 ---------- */
  function centeredMesh(res) {
    var d = res.derived;
    var pos = new Float32Array(res.positions.length);
    for (var i = 0; i < pos.length; i += 3) {
      pos[i] = res.positions[i] - d.W / 2;
      pos[i + 1] = res.positions[i + 1] - d.D / 2;
      pos[i + 2] = res.positions[i + 2];
    }
    return { positions: pos, indices: new Uint32Array(res.indices) };
  }
  function download(data, filename, mime) {
    var blob = (data instanceof Blob) ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 400);
  }
  function exportSTL() {
    if (!result) return;
    var m = centeredMesh(result);
    download(FSG.Export.writeSTL(m), fileBase() + '.stl', 'model/stl');
    toast('已导出 STL：' + fileBase() + '.stl');
  }
  function export3MF() {
    if (!result) return;
    var m = centeredMesh(result);
    download(FSG.Export.write3MF(m, { name: '五级台' }), fileBase() + '.3mf', 'model/3mf');
    toast('已导出 3MF（热床居中）：' + fileBase() + '.3mf');
  }
  function exportJSON() {
    if (!result) return;
    var txt = FSG.Export.writeParamsJSON(result, { source: '五级台生成器', footprintMm: [result.derived.W, result.derived.D, result.derived.H] });
    download(txt, fileBase() + '.json', 'application/json');
    toast('已导出参数 JSON');
  }
  function exportTXT() {
    if (!result) return;
    var a = result.audit, d = result.derived;
    var extra = [
      '网格: ' + a.triangles + ' 面 / ' + a.vertices + ' 顶点 / 水密 ' + (a.watertight ? '是' : '否'),
      '体积: ' + FSG.fmt(a.volume / 1000, 2) + ' cm³，表面积 ' + FSG.fmt(a.area / 100, 1) + ' cm²',
      '打印姿态: 大孔朝上，底面 z=0（3MF 已置于热床中心）'
    ];
    download(FSG.Export.writeParamsTXT(result, extra), fileBase() + '.txt', 'text/plain;charset=utf-8');
    toast('已导出参数 TXT');
  }
  function exportShot() {
    if (!sceneApi) return;
    var url = sceneApi.screenshot();
    var a = document.createElement('a');
    a.href = url;
    a.download = fileBase() + '_视图.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已保存当前视图 PNG');
  }

  /* 供自动化测试读取导出字节（base64），与下载路径共用同一份数据 */
  function toBase64(u8) {
    var CH = 0x8000, out = '';
    for (var i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }
  function exportBytes(kind) {
    if (!result) return null;
    var m = centeredMesh(result);
    var u8 = (kind === '3mf') ? FSG.Export.write3MF(m, { name: '五级台' }) : FSG.Export.writeSTL(m);
    return toBase64(u8);
  }

  /* ---------- 状态 / 视图 ---------- */
  function syncButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#viewGroup button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === state.view);
    });
    var map = {
      tglSection: 'section', tglDims: 'dims', tglPins: 'pins',
      tglWire: 'wire', tglAuto: 'auto'
    };
    Object.keys(map).forEach(function (id) {
      var b = $(id);
      if (b) b.classList.toggle('on', !!state[map[id]]);
    });
    var pb = $('tglPose');
    if (pb) {
      pb.classList.toggle('on', state.pose === 'use');
      pb.textContent = state.pose === 'use' ? '打印姿态' : '使用姿态';
    }
  }

  function setView(name) {
    state.view = name;
    if (sceneApi) sceneApi.setView(name);
    syncButtons();
    updateHash();
  }
  function toggle(key) {
    state[key] = state[key] ? 0 : 1;
    if (key === 'pins' && state.pins && !state.section) {
      state.section = 1;
      if (sceneApi) sceneApi.setState({ section: 1 });
    }
    if (key === 'section' && !state.section) state.pins = 0;
    if (key === 'section' && state.section) state.view = 'section';
    if (key === 'section' && !state.section && state.view === 'section') state.view = 'iso';
    if (sceneApi) {
      sceneApi.setState({ section: state.section, dims: state.dims, pins: state.pins, wire: state.wire, auto: state.auto });
      if (key === 'section') sceneApi.setView(state.view);
    }
    syncButtons();
    updateHash();
  }
  function togglePose() {
    state.pose = (state.pose === 'use') ? 'print' : 'use';
    if (sceneApi) sceneApi.setState({ pose: state.pose });
    syncButtons();
    updateHash();
  }

  function updateHash() {
    if (!history || !history.replaceState) return;
    try {
      history.replaceState(null, '', FSG.hashFromParams(params, state));
    } catch (e) { /* file:// 下个别环境不允许，忽略 */ }
  }

  /* ---------- 键盘 ---------- */
  function onKey(e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === '1') setView('iso');
    else if (k === '2') setView('front');
    else if (k === '3') setView('top');
    else if (k === '4') setView('side');
    else if (k === '5') toggle('section');
    else if (k === 'd') toggle('dims');
    else if (k === 'p') toggle('pins');
    else if (k === 'w') toggle('wire');
    else if (k === 'a') toggle('auto');
    else if (k === 'u') togglePose();
    else if (k === 'r') { setView('iso'); if (sceneApi) sceneApi.frameNow(); }
    else return;
    e.preventDefault();
  }

  /* ---------- 初始化 ---------- */
  function init(opts) {
    params = opts.params;
    state = opts.state;
    onResult = opts.onResult;
    sceneApi = opts.sceneApi;
    buildLevelInputs();
    buildSizeInputs();
    writeInputs();
    syncButtons();
    if (state.ui === 0) {
      var p = $('panel');
      if (p) p.style.display = 'none';
    }
    if (state.freeze) document.documentElement.setAttribute('data-freeze', '1');

    $('btnResetLen').addEventListener('click', function () {
      var ref = FSG.defaults();
      params.L = ref.L.slice();
      params.boreD = ref.boreD.slice();
      params.pinD = ref.pinD.slice();
      params.pinDrop = ref.pinDrop;
      params.boreDepth = ref.boreDepth;
      params.H = ref.H; params.pitch = ref.pitch;
      params.sideMargin = ref.sideMargin; params.rearWall = ref.rearWall;
      params.chamfer = ref.chamfer;
      writeInputs();
      rebuild(false);
      toast('已恢复参考参数');
    });
    $('btnSTL').addEventListener('click', exportSTL);
    $('btn3MF').addEventListener('click', export3MF);
    $('btnJSON').addEventListener('click', exportJSON);
    $('btnTXT').addEventListener('click', exportTXT);
    $('btnShot').addEventListener('click', exportShot);

    Array.prototype.forEach.call(document.querySelectorAll('#viewGroup button'), function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });
    [['tglSection', 'section'], ['tglDims', 'dims'], ['tglPins', 'pins'],
     ['tglWire', 'wire'], ['tglAuto', 'auto']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () { toggle(pair[1]); });
    });
    $('tglPose').addEventListener('click', togglePose);
    window.addEventListener('keydown', onKey);
    syncButtons();
  }

  /* 首帧构建完成后再把 hash 里的视图 / 剖面 / 姿态应用到场景（避免 derived 为空） */
  function applySceneState() {
    if (!sceneApi) return;
    sceneApi.setState({
      section: state.section ? 1 : 0,
      dims: state.dims === undefined ? 1 : (state.dims ? 1 : 0),
      pins: state.pins ? 1 : 0,
      wire: state.wire ? 1 : 0,
      auto: state.auto ? 1 : 0,
      pose: state.pose || 'print'
    });
    if (state.view && state.view !== 'iso') sceneApi.setView(state.view);
    syncButtons();
  }

  function getResult() { return result; }
  function getParams() { return params; }
  function getState() { return state; }
  function setParams(p, opts) {
    params = p;
    writeInputs();
    rebuild(!!(opts && opts.silent));
  }

  return {
    init: init,
    rebuild: rebuild,
    getResult: getResult,
    getParams: getParams,
    getState: getState,
    setParams: setParams,
    setView: setView,
    toggle: toggle,
    togglePose: togglePose,
    applySceneState: applySceneState,
    exportSTL: exportSTL,
    export3MF: export3MF,
    exportBytes: exportBytes,
    toast: toast
  };
})();
