#!/usr/bin/env node
// tools/shot.mjs — headless-Chrome screenshot + DOM harness for camera-prop-3d.
//
// The single-file build inlines every asset, so a plain file:// URL is enough.
// Screenshots default to software WebGL (ANGLE/SwiftShader), which is what a
// headless box without a GPU uses. Use --gl hardware to try the physical GPU.
//
// Examples:
//   node tools/shot.mjs --html camera-prop.html --out tools/out/front.png --hash "view=front"
//   node tools/shot.mjs --html camera-prop.html --out tools/out/explode.png --hash "view=front&explode=0.5"
//   node tools/shot.mjs --html camera-prop.html --out tools/out/shot.png \
//        --dom tools/out/shot.dom.html --expect "WEBGL_OK"
//   node tools/shot.mjs --html tools/fixture/index.html --out tools/out/fixture.png \
//        --dom tools/out/fixture.dom.html --expect "WEBGL_OK webgl2="
//
// Exit code 0 only when the PNG exists and parses (and, with --expect, the DOM
// dump contains the marker). Output is redirected to log FILES (not pipes):
// piped stdio on Windows uses named pipes, which the DSH sandbox denies.

import { spawn, spawnSync } from 'node:child_process';
import {
  openSync, closeSync, readFileSync, existsSync, mkdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // camera-prop-3d/

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const DEFAULTS = {
  w: 1400,
  h: 1000,
  wait: 4000,
  timeout: 60000,
  gl: 'swiftshader',
  repeat: 1,
  out: join(ROOT, 'tools', 'out', 'shot.png'),
  dom: null,
  expect: null,
  browser: null,
  'keep-profile': false,
  'dry-run': false,
  'profile-root': join(ROOT, 'tools', '.chrome-profile'),
};

function usage() {
  return `Usage: node tools/shot.mjs --html <file|url> [options]

Required:
  --html <path|url>   HTML to render (a plain file path is converted to file://)

Options:
  --out <path>        PNG output path (default: tools/out/shot.png)
  --w <px>            Viewport width  (default: 1400)
  --h <px>            Viewport height (default: 1000)
  --wait <ms>         Chrome --virtual-time-budget in ms (default: 4000)
  --hash <str>        URL #fragment to append, e.g. "view=front&explode=0.5"
  --dom <path>        Also run a --dump-dom pass and write the DOM here
  --expect <str>      Assert this substring appears in the --dom output
  --gl <mode>         swiftshader (default) | hardware | auto
  --timeout <ms>      Hard timeout per Chrome run (default: 60000)
  --repeat <n>        Render the screenshot n times and report each timing
  --browser <path>    Explicit Chrome/Edge executable
  --profile-root <d>  Where throw-away Chrome profiles live (default: tools/.chrome-profile)
  --keep-profile      Keep Chrome profile dirs (debugging)
  --dry-run           Print the exact Chrome commands and exit without launching it
  -h, --help          Show this help

Environment: CHROME_PATH / EDGE_PATH override browser detection.
`;
}

function fail(msg) {
  console.error(`\nSHOT FAILED: ${msg}\n`);
  process.exit(1);
}

function intArg(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`${name} expects a positive integer, got "${v}"`);
  return n;
}

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--html': o.html = next(); break;
      case '--out': o.out = resolve(next()); break;
      case '--w': o.w = intArg(a, next()); break;
      case '--h': o.h = intArg(a, next()); break;
      case '--wait': o.wait = intArg(a, next()); break;
      case '--hash': o.hash = next().replace(/^#/, ''); break;
      case '--dom': o.dom = resolve(next()); break;
      case '--dom-out': o.dom = resolve(next()); break;
      case '--expect': o.expect = next(); break;
      case '--gl': o.gl = next(); break;
      case '--timeout': o.timeout = intArg(a, next()); break;
      case '--repeat': o.repeat = intArg(a, next()); break;
      case '--browser': o.browser = resolve(next()); break;
      case '--profile-root': o['profile-root'] = resolve(next()); break;
      case '--keep-profile': o['keep-profile'] = true; break;
      case '--dry-run': o['dry-run'] = true; break;
      case '-h':
      case '--help': console.log(usage()); process.exit(0); break;
      default: fail(`unknown option: ${a}\n\n${usage()}`);
    }
  }
  if (!o.html) fail(`--html is required\n\n${usage()}`);
  if (!['swiftshader', 'hardware', 'auto'].includes(o.gl)) fail(`--gl must be swiftshader|hardware|auto (got ${o.gl})`);
  return o;
}

