#!/usr/bin/env node
/* tools/e2e.mjs — headless Chrome 端到端验收（CDP，无第三方依赖）
 *
 *   & $NODE tools/e2e.mjs
 *   & $NODE tools/e2e.mjs --html 五级台生成器.html --out tools/out
 *
 * 覆盖：启动 / 默认几何 / 导出 STL+3MF / 改参数 / 非法参数 / 恢复参考值 /
 *       DOM 输入联动 / 剖面 / 示意针 / 使用姿态 / 视图切换 / 真实下载 / 移动端布局
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

let pass = 0, fail = 0;
const failures = [];
const results = [];
function ok(name, cond, info) {
  results.push({ name, ok: !!cond, info: info === undefined ? null : String(info) });
  if (cond) { pass++; console.log('  ✓ ' + name + (info !== undefined ? '  [' + info + ']' : '')); return true; }
  fail++; failures.push(name);
  console.log('  ✗ ' + name + (info !== undefined ? '  [' + info + ']' : ''));
  return false;
}
function near(a, b, tol, name) { return ok(name, Math.abs(a - b) <= tol, a + ' vs ' + b + ' ±' + tol); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const o = { html: join(ROOT, '五级台生成器.html'), out: join(ROOT, 'tools', 'out'), port: 9433, headless: true };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--html') o.html = resolve(a[++i]);
    else if (a[i] === '--out') o.out = resolve(a[++i]);
    else if (a[i] === '--port') o.port = Number(a[++i]);
    else if (a[i] === '--headed') o.headless = false;
  }
  return o;
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('Chrome/Edge not found');
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

async function main() {
  const o = parseArgs();
  if (!existsSync(o.html)) throw new Error('HTML not found: ' + o.html);
  mkdirSync(o.out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'fsg-e2e-'));
  const downloads = mkdtempSync(join(tmpdir(), 'fsg-dl-'));
  const chrome = findChrome();
  const pageUrl = pathToFileURL(o.html).href + '#freeze=1';
  const args = [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter',
    '--disable-breakpad', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--metrics-recording-only', '--mute-audio', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1440,900', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + o.port,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    pageUrl
  ];
  console.log('chrome:', chrome);
  console.log('page  :', pageUrl);
  const proc = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
  let ws = null;
  try {
    /* 等浏览器调试端口 */
    let version = null;
    for (let i = 0; i < 80; i++) {
      try {
        version = await getJson('http://127.0.0.1:' + o.port + '/json/version');
        if (version) break;
      } catch (e) { /* retry */ }
      await sleep(250);
    }
    ok('Chrome 调试端口可用', !!version, version && version.Browser);
    if (!version) throw new Error('no devtools endpoint');

    let target = null;
    for (let i = 0; i < 80; i++) {
      const list = await getJson('http://127.0.0.1:' + o.port + '/json/list');
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (target) break;
      await sleep(250);
    }
    ok('页面目标已创建', !!target, target && basename(decodeURIComponent(target.url.split('#')[0])));
    if (!target) throw new Error('no page target');

    ws = await connect(target.webSocketDebuggerUrl);
    ok('CDP WebSocket 已连接', true);

    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    const exceptions = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.text + ' ' + ((msg.params.exceptionDetails.exception || {}).description || ''));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    };
    function send(method, params) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    }
    async function ev(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    }
    async function shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const p = join(o.out, name);
      writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    }
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable').catch(() => {});
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => {});

    /* 等应用就绪 */
    let booted = false;
    for (let i = 0; i < 80; i++) {
      try {
        booted = await ev("document.documentElement.getAttribute('data-ready') === '1'");
        if (booted) break;
      } catch (e) { /* retry */ }
      await sleep(250);
    }
    ok('应用启动 data-ready=1', booted);
    ok('WebGL 标记 ok', (await ev("document.documentElement.getAttribute('data-webgl')")) === 'ok');
    const appVer = await ev('window.__FIVE_STAGE__ && window.__FIVE_STAGE__.version');
    ok('对外 API 存在', !!appVer, appVer);

    /* ---------- 默认几何 ---------- */
    const d0 = await ev('(()=>{const d=__FIVE_STAGE__.getDerived();return {W:d.W,D:d.D,H:d.H,L:d.levels.map(l=>l.L),yc:d.levels.map(l=>l.yc),zPin:d.zPin};})()');
    near(d0.W, 60, 1e-9, '默认外形 W=60');
    near(d0.D, 40, 1e-9, '默认外形 D=40');
    near(d0.H, 20, 1e-9, '默认外形 H=20');
    ok('默认 5 级长度 28/24/19/17/15', d0.L.join(',') === '28,24,19,17,15', d0.L.join(','));
    ok('大孔圆心 = L − R', d0.yc.join(',') === '24,20,15,13,11', d0.yc.join(','));
    near(d0.zPin, 16, 1e-9, '针孔轴 z=16');

    const a0 = await ev('(()=>{const a=__FIVE_STAGE__.getAudit();return {tris:a.triangles,volume:a.volume,watertight:a.watertight,open:a.openEdges,components:a.components,bboxMax:a.bboxMax};})()');
    ok('网格水密', a0.watertight && a0.open === 0, 'open=' + a0.open);
    ok('单一连通域', a0.components === 1, a0.components);
    ok('三角面数量合理', a0.tris > 1500 && a0.tris < 40000, a0.tris);
    near(a0.volume, 45176.6, 3, '默认体积 ≈ 45176.6 mm³');
    near(a0.bboxMax[2], 20, 1e-6, '网格 z 上限 20');
    ok('data-watertight=1', (await ev("document.documentElement.getAttribute('data-watertight')")) === '1');

    /* ---------- 导出 ---------- */
    const stlCheck = await ev(`(()=>{
      const b=__FIVE_STAGE__.exportBytes('stl');
      const u8=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
      const p=FSG.Export.parseSTL(u8);
      const a=__FIVE_STAGE__.getAudit();
      return {bytes:u8.length, tris:p.triangles, auditTris:a.triangles, min:p.min, max:p.max};
    })()`);
    ok('STL 导出字节数 > 100KB', stlCheck.bytes > 100000, stlCheck.bytes);
    ok('STL 面数与网格一致', stlCheck.tris === stlCheck.auditTris, stlCheck.tris + '/' + stlCheck.auditTris);
    near(stlCheck.max[0] - stlCheck.min[0], 60, 1e-3, 'STL 宽 60（XY 居中）');
    near(stlCheck.min[0], -30, 1e-3, 'STL X 居中');
    near(stlCheck.min[2], 0, 1e-6, 'STL 底面 z=0');

    const mf3 = await ev(`(()=>{
      const b=__FIVE_STAGE__.exportBytes('3mf');
      const u8=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
      const files=FSG.Export.unzipStore(u8);
      const model=new TextDecoder().decode(files['3D/3dmodel.model']);
      const a=__FIVE_STAGE__.getAudit();
      return {bytes:u8.length, hasModel:!!files['3D/3dmodel.model'], hasCT:!!files['[Content_Types].xml'],
        verts:(model.match(/<vertex /g)||[]).length, tris:(model.match(/<triangle /g)||[]).length,
        auditV:a.vertices, auditT:a.triangles,
        center:/transform="1 0 0 0 1 0 0 0 1 128 128 0"/.test(model), unit:/unit="millimeter"/.test(model)};
    })()`);
    ok('3MF 包含 model + Content_Types', mf3.hasModel && mf3.hasCT);
    ok('3MF 顶点数一致', mf3.verts === mf3.auditV, mf3.verts + '/' + mf3.auditV);
    ok('3MF 三角数一致', mf3.tris === mf3.auditT, mf3.tris + '/' + mf3.auditT);
    ok('3MF 热床居中 (128,128,0)', mf3.center);
    ok('3MF 单位 mm', mf3.unit);
    ok('3MF 体积合理', mf3.bytes > 100000, mf3.bytes);

    /* 真实下载（点击按钮） */
    await ev("document.getElementById('btn3MF').click()");
    await sleep(1200);
    let dl = [];
    try { dl = readdirSync(downloads); } catch (e) { dl = []; }
    ok('点击“导出 3MF”触发真实下载', dl.some((f) => f.endsWith('.3mf')), dl.join(', '));

    await ev("document.getElementById('btnJSON').click()");
    await sleep(900);
    try { dl = readdirSync(downloads); } catch (e) { dl = []; }
    ok('点击“参数 JSON”触发真实下载', dl.some((f) => f.endsWith('.json')), dl.filter((f) => f.endsWith('.json')).join(', '));
    const jsonFile = dl.find((f) => f.endsWith('.json'));
    if (jsonFile) {
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(join(downloads, jsonFile), 'utf8')); } catch (e) { parsed = null; }
      ok('参数 JSON 可解析且含参数/网格', !!parsed && !!parsed.params && !!parsed.derived && !!parsed.mesh,
        parsed ? Object.keys(parsed).join(',') : 'parse fail');
    } else { ok('参数 JSON 可解析且含参数/网格', false, 'no file'); }

    await ev("document.getElementById('btnTXT').click()");
    await sleep(900);
    try { dl = readdirSync(downloads); } catch (e) { dl = []; }
    ok('点击“参数 TXT”触发真实下载', dl.some((f) => f.endsWith('.txt')), dl.filter((f) => f.endsWith('.txt')).join(', '));

    await ev("document.getElementById('btnShot').click()");
    await sleep(1400);
    try { dl = readdirSync(downloads); } catch (e) { dl = []; }
    ok('点击“截图”下载 PNG', dl.some((f) => f.endsWith('.png')), dl.filter((f) => f.endsWith('.png')).join(', '));

    /* ---------- DOM 输入联动 ---------- */
    const typed = await ev(`(()=>{
      const inp=document.querySelector('#levels input');
      inp.value='30'; inp.dispatchEvent(new Event('input',{bubbles:true}));
      return inp.value;
    })()`);
    await sleep(400);
    const d1 = await ev(`(()=>{const d=__FIVE_STAGE__.getDerived();return {L:d.levels.map(l=>l.L),D:d.D,water:document.documentElement.getAttribute('data-watertight')};})()`);
    near(d1.L[0], 30, 1e-9, '面板输入 30 生效（第 1 级）');
    near(d1.D, 42, 1e-9, '外形深度自动变为 42');
    ok('改参数后仍水密', d1.water === '1');
    await shot('e2e-edit-30.png');

    const inval = await ev(`(()=>{
      const inp=document.querySelector('#levels input');
      inp.value='5'; inp.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await sleep(400);
    const bad = await ev(`(()=>({
      water: document.documentElement.getAttribute('data-watertight'),
      disabled: document.getElementById('btnSTL').disabled,
      msgs: document.querySelectorAll('#msgs li.err').length,
      msg: (document.querySelector('#msgs li.err')||{}).textContent||''
    }))()`);
    ok('非法长度被拦截（不水密）', bad.water === '0');
    ok('非法参数禁用导出', bad.disabled === true);
    ok('显示红色错误提示', bad.msgs > 0, bad.msg.slice(0, 40));

    await ev("document.getElementById('btnResetLen').click()");
    await sleep(400);
    const reset = await ev(`(()=>({L:__FIVE_STAGE__.getDerived().levels.map(l=>l.L), disabled:document.getElementById('btnSTL').disabled}))()`);
    ok('恢复参考值 L1=28', reset.L[0] === 28, reset.L.join(','));
    ok('恢复后导出重新可用', reset.disabled === false);

    /* ---------- 视图 / 剖面 / 示意针 / 姿态 ---------- */
    await ev("document.getElementById('tglSection').click()");
    await sleep(700);
    const sc = await ev('(()=>{const s=__FIVE_STAGE__.getState();return {section:s.section,view:s.view};})()');
    ok('剖面开关生效', sc.section === 1, JSON.stringify(sc));
    await shot('e2e-section.png');

    await ev("document.getElementById('tglPins').click()");
    await sleep(500);
    ok('示意针开启（并自动保持剖面）', (await ev('__FIVE_STAGE__.getState().pins')) === 1);
    await shot('e2e-section-pins.png');

    await ev("document.getElementById('tglSection').click()");
    await sleep(500);
    ok('关闭剖面后示意针自动关闭', (await ev('__FIVE_STAGE__.getState().pins')) === 0);

    await ev("document.getElementById('tglPose').click()");
    await sleep(900);
    ok('切换使用姿态', (await ev('__FIVE_STAGE__.getState().pose')) === 'use');
    await shot('e2e-use-pose.png');
    await ev("document.getElementById('tglPose').click()");
    await sleep(700);

    await ev("document.querySelectorAll('#viewGroup button')[2].click()");
    await sleep(700);
    ok('切到俯视', (await ev('__FIVE_STAGE__.getState().view')) === 'top');
    await shot('e2e-top.png');
    await ev("document.querySelectorAll('#viewGroup button')[0].click()");
    await sleep(700);

    /* DOM 结构 / 文案 */
    const dom = await ev(`(()=>({
      levels: document.querySelectorAll('#levels .lv').length,
      sizeInputs: document.querySelectorAll('#sizes input').length,
      title: document.title,
      panelW: document.getElementById('panel').getBoundingClientRect().width,
      stageH: document.getElementById('stage').getBoundingClientRect().height,
      status: document.getElementById('stText').textContent,
      weight: document.getElementById('roWeight2').textContent,
      sizeText: document.getElementById('roSize').textContent
    }))()`);
    ok('5 个长度输入', dom.levels === 5);
    ok('9 个常用尺寸输入', dom.sizeInputs === 9, dom.sizeInputs);
    ok('面板标题正确', dom.title.includes('五级台生成器'), dom.title);
    ok('状态显示水密', dom.status.includes('水密'), dom.status);
    ok('外形读数 60 × 40 × 20', dom.sizeText.includes('60') && dom.sizeText.includes('40') && dom.sizeText.includes('20'), dom.sizeText);
    ok('重量估算已显示', /约 [\d.]+ g/.test(dom.weight), dom.weight);

    /* 1440 截图 */
    await ev("document.getElementById('tglDims') && null");
    await shot('e2e-desktop.png');

    /* ---------- 移动端布局 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(900);
    const mob = await ev(`(()=>{
      const p=document.getElementById('panel').getBoundingClientRect();
      const s=document.getElementById('stage').getBoundingClientRect();
      return {w:innerWidth, panelW:Math.round(p.width), panelTop:Math.round(p.top), stageH:Math.round(s.height), scrollX:document.documentElement.scrollWidth};
    })()`);
    ok('移动端视口 390', mob.w === 390, mob.w);
    ok('移动端面板全宽', Math.abs(mob.panelW - 390) < 2, mob.panelW);
    ok('移动端画布高度 ≥ 300', mob.stageH >= 300, mob.stageH);
    ok('移动端无横向溢出', mob.scrollX <= 391, mob.scrollX);
    const tb = await ev(`(()=>{const r=document.getElementById('toolbar').getBoundingClientRect();
      return {l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width)};})()`);
    ok('移动端工具栏在视口内', tb.l >= -1 && tb.r <= 391, JSON.stringify(tb));
    await shot('e2e-mobile.png');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);

    /* ---------- 控制台 ---------- */
    ok('无页面异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
    ok('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

    /* 报告 */
    const report = {
      generatedAt: new Date().toISOString(),
      html: o.html,
      browser: version.Browser,
      pass, fail, results,
      screenshots: ['e2e-desktop.png', 'e2e-edit-30.png', 'e2e-section.png', 'e2e-section-pins.png', 'e2e-use-pose.png', 'e2e-top.png', 'e2e-mobile.png']
    };
    writeFileSync(join(o.out, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log('\n========================================');
    console.log(fail ? 'E2E FAILED: ' + fail + ' / ' + (pass + fail) : 'E2E OK: ' + pass + ' / ' + (pass + fail) + ' 全部通过');
    if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
    process.exitCode = fail ? 1 : 0;
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    try { proc.kill(); } catch (e) { /* ignore */ }
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    try { rmSync(downloads, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('ws timeout')), 15000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('ws error')); };
  });
}

main().catch((e) => {
  console.error('\nE2E CRASHED: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
