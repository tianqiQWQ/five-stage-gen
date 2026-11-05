/* ============================================================
 * 30-scene.js — three.js 场景：零件 / 视图 / 剖面 / 标注 / 示意针
 * 依赖全局 THREE 与 FSG.Geometry
 * ============================================================ */
'use strict';

FSG.Scene = (function () {
  'use strict';
  var T = THREE;

  var hostEl = null, canvasEl = null;
  var renderer = null, scene = null, camera = null, controls = null;
  var pivot = null, inner = null, ground = null, contact = null;
  var part = null, wire = null, cap = null, edges = null, capEdge = null;
  var dimGroup = null, pinGroup = null;
  var matPart = null, matWire = null, matCap = null, matPin = null, matEdge = null, matCapEdge = null;
  var clipPlane = new T.Plane(new T.Vector3(0, 0, -1), 0);
  var state = { view: 'iso', dims: 1, section: 0, pins: 0, pose: 'print', wire: 0, auto: 0 };
  var derived = null, result = null, worldBox = new T.Box3(), fitRadius = 40;
  var tween = null, booted = false;
  var raf = null;

  /* ---------- 工具 ---------- */
  function viewDir(name) {
    var v;
    switch (name) {
      case 'front': v = new T.Vector3(0, -1, 0.12); break;
      case 'top': v = new T.Vector3(0, 0, 1); break;
      case 'side': v = new T.Vector3(1, 0, 0.12); break;
      case 'section': v = new T.Vector3(0.48, -0.72, 1.12); break;
      default: v = new T.Vector3(0.90, -1.12, 1.02); break;
    }
    return v.normalize();
  }
  function viewUp(name) {
    return (name === 'top') ? new T.Vector3(0, 1, 0) : new T.Vector3(0, 0, 1);
  }
  function fitDistance() {
    var w = canvasEl ? canvasEl.clientWidth : 0;
    var h = canvasEl ? canvasEl.clientHeight : 0;
    if (w > 0 && h > 0) camera.aspect = w / h;
    var vHalf = camera.fov * Math.PI / 360;
    var hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.35, camera.aspect));
    var half = Math.min(vHalf, hHalf);
    var dist = fitRadius / Math.sin(half);
    return dist * 1.16;
  }
  function currentTarget() {
    if (worldBox.isEmpty()) return new T.Vector3();
    return worldBox.getCenter(new T.Vector3());
  }

  /* ---------- 初始化 ---------- */
  function init(canvas, host) {
    canvasEl = canvas;
    hostEl = host;
    renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0xe9edf1, 1);
    renderer.shadowMap.enabled = false;
    renderer.localClippingEnabled = true;
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;

    scene = new T.Scene();
    camera = new T.PerspectiveCamera(32, 1, 0.5, 3000);
    camera.up.set(0, 0, 1);
    camera.position.set(120, -150, 140);

    var hemi = new T.HemisphereLight(0xffffff, 0x8e99a4, 0.42);
    scene.add(hemi);
    var key = new T.DirectionalLight(0xfff6e8, 1.30);
    key.position.set(110, -170, 260);
    scene.add(key);
    var fill = new T.DirectionalLight(0xd5e3f2, 0.20);
    fill.position.set(-160, -80, 120);
    scene.add(fill);
    var rim = new T.DirectionalLight(0xffffff, 0.12);
    rim.position.set(40, 200, 160);
    scene.add(rim);

    buildGround();
    buildContactShadow();

    pivot = new T.Group();
    scene.add(pivot);
    inner = new T.Group();
    pivot.add(inner);

    controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.8;
    controls.minDistance = 25;
    controls.maxDistance = 900;
    controls.maxPolarAngle = Math.PI * 0.98;
    controls.autoRotateSpeed = 1.15;
    controls.target.set(0, 0, 10);
    controls.addEventListener('start', function () { tween = null; });

    window.addEventListener('resize', resize);
    if (window.ResizeObserver && hostEl) {
      try { new ResizeObserver(resize).observe(hostEl); } catch (e) { /* ignore */ }
    }
    renderer.domElement.addEventListener('dblclick', function () { setView(state.view, false); });

    resize();
    animate();
    booted = true;
    document.documentElement.setAttribute('data-webgl', 'ok');
  }

  function buildGround() {
    ground = new T.Group();
    var plane = new T.Mesh(
      new T.PlaneGeometry(900, 900),
      new T.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 1, metalness: 0 })
    );
    plane.position.set(0, 0, -0.08);
    ground.add(plane);
    function grid(step, color, opacity) {
      var pts = [];
      for (var i = -200; i <= 200; i += step) {
        pts.push(-200, i, 0, 200, i, 0);
        pts.push(i, -200, 0, i, 200, 0);
      }
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      var m = new T.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false });
      var l = new T.LineSegments(g, m);
      l.position.z = -0.02;
      return l;
    }
    ground.add(grid(10, 0xdfe5ea, 0.75));
    ground.add(grid(50, 0xc9d3db, 0.9));
    scene.add(ground);
  }

  /* 柔性接触阴影：比方向光阴影更干净，俯视图不会出现大块灰斑 */
  function buildContactShadow() {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(128, 128, 8, 128, 128, 126);
    g.addColorStop(0, 'rgba(15,23,42,0.50)');
    g.addColorStop(0.45, 'rgba(15,23,42,0.26)');
    g.addColorStop(1, 'rgba(15,23,42,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    var tex = new T.CanvasTexture(c);
    var mat = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 });
    contact = new T.Mesh(new T.PlaneGeometry(1, 1), mat);
    contact.renderOrder = 1;
    scene.add(contact);
  }

  function resize() {
    if (!renderer || !hostEl) return;
    var w = hostEl.clientWidth, h = hostEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (result && !tween) { /* 保持当前视角 */ }
  }

  function disposeObj(obj) {
    if (!obj) return;
    obj.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    if (obj.parent) obj.parent.remove(obj);
  }
  function clearGroup(g) {
    if (!g) return;
    while (g.children.length) disposeObj(g.children[0]);
  }

  /* ---------- 构建内容 ---------- */
  function buildPart() {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(result.positions, 3));
    g.setIndex(new T.BufferAttribute(result.indices, 1));
    g.computeVertexNormals();
    matPart = new T.MeshStandardMaterial({
      color: 0xc7bfae, roughness: 0.72, metalness: 0.05,
      flatShading: true, clipShadows: true, clippingPlanes: []
    });
    part = new T.Mesh(g, matPart);
    part.castShadow = true;
    part.receiveShadow = true;
    inner.add(part);

    /* 描边：倒角棱 / 孔口 / 外轮廓；圆柱面分段角很小，不会被描出 */
    matEdge = new T.LineBasicMaterial({
      color: 0x9a907e, transparent: true, opacity: 0.62, depthWrite: false, clippingPlanes: []
    });
    edges = new T.LineSegments(new T.EdgesGeometry(g, 24), matEdge);
    edges.renderOrder = 4;
    inner.add(edges);

    var wg = new T.BufferGeometry();
    wg.setAttribute('position', new T.BufferAttribute(result.positions.slice(0), 3));
    wg.setIndex(new T.BufferAttribute(result.indices.slice(0), 1));
    matWire = new T.MeshBasicMaterial({
      color: 0x64748b, wireframe: true, transparent: true, opacity: 0.16,
      depthWrite: false, clippingPlanes: []
    });
    wire = new T.Mesh(wg, matWire);
    wire.renderOrder = 5;
    inner.add(wire);
  }

  function buildCap() {
    var m = FSG.Geometry.sectionCapMesh(derived.params);
    if (!m) return;
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(m.positions, 3));
    g.setIndex(new T.BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    matCap = new T.MeshStandardMaterial({
      color: 0xe4a244, roughness: 0.82, metalness: 0.02,
      flatShading: true, side: T.DoubleSide
    });
    cap = new T.Mesh(g, matCap);
    cap.position.z = 0.004;
    cap.renderOrder = 2;
    inner.add(cap);
    matCapEdge = new T.LineBasicMaterial({
      color: 0x8a5f1e, transparent: true, opacity: 0.75, depthWrite: false
    });
    capEdge = new T.LineSegments(new T.EdgesGeometry(g, 18), matCapEdge);
    capEdge.position.z = 0.008;
    capEdge.renderOrder = 3;
    inner.add(capEdge);
  }

  function makeLabel(text, colorCss) {
    var c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);
    var r = 26;
    ctx.beginPath();
    ctx.moveTo(16 + r, 18);
    ctx.arcTo(240, 18, 240, 110, r);
    ctx.arcTo(240, 110, 16, 110, r);
    ctx.arcTo(16, 110, 16, 18, r);
    ctx.arcTo(16, 18, 240, 18, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = colorCss;
    ctx.stroke();
    ctx.fillStyle = colorCss;
    ctx.font = '700 62px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 68);
    var tex = new T.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.encoding = T.sRGBEncoding;
    var mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    var spr = new T.Sprite(mat);
    spr.scale.set(6.8, 3.4, 1);
    spr.renderOrder = 30;
    return spr;
  }

  function buildDims() {
    if (dimGroup) { disposeObj(dimGroup); dimGroup = null; }
    dimGroup = new T.Group();
    var zDim = state.section ? (derived.zPin + 0.18) : (derived.H + 0.18);
    var tick = 1.15;
    for (var i = 0; i < derived.levels.length; i++) {
      var lv = derived.levels[i];
      var css = FSG.LEVEL_COLORS[i % FSG.LEVEL_COLORS.length];
      var pts = [
        lv.x, 0.0, zDim, lv.x, lv.L, zDim,
        lv.x - tick, 0.0, zDim, lv.x + tick, 0.0, zDim,
        lv.x - tick, lv.L, zDim, lv.x + tick, lv.L, zDim
      ];
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
      var m = new T.LineBasicMaterial({ color: new T.Color(css), transparent: true, opacity: 0.96, depthTest: false, depthWrite: false });
      var line = new T.LineSegments(g, m);
      line.renderOrder = 25;
      dimGroup.add(line);
      var spr = makeLabel(FSG.fmt(lv.L, 1), css);
      spr.position.set(lv.x, lv.L + 2.9, zDim + 0.7);
      dimGroup.add(spr);
    }
    inner.add(dimGroup);
    dimGroup.visible = !!state.dims;
  }

  function buildPins() {
    if (pinGroup) { disposeObj(pinGroup); pinGroup = null; }
    pinGroup = new T.Group();
    if (matPin) matPin.dispose();
    matPin = new T.MeshStandardMaterial({ color: 0x49535f, metalness: 0.72, roughness: 0.30 });
    for (var i = 0; i < derived.levels.length; i++) {
      var lv = derived.levels[i];
      var len = lv.L + 9;
      var shaft = new T.Mesh(new T.CylinderGeometry(0.24, 0.20, len, 10, 1), matPin);
      shaft.position.set(lv.x, (lv.L - 9) / 2, derived.zPin);
      shaft.castShadow = false;
      pinGroup.add(shaft);
      var head = new T.Mesh(new T.SphereGeometry(0.85, 12, 10), matPin);
      head.position.set(lv.x, -9.2, derived.zPin);
      pinGroup.add(head);
    }
    inner.add(pinGroup);
    pinGroup.visible = !!(state.pins && state.section);
  }

  /* ---------- 姿态 / 裁剪 / 目标 ---------- */
  function updateClipPlane() {
    if (!derived) return;
    var n = new T.Vector3(0, 0, -1).transformDirection(inner.matrixWorld).normalize();
    var p = new T.Vector3(derived.W / 2, derived.D / 2, derived.zPin).applyMatrix4(inner.matrixWorld);
    clipPlane.setFromNormalAndCoplanarPoint(n, p);
  }

  function applyPose(recenter) {
    if (!derived) return;
    var angle = (state.pose === 'use') ? -Math.PI / 2 : 0;
    pivot.rotation.x = angle;
    pivot.position.set(derived.W / 2, derived.D / 2, derived.H / 2);
    inner.position.set(-derived.W / 2, -derived.D / 2, -derived.H / 2);
    pivot.updateMatrixWorld(true);
    if (part) {
      var box = worldBox.setFromObject(part);
      if (!box.isEmpty()) {
        pivot.position.z += (0 - box.min.z);
        pivot.updateMatrixWorld(true);
        worldBox.setFromObject(part);
        fitRadius = Math.max(6, worldBox.getSize(new T.Vector3()).length() / 2);
      }
    }
    updateClipPlane();
    if (contact && !worldBox.isEmpty()) {
      var ctr = worldBox.getCenter(new T.Vector3());
      var sz = worldBox.getSize(new T.Vector3());
      contact.position.set(ctr.x, ctr.y, 0.02);
      contact.scale.set(Math.max(4, sz.x * 1.55), Math.max(4, sz.y * 1.55), 1);
    }
    if (recenter) {
      controls.target.copy(currentTarget());
      controls.update();
    }
  }

  /* ---------- 视图 ---------- */
  function setView(name, instant) {
    state.view = name;
    var dir = viewDir(name);
    var up = viewUp(name);
    var target = currentTarget();
    var dist = fitDistance();
    var pos = target.clone().addScaledVector(dir, dist);
    if (instant) {
      tween = null;
      camera.up.copy(up);
      camera.position.copy(pos);
      controls.target.copy(target);
      controls.update();
      return;
    }
    tween = {
      p0: camera.position.clone(), p1: pos,
      t0: controls.target.clone(), t1: target,
      u0: camera.up.clone(), u1: up,
      start: performance.now(), dur: 560
    };
  }

  function frameNow() {
    tween = null;
    controls.target.copy(currentTarget());
    camera.position.copy(currentTarget().addScaledVector(viewDir(state.view), fitDistance()));
    camera.up.copy(viewUp(state.view));
    controls.update();
  }

  /* ---------- 动画 ---------- */
  function animate() {
    renderer.setAnimationLoop(function () {
      var now = performance.now();
      if (tween) {
        var k = Math.min(1, (now - tween.start) / tween.dur);
        var e = 1 - Math.pow(1 - k, 3);
        camera.position.lerpVectors(tween.p0, tween.p1, e);
        controls.target.lerpVectors(tween.t0, tween.t1, e);
        camera.up.lerpVectors(tween.u0, tween.u1, e).normalize();
        if (k >= 1) tween = null;
      }
      controls.autoRotate = !!state.auto && !tween;
      controls.update();
      renderer.render(scene, camera);
    });
  }

  /* ---------- 对外 ---------- */
  function update(res) {
    result = res;
    derived = res.derived;
    clearGroup(inner);
    part = wire = cap = edges = null;
    capEdge = null;
    matPart = null; matWire = null; matCap = null; matEdge = null; matCapEdge = null;
    dimGroup = pinGroup = null;

    buildPart();
    buildCap();
    applyPose(false);
    buildDims();
    buildPins();
    applyState();
    if (!booted) booted = true;

    if (!state.__framed) {
      state.__framed = true;
      fitRadius = Math.max(6, worldBox.getSize(new T.Vector3()).length() / 2);
      if (document.documentElement.getAttribute('data-freeze') === '1') {
        frameNow();
      } else {
        var target = currentTarget();
        var dir = viewDir(state.view);
        camera.up.copy(viewUp(state.view));
        camera.position.copy(target.clone().addScaledVector(dir, fitDistance() * 1.28).add(new T.Vector3(0, 0, fitRadius * 0.5)));
        controls.target.copy(target);
        tween = {
          p0: camera.position.clone(),
          p1: target.clone().addScaledVector(dir, fitDistance()),
          t0: target.clone(), t1: target.clone(),
          u0: camera.up.clone(), u1: viewUp(state.view),
          start: performance.now(), dur: 900
        };
      }
    } else {
      controls.target.copy(currentTarget());
    }
    document.documentElement.setAttribute('data-tris', String(res.audit.triangles));
  }

  function applyState() {
    if (matPart) matPart.clippingPlanes = state.section ? [clipPlane] : [];
    if (matWire) matWire.clippingPlanes = state.section ? [clipPlane] : [];
    if (matEdge) matEdge.clippingPlanes = state.section ? [clipPlane] : [];
    if (cap) cap.visible = !!state.section;
    if (capEdge) capEdge.visible = !!state.section;
    if (dimGroup) dimGroup.visible = !!state.dims;
    if (pinGroup) pinGroup.visible = !!(state.pins && state.section);
    if (wire) wire.visible = !!state.wire;
  }

  function setState(patch) {
    var needDims = false;
    if (patch && patch.section !== undefined && !!patch.section !== !!state.section) needDims = true;
    Object.keys(patch || {}).forEach(function (k) {
      if (k in state) state[k] = patch[k];
    });
    if (patch && patch.pose !== undefined) {
      if (derived) {
        applyPose(false);
        setView(state.view);
      }
    }
    if (needDims && derived) buildDims();
    applyState();
  }

  function getState() { return Object.assign({}, state); }
  function screenshot() {
    if (tween) { /* 让当前帧定格 */ tween = null; }
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  }

  return {
    init: init,
    update: update,
    setState: setState,
    getState: getState,
    setView: setView,
    frameNow: frameNow,
    screenshot: screenshot,
    resize: resize,
    clipPlane: clipPlane
  };
})();