function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) fail(`--browser not found: ${explicit}`);
    return explicit;
  }
  for (const envKey of ['CHROME_PATH', 'EDGE_PATH']) {
    const p = process.env[envKey];
    if (p && existsSync(p)) return p;
  }
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

function resolveHtmlUrl(input) {
  // Leave explicit URL schemes (http:, https:, file:, data:) untouched; a Windows
  // drive path like C:\... also matches the scheme regex, so exclude drive letters.
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) return input;
  const candidates = [...new Set([resolve(input), resolve(ROOT, input), resolve(process.cwd(), input)])];
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail(`HTML not found: ${input}\n  tried: ${candidates.join(', ')}`);
  return pathToFileURL(found).href;
}

function quoteArg(a) {
  if (a === '') return '""';
  if (/^[A-Za-z0-9_/:=.,\\-]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

function shellLine(exe, args) {
  return [quoteArg(exe), ...args.map(quoteArg)].join(' ');
}

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function parsePngInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 24) return { valid: false, reason: 'file too small' };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return { valid: false, reason: 'bad PNG signature' };
  const type = buf.toString('ascii', 12, 16);
  return {
    valid: type === 'IHDR',
    type,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
  };
}

function readTail(file, maxLines = 60, maxBytes = 64 * 1024) {
  try {
    const buf = readFileSync(file);
    const text = buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

const SANDBOX_SIGNATURES = [
  /platform_channel/i,
  /mojo/i,
  /named pipe/i,
  /拒绝访问/,
  /Access is denied/i,
  /\(0x5\)/,
  /EPERM/,
  /OpenProcess/i,
];

function isSandboxBlock(lines) {
  const joined = lines.join('\n');
  return SANDBOX_SIGNATURES.some((re) => re.test(joined));
}

function summarizeChromeFailure(lines) {
  const interesting = lines.filter((l) => /FATAL|ERROR|WARN|denied|failed/i.test(l));
  const shown = (interesting.length ? interesting : lines).slice(-12);
  if (!shown.length) return;
  console.error('  --- Chrome stderr (tail) ---');
  for (const line of shown) console.error(`  | ${line}`);
}

function killTree(pid) {
  try { process.kill(pid); } catch { /* ignore */ }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 5000,
      });
    } catch { /* ignore */ }
  }
}

