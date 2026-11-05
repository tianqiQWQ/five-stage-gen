/* ============================================================
 * 50-main.js — 启动 / URL 状态 / 对外 API
 * ============================================================ */
'use strict';

(function () {
  var parsed = FSG.paramsFromHash(window.location.hash);
  var params = parsed.params;
  var state = parsed.state;

  var stage = document.getElementById('stage');
  var canvas = document.getElementById('canvas');
  var verEl = document.getElementById('ver');
  if (verEl) verEl.textContent = 'v' + FSG.VERSION;

  if (state.freeze) document.documentElement.setAttribute('data-freeze', '1');

  function fatal(msg) {
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;padding:40px;text-align:center;color:#991b1b;font-size:14px;line-height:1.8';
    box.innerHTML = '无法启动 3D 视图<br><span style="color:#6b7280;font-size:12.5px">' +
      String(msg).replace(/</g, '&lt;') + '</span><br><span style="color:#6b7280;font-size:12.5px">请换用 Chrome / Edge 打开本文件。</span>';
    (stage || document.body).appendChild(box);
    document.documentElement.setAttribute('data-ready', '0');
  }

  try {
    FSG.Scene.init(canvas, stage);
  } catch (e) {
    fatal(e && e.message ? e.message : e);
    return;
  }

  FSG.UI.init({
    params: params,
    state: state,
    sceneApi: FSG.Scene,
    onResult: function (res) { FSG.Scene.update(res); }
  });

  var ok = FSG.UI.rebuild(true);
  FSG.UI.applySceneState();
  document.documentElement.setAttribute('data-ready', ok ? '1' : '0');
  try {
    history.replaceState(null, '', FSG.hashFromParams(FSG.UI.getParams(), FSG.UI.getState()));
  } catch (e) { /* ignore */ }

  function mergeParams(patch) {
    var p = FSG.UI.getParams();
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (k === 'L' || k === 'boreD' || k === 'pinD') p[k] = v.slice();
      else p[k] = v;
    });
  }

  window.__FIVE_STAGE__ = {
    version: FSG.VERSION,
    getParams: function () { return FSG.UI.getParams(); },
    getState: function () { return FSG.UI.getState(); },
    getResult: function () { return FSG.UI.getResult(); },
    getAudit: function () { var r = FSG.UI.getResult(); return r ? r.audit : null; },
    getDerived: function () { var r = FSG.UI.getResult(); return r ? r.derived : null; },
    setParams: function (patch) {
      mergeParams(patch);
      FSG.UI.rebuild(false);
      return FSG.UI.getResult() ? true : false;
    },
    setSizes: function (obj) {
      var p = FSG.UI.getParams();
      Object.keys(obj).forEach(function (k) {
        if (k === 'boreD' || k === 'pinD') p[k] = p[k].map(function () { return obj[k]; });
        else if (k in p) p[k] = obj[k];
      });
      FSG.UI.rebuild(false);
      return FSG.UI.getResult() ? true : false;
    },
    rebuild: function (silent) { return FSG.UI.rebuild(!!silent); },
    setView: function (v) { FSG.UI.setView(v); },
    setSceneState: function (patch) { FSG.Scene.setState(patch); },
    toggle: function (k) { FSG.UI.toggle(k); },
    togglePose: function () { FSG.UI.togglePose(); },
    hash: function () { return FSG.hashFromParams(FSG.UI.getParams(), FSG.UI.getState()); },
    screenshot: function () { return FSG.Scene.screenshot(); },
    exportSTL: function () { FSG.UI.exportSTL(); },
    export3MF: function () { FSG.UI.export3MF(); },
    exportBytes: function (kind) { return FSG.UI.exportBytes(kind); },
    toast: function (m, err) { FSG.UI.toast(m, err); }
  };
  document.documentElement.setAttribute('data-app', 'five-stage');
})();