function chromeArgs(o, profileDir, url, mode) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${o.w},${o.h}`,
    `--user-data-dir=${profileDir}`,
    `--virtual-time-budget=${o.wait}`,
  ];
  if (mode === 'screenshot') args.push('--run-all-compositor-stages-before-draw');
  if (o.gl === 'swiftshader') {
    args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  } else if (o.gl === 'hardware') {
    args.push('--enable-gpu');
  }
  if (mode === 'screenshot') args.push(`--screenshot=${o.out}`);
  else args.push('--dump-dom');
  args.push(url); // URL last: everything after a bare file:// argument could be read as a positional
  return args;
}

/**
 * One Chrome pass. stdio goes to regular files: piped stdio on Windows is
 * implemented with named pipes, which the DSH sandbox blocks (EPERM).
 * Resolves { code, signal, elapsedMs, timedOut, error?, stdoutFile, stderrFile }.
 */
function runChrome(exe, cmdArgs, timeoutMs, profileDir, label) {
  const stdoutFile = join(profileDir, `${label}.stdout.log`);
  const stderrFile = join(profileDir, `${label}.stderr.log`);
  ensureDir(stdoutFile);
  const outFd = openSync(stdoutFile, 'w');
  const errFd = openSync(stderrFile, 'w');
  const t0 = Date.now();

  return new Promise((resolvePromise) => {
    let proc;
    try {
      proc = spawn(exe, cmdArgs, { stdio: ['ignore', outFd, errFd], windowsHide: true });
    } finally {
      try { closeSync(outFd); } catch { /* ignore */ }
      try { closeSync(errFd); } catch { /* ignore */ }
    }
    if (!proc || proc.pid === undefined) {
      resolvePromise({ error: new Error('spawn failed'), elapsedMs: Date.now() - t0, timedOut: false, stdoutFile, stderrFile });
      return;
    }
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, elapsedMs: Date.now() - t0, stdoutFile, stderrFile, profileDir });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`  [timeout] ${label}: Chrome still running after ${timeoutMs} ms — killing pid ${proc.pid}`);
      killTree(proc.pid);
    }, timeoutMs);
    proc.on('error', (err) => finish({ error: err, timedOut }));
    proc.on('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

function extractStatus(domText) {
  const m = /id=["']status["'][^>]*>([\s\S]{0,500}?)<\/div>/i.exec(domText);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function removeQuietly(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ignore */ }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const exe = findBrowser(o.browser);
  if (!exe) {
    fail(`no Chrome/Edge found. Looked for:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet --browser or CHROME_PATH.`);
  }

  const urlBase = resolveHtmlUrl(o.html);
  const url = o.hash ? `${urlBase}#${o.hash.replace(/ /g, '%20')}` : urlBase;

  const browserName = basename(exe);
  console.log('camera-prop-3d — headless screenshot');
  console.log(`  browser   : ${exe}`);
  console.log(`  url       : ${url}`);
  console.log(`  viewport  : ${o.w}x${o.h}   virtual-time-budget: ${o.wait} ms   gl: ${o.gl}`);
  console.log(`  output    : ${o.out}`);
  if (o.dom) console.log(`  dom       : ${o.dom}${o.expect ? `   expect: "${o.expect}"` : ''}`);
  console.log('');

  const profileRoot = o['profile-root'];
  const stamp = `${process.pid}-${Date.now()}`;
  const shotProfile = join(profileRoot, `shot-${stamp}`);
  const shotArgs = chromeArgs(o, shotProfile, url, 'screenshot');
  console.log('  command:');
  console.log(`  ${shellLine(exe, shotArgs)}`);

  if (o['dry-run']) {
    if (o.dom) {
      const domProfile = join(profileRoot, `dom-${stamp}`);
      const domArgs = chromeArgs(o, domProfile, url, 'dom');
      console.log('\n  command (dom):');
      console.log(`  ${shellLine(exe, domArgs)}`);
    }
    console.log('\n  --- dry run: browser NOT launched, no files written ---');
    console.log(`  screenshot would go to: ${o.out}`);
    if (o.dom) console.log(`  dom would go to       : ${o.dom}`);
    process.exit(0);
  }

  ensureDir(o.out);
  removeQuietly(o.out); // never report a stale screenshot as fresh
  if (o.dom) ensureDir(o.dom);
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(shotProfile, { recursive: true });
  console.log('');

  // ---- screenshot pass(es) ----
  const timings = [];
  let lastShot = null;
  for (let run = 1; run <= o.repeat; run++) {
    if (o.repeat > 1) console.log(`  [screenshot ${run}/${o.repeat}]`);
    const r = await runChrome(exe, shotArgs, o.timeout, shotProfile, `shot-${run}`);
    lastShot = r;
    timings.push(r.elapsedMs);
    let png = null;
    try { png = existsSync(o.out) ? parsePngInfo(o.out) : null; } catch { /* ignore */ }
    if (r.error) {
      console.error(`  spawn error: ${r.error.message}`);
      summarizeChromeFailure(readTail(r.stderrFile));
      break;
    }
    console.log(`  run ${run}: exit=${r.code ?? '(none)'}${r.signal ? ` signal=${r.signal}` : ''} elapsed=${r.elapsedMs} ms timedOut=${r.timedOut} png=${png && png.valid ? `${png.bytes.toLocaleString('en-US')} bytes ${png.width}x${png.height}` : 'MISSING/INVALID'}`);
    if (!png || !png.valid) summarizeChromeFailure(readTail(r.stderrFile));
    else if (png.width !== o.w || png.height !== o.h) {
      console.warn(`  WARN: PNG is ${png.width}x${png.height}, requested ${o.w}x${o.h}`);
    }
  }

  let shotInfo = null;
  try { shotInfo = existsSync(o.out) ? parsePngInfo(o.out) : null; } catch { /* ignore */ }
  const shotOk = Boolean(shotInfo && shotInfo.valid &&
    (!lastShot || (!lastShot.error && !lastShot.timedOut)));

  // ---- optional DOM pass ----
  let domOk = true;
  let domStatus = null;
  if (o.dom) {
    const domProfile = join(profileRoot, `dom-${stamp}`);
    mkdirSync(domProfile, { recursive: true });
    const domArgs = chromeArgs(o, domProfile, url, 'dom');
    console.log('\n  command (dom):');
    console.log(`  ${shellLine(exe, domArgs)}`);
    const r = await runChrome(exe, domArgs, o.timeout, domProfile, 'dom');
    let domText = '';
    try { domText = existsSync(r.stdoutFile) ? readFileSync(r.stdoutFile, 'utf8') : ''; } catch { /* ignore */ }
    if (r.error || r.timedOut || !domText.trim()) {
      const why = r.error ? r.error.message : r.timedOut ? `timed out after ${r.elapsedMs} ms` : `empty DOM output (exit=${r.code})`;
      console.error(`  DOM FAILED: ${why}`);
      summarizeChromeFailure(readTail(r.stderrFile));
      domOk = false;
    } else {
      writeFileSync(o.dom, domText, 'utf8');
      domStatus = extractStatus(domText);
      console.log(`  dom: ${domText.length.toLocaleString('en-US')} bytes -> ${o.dom}`);
      if (domStatus) console.log(`  #status: "${domStatus}"`);
      if (o.expect) {
        const found = domText.includes(o.expect);
        console.log(`  expect "${o.expect}": ${found ? 'FOUND' : 'NOT FOUND'}`);
        if (!found) domOk = false;
      }
    }
    if (!o['keep-profile']) removeQuietly(domProfile);
  }

  // ---- summary ----
  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  console.log('\n=== summary ===');
  console.log(`  browser        : ${browserName}`);
  console.log(`  url            : ${url}`);
  console.log(`  screenshot     : ${shotOk ? `${o.out} (${shotInfo.bytes.toLocaleString('en-US')} bytes, ${shotInfo.width}x${shotInfo.height})` : 'MISSING or INVALID PNG'}`);
  if (shotOk) console.log(`  elapsed        : ${timings.map((t) => `${t} ms`).join(', ')}${median !== null ? ` (median ${median} ms)` : ''}`);
  if (o.dom) console.log(`  dom            : ${domOk ? `${o.dom}${domStatus ? `  #status="${domStatus}"` : ''}` : 'FAILED'}`);
  const ok = shotOk && domOk;
  console.log(`  result         : ${ok ? 'SHOT OK' : 'SHOT FAILED'}`);
  if (!ok) {
    const stderrTail = lastShot ? readTail(lastShot.stderrFile, 60) : [];
    const domTail = readTail(join(profileRoot, `dom-${stamp}`, 'dom.stderr.log'), 60);
    const combined = [...stderrTail, ...domTail];
    if (isSandboxBlock(combined)) {
      console.error('\n  DIAGNOSIS: Chrome was blocked by the DSH Windows sandbox.');
      console.error('  Mojo IPC channel creation is denied ("platform_channel.cc ... Check failed ... (0x5)"),');
      console.error('  so Chrome hangs before rendering and never writes the PNG.');
      console.error('  Re-run from a shell with wider permissions (danger-full-access).');
    } else {
      summarizeChromeFailure(combined);
    }
    if (!o['keep-profile']) console.error(`  profiles kept for inspection: ${o['profile-root']}`);
  } else if (!o['keep-profile']) {
    removeQuietly(shotProfile);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
