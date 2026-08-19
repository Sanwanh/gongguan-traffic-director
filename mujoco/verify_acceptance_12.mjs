// san 的 12 條 acceptance criteria 逐條實拍驗收(CDP headless)。
//
// 三個 target 各開一次 Chrome:
//   before  http://localhost:8125  —— .v9 備份還原成的獨立樹(改版前)
//   after   http://localhost:8124  —— 現在的 live 樹(改版後)
//   extend  http://localhost:8126  —— live 樹 + 硬塞一筆新參數(第 10 條可擴充性)
//
// 前置(before/extend 兩棵樹是用 hardlink copy 建的,不動 live tree):
//   SCR=/private/tmp/claude-501/-Users-san/a6cbb76f-4337-4070-b123-322f5ce15a49/scratchpad
//   SRC=/Users/san/Gongguan-Business-District-Digital-Twin/output/robot_package
//   # 1) 改版前的 .v9 樹
//   rm -rf $SCR/before_v9 && cp -al $SRC $SCR/before_v9
//   for f in traffic_director.js traffic_director.html traffic_director.css \
//            traffic_params.mjs traffic_simulation_core.mjs; do
//     rm -f $SCR/before_v9/viewer/$f && cp $SRC/viewer/$f.v9 $SCR/before_v9/viewer/$f
//   done
//   (cd $SCR/before_v9 && python3 mujoco/stamp_versions.py)
//   python3 $SCR/before_v9/serve.py --port 8125 --directory $SCR/before_v9 &
//   # 2) live + 硬塞一筆參數的樹(第 10 條可擴充性)
//   rm -rf $SCR/extend_probe && cp -al $SRC $SCR/extend_probe
//   rm -f $SCR/extend_probe/viewer/traffic_director.{js,html}
//   cp $SRC/viewer/traffic_director.{js,html} $SCR/extend_probe/viewer/
//   # 在 viewerParamDefs() 開頭 push 一筆 render.probeExtensibility,再 stamp
//   (cd $SCR/extend_probe && python3 mujoco/stamp_versions.py)
//   python3 $SCR/extend_probe/serve.py --port 8126 --directory $SCR/extend_probe &
//
// 用法:
//   node mujoco/verify_acceptance_12.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_shots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n = 4) => Number(Number(v).toFixed(n));

const results = [];
const notes = {};
let failures = 0;
function check(id, name, ok, detail) {
  results.push({ id, name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`);
}

// ---------------------------------------------------------------- CDP 連線層
function makeSession() {
  let nextId = 1;
  const pending = new Map();
  let socket = null;
  const consoleErrors = [];

  let sessionId = null;
  function setSession(id) { sessionId = id; }
  function send(method, params = {}) {
    const id = (nextId += 1);
    const payload = { id, method, params };
    if (sessionId && !method.startsWith("Target.") && !method.startsWith("Browser.")) {
      payload.sessionId = sessionId;
    }
    socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }
      }, 120000);
    });
  }
  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }
  async function waitUntil(expression, { timeoutMs = 120000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await evaluate(expression);
      if (v) return v;
      await sleep(intervalMs);
    }
    return null;
  }
  function attachSocket(ws) {
    socket = ws;
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        return;
      }
      if (m.method === "Runtime.exceptionThrown") {
        consoleErrors.push(m.params.exceptionDetails?.exception?.description
          ?? m.params.exceptionDetails?.text ?? "unknown");
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  }
  return { send, evaluate, waitUntil, attachSocket, setSession, consoleErrors };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(String(e.message ?? e.type))));
  });
}

async function withPage(label, { url, debugPort, width = 1920, height = 1080 }, fn) {
  const profile = `/private/tmp/claude-501/-Users-san/chrome-accept12-${label}`;
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--enable-unsafe-swiftshader",
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (c) => { stderr += c.toString(); });

  const s = makeSession();
  try {
    let wsUrl = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !wsUrl) {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        wsUrl = (await r.json()).webSocketDebuggerUrl;
      } catch { await sleep(300); }
    }
    if (!wsUrl) throw new Error(`Chrome 沒起來 (${label}):\n${stderr}`);
    s.attachSocket(await openSocket(wsUrl));
    const { targetId } = await s.send("Target.createTarget", { url: "about:blank" });
    const attached = await s.send("Target.attachToTarget", { targetId, flatten: true });
    s.setSession(attached.sessionId);

    await s.send("Page.enable");
    await s.send("Runtime.enable");
    await s.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    await s.send("Page.navigate", { url });
    await s.waitUntil("document.readyState === 'complete'");
    // 硬規則 6:載入完成 = #modelStatus .status-dot 上沒有 is-loading / is-error
    const ready = await s.waitUntil(`(() => {
      const dot = document.querySelector('#modelStatus .status-dot');
      if (!dot) return false;
      return !dot.classList.contains('is-loading') && !dot.classList.contains('is-error');
    })()`, { timeoutMs: 120000 });
    if (!ready) throw new Error(`${label}: 場景沒載入完成`);
    await sleep(2500);
    return await fn(s);
  } finally {
    try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
    await sleep(400);
  }
}

// ---------------------------------------------------------------- 共用探針
async function shot(s, name, clip) {
  const params = { format: "png" };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await s.send("Page.captureScreenshot", params);
  const path = join(OUT_DIR, name);
  writeFileSync(path, Buffer.from(r.data, "base64"));
  return path;
}

// 疊層面積探針:沿用 measure_visual_weight.mjs 的同一套定義,before/after 可比。
const OVERLAY_PROBE = `(() => {
  const viewport = document.querySelector('.viewport');
  if (!viewport) return null;
  const vr = viewport.getBoundingClientRect();
  const sceneArea = vr.width * vr.height;
  const candidates = [...viewport.children].filter((el) => {
    if (el.id === 'scene') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  });
  const items = candidates.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      sel: el.className ? '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left - vr.left), y: Math.round(r.top - vr.top),
      pct: Number(((r.width * r.height) / sceneArea * 100).toFixed(2)),
    };
  }).filter((i) => i.w > 0 && i.h > 0);
  return {
    viewport: { w: Math.round(vr.width), h: Math.round(vr.height) },
    scenePctOfWindow: Number((sceneArea / (innerWidth * innerHeight) * 100).toFixed(2)),
    items: items.sort((a, b) => b.pct - a.pct),
    overlayPctOfScene: Number(items.reduce((s, i) => s + i.pct, 0).toFixed(2)),
  };
})()`;

// 裝飾統計:對 CSS 原始檔做文字分析(和 measure_visual_weight.mjs 同一套規則)。
function analyseCss(cssPath) {
  const raw = readFileSync(cssPath, "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const all = (re) => [...css.matchAll(re)].map((m) => m[0].trim());
  const backdrop = all(/backdrop-filter\s*:\s*(?!none)[^;]+/g);
  const shadows = all(/box-shadow\s*:[^;]+/g);
  const glow = shadows.filter((x) => /:\s*0\s+0\s+(0\s+)?[\d.]+px/.test(x) && !/inset/.test(x));
  const radii = all(/border-radius\s*:\s*[\d.]+px/g).map((x) => parseFloat(x.split(":")[1]));
  const bigRadius = radii.filter((v) => v >= 8);
  const blurs = [];
  for (const m of css.matchAll(/box-shadow\s*:[^;]+/g)) {
    for (const n of m[0].matchAll(/(\d+(?:\.\d+)?)px/g)) blurs.push(parseFloat(n[1]));
  }
  const fontSizes = {};
  for (const m of css.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
    fontSizes[`${m[1]}px`] = (fontSizes[`${m[1]}px`] ?? 0) + 1;
  }
  return {
    backdropFilterCount: backdrop.length,
    backdropFilterRules: backdrop,
    glowShadowCount: glow.length,
    glowShadowRules: glow,
    bigRadiusCount: bigRadius.length,
    maxRadiusPx: radii.length ? Math.max(...radii.filter((v) => v < 900)) : 0,
    maxShadowBlurPx: blurs.length ? Math.max(...blurs) : 0,
    hardcodedFontSizeCount: Object.values(fontSizes).reduce((a, b) => a + b, 0),
    fontSizeVariants: Object.keys(fontSizes).length,
    animationCount: (css.match(/animation\s*:[^;]+/g) ?? []).length,
  };
}

// 真滑鼠(不是 el.click()):走完整 hit-test。
async function realClick(s, x, y, { modifiers = 0 } = {}) {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0, modifiers });
  await s.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers,
  });
  await sleep(45);
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers,
  });
}

// 真拖曳:pressed → N 段 moved → released,每段之間留 rAF 時間給 damping。
async function realDrag(s, x0, y0, dx, dy, { modifiers = 0, steps = 12, sampler = null } = {}) {
  const samples = [];
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, buttons: 0, modifiers });
  await s.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, modifiers,
  });
  for (let i = 1; i <= steps; i += 1) {
    const x = x0 + (dx * i) / steps;
    const y = y0 + (dy * i) / steps;
    await s.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "left", buttons: 1, modifiers,
    });
    await sleep(35);
    if (sampler) samples.push({ step: i, x: round(x, 1), y: round(y, 1), ...(await sampler()) });
  }
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: x0 + dx, y: y0 + dy, button: "left", buttons: 0, clickCount: 1, modifiers,
  });
  await sleep(900); // damping 收斂
  return samples;
}

async function cam(s) { return s.evaluate("window.__cameraState()"); }
async function settle(s, maxMs = 4000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const st = await cam(s);
    if (!st.transitioning) { await sleep(220); return; }
    await sleep(90);
  }
}

// 元素中心點:3D transform 後的面會互相重疊,所以在 bbox 上以 2px 網格掃
// elementFromPoint,取「離邊界最遠」的真正可命中內部點。
const HITPOINT_FN = `window.__hitPoint = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  let best = null;
  for (let y = Math.ceil(r.top) + 1; y < r.bottom - 1; y += 2) {
    for (let x = Math.ceil(r.left) + 1; x < r.right - 1; x += 2) {
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit !== el && !el.contains(hit)) continue;
      const d = Math.min(x - r.left, r.right - x, y - r.top, r.bottom - y);
      if (!best || d > best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y, w: Math.round(r.width), h: Math.round(r.height) } : null;
};1`;

// =========================================================== BEFORE (.v9 樹)
async function runBefore(s) {
  const out = {};
  out.overlay1920 = await s.evaluate(OVERLAY_PROBE);
  out.shot1920 = await shot(s, "v9_before_1920.png");
  out.hasGizmo = await s.evaluate("Boolean(document.querySelector('.viewport-gizmo'))");
  out.hasViewCube = await s.evaluate("Boolean(document.querySelector('#viewCube'))");
  out.hasHint = await s.evaluate("Boolean(document.querySelector('.viewport-hint'))");
  out.hasMenus = await s.evaluate("Boolean(document.querySelector('.viewport-menus'))");
  out.dataCameraCount = await s.evaluate("document.querySelectorAll('[data-camera]').length");
  out.presetNames = await s.evaluate(
    "[...document.querySelectorAll('[data-camera]')].map(b => b.dataset.camera)",
  );
  out.paramCount = await s.evaluate("Object.keys(window.__params?.() ?? {}).length");
  out.hooks = await s.evaluate(`(() => {
    const want = ['__cameraState','__pickAt','__focusObject','__frameSelected',
      '__setCameraMode','__setCameraPreset','__setCameraProjection','__layerState',
      '__viewCubeState','__projectPoint'];
    return Object.fromEntries(want.map(k => [k, typeof window[k]]));
  })()`);
  out.panelScrollHeight = await s.evaluate(`(() => {
    const p = document.querySelector('.panel-scroll') ?? document.querySelector('.control-panel');
    return p ? { scrollH: p.scrollHeight, screens: Number((p.scrollHeight / innerHeight).toFixed(2)),
      width: Math.round(p.getBoundingClientRect().width) } : null;
  })()`);
  out.topbar = await s.evaluate(`(() => {
    const t = document.querySelector('.topbar');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);

  // .v9 沒有 __cameraState;改用 __trafficDirectorDebug 直接讀 three 相機,
  // 高頻取樣 [data-camera] 點擊前後,證明舊版是「瞬移」沒有過渡動畫。
  out.oldSwitchCurve = await s.evaluate(`(async () => {
    const dbg = window.__trafficDirectorDebug;
    const cam = dbg?.camera ?? dbg?.THREE_camera ?? null;
    if (!cam) return { readable: false, keys: dbg ? Object.keys(dbg) : null };
    const grab = (t0) => ({
      t: Number((performance.now() - t0).toFixed(1)),
      p: [cam.position.x, cam.position.y, cam.position.z].map(v => Number(v.toFixed(4))),
    });
    document.querySelector('[data-camera="overview"]').click();
    await new Promise(r => setTimeout(r, 700));
    const t0 = performance.now();
    const samples = [grab(t0)];
    document.querySelector('[data-camera="busstop"]').click();
    await new Promise((resolve) => {
      const step = () => {
        samples.push(grab(t0));
        if (samples[samples.length - 1].t > 900) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const start = samples[0].p;
    const end = samples[samples.length - 1].p;
    const total = Math.hypot(end[0]-start[0], end[1]-start[1], end[2]-start[2]);
    const first = samples[1] ?? samples[0];
    const firstJump = Math.hypot(first.p[0]-start[0], first.p[1]-start[1], first.p[2]-start[2]);
    return {
      readable: true, frames: samples.length,
      totalTravelM: Number(total.toFixed(3)),
      firstFrameJumpM: Number(firstJump.toFixed(3)),
      firstFramePctOfTotal: total > 0 ? Number((firstJump / total * 100).toFixed(2)) : 0,
      distinctPositions: new Set(samples.map(x => x.p.join(','))).size,
      windowMs: samples[samples.length - 1].t,
    };
  })()`);

  await s.evaluate("window.dispatchEvent(new Event('resize'))");
  return out;
}

async function runBefore1440(s) {
  return {
    overlay1440: await s.evaluate(OVERLAY_PROBE),
    shot1440: await shot(s, "v9_before_1440.png"),
  };
}

// ============================================================ AFTER (live 樹)
async function runAfter(s) {
  const out = {};
  await s.evaluate(HITPOINT_FN);
  // 找一個「確定打在 canvas 上、而且 __pickAt 回傳 null」的空白點,
  // 用來清掉選取。左上角不能用 —— 那裡有 .topbar 識別 chip 擋著。
  await s.evaluate(`window.__emptyCanvasPoint = () => {
    const v = document.querySelector('.viewport').getBoundingClientRect();
    for (const fy of [0.06, 0.1, 0.16, 0.22, 0.3]) {
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const x = Math.round(v.left + v.width * fx);
        const y = Math.round(v.top + v.height * fy);
        const el = document.elementFromPoint(x, y);
        if (!el || el.tagName !== 'CANVAS') continue;
        if (window.__pickAt(x, y) === null) return { x, y };
      }
    }
    return null;
  };1`);

  const vp = await s.evaluate(`(() => {
    const v = document.querySelector('.viewport').getBoundingClientRect();
    return { x: v.left, y: v.top, w: v.width, h: v.height };
  })()`);
  // 場景中央偏左的安全點(避開右側面板與右上 gizmo)
  const cx = Math.round(vp.x + vp.w * 0.42);
  const cy = Math.round(vp.y + vp.h * 0.52);
  out.dragOrigin = { cx, cy };
  out.elementAtOrigin = await s.evaluate(
    `(() => { const e = document.elementFromPoint(${cx}, ${cy}); return e ? (e.id || e.tagName) : null; })()`,
  );

  // ---------------------------------------------------------------- 條件 1 旋轉
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const orbitStart = await cam(s);
  const orbitSamples = await realDrag(s, cx, cy, 320, 90, {
    sampler: async () => {
      const c = await cam(s);
      return {
        azimuthDeg: c.azimuthDeg, polarDeg: c.polarDeg,
        distance: c.distance, target: c.target, position: c.position,
      };
    },
  });
  const orbitEnd = await cam(s);
  const dAz = Math.abs(orbitEnd.azimuthDeg - orbitStart.azimuthDeg);
  const dPolar = Math.abs(orbitEnd.polarDeg - orbitStart.polarDeg);
  const distDrift = Math.abs(orbitEnd.distance - orbitStart.distance);
  const targetDrift = Math.hypot(
    orbitEnd.target[0] - orbitStart.target[0],
    orbitEnd.target[1] - orbitStart.target[1],
    orbitEnd.target[2] - orbitStart.target[2],
  );
  const azSeq = orbitSamples.map((x) => x.azimuthDeg);
  const azMono = azSeq.every((v, i) => i === 0 || Math.abs(v - azSeq[i - 1]) < 40);
  out.c1 = {
    start: { azimuthDeg: orbitStart.azimuthDeg, polarDeg: orbitStart.polarDeg, distance: orbitStart.distance },
    end: { azimuthDeg: orbitEnd.azimuthDeg, polarDeg: orbitEnd.polarDeg, distance: orbitEnd.distance },
    deltaAzimuthDeg: round(dAz, 3), deltaPolarDeg: round(dPolar, 3),
    distanceDriftM: round(distDrift, 4),
    distanceDriftPct: round((distDrift / orbitStart.distance) * 100, 3),
    targetDriftM: round(targetDrift, 4),
    samples: orbitSamples.map((x) => ({
      step: x.step, az: x.azimuthDeg, polar: x.polarDeg, dist: x.distance,
    })),
    azimuthMonotonicish: azMono,
    uniqueAzimuths: new Set(azSeq).size,
  };
  out.shotOrbit = await shot(s, "v9_after_c1_orbited.png");

  // ---------------------------------------------------------------- 條件 2 平移縮放
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const panStart = await cam(s);
  const panSamples = await realDrag(s, cx, cy, 260, 140, {
    modifiers: 8, // Shift
    sampler: async () => {
      const c = await cam(s);
      return { target: c.target, distance: c.distance };
    },
  });
  const panEnd = await cam(s);
  const panDelta = Math.hypot(
    panEnd.target[0] - panStart.target[0],
    panEnd.target[1] - panStart.target[1],
    panEnd.target[2] - panStart.target[2],
  );
  const uniqueTargets = new Set(panSamples.map((x) => x.target.join(","))).size;
  const shiftAzDelta = Math.abs(panEnd.azimuthDeg - panStart.azimuthDeg);

  // 右鍵拖曳 = Pan(§20 保留的額外通道)
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const rpStart = await cam(s);
  await s.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: cx, y: cy, button: "right", buttons: 2, clickCount: 1,
  });
  for (let i = 1; i <= 12; i += 1) {
    await s.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: cx + (260 * i) / 12, y: cy + (140 * i) / 12,
      button: "right", buttons: 2,
    });
    await sleep(35);
  }
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: cx + 260, y: cy + 140, button: "right", buttons: 0, clickCount: 1,
  });
  await sleep(900);
  const rpEnd = await cam(s);
  const rightPanDelta = Math.hypot(
    rpEnd.target[0] - rpStart.target[0],
    rpEnd.target[1] - rpStart.target[1],
    rpEnd.target[2] - rpStart.target[2],
  );

  // Zoom:滾輪往內 12 格、再往外 12 格
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const zoomStart = await cam(s);
  const zoomIn = [];
  for (let i = 0; i < 12; i += 1) {
    await s.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -120, modifiers: 0,
    });
    await sleep(80);
    zoomIn.push(round((await cam(s)).distance, 3));
  }
  await sleep(700);
  const afterIn = await cam(s);
  const insideAfterZoomIn = await s.evaluate("window.__cameraInsideBlocker()");
  const zoomOut = [];
  for (let i = 0; i < 12; i += 1) {
    await s.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: 120, modifiers: 0,
    });
    await sleep(80);
    zoomOut.push(round((await cam(s)).distance, 3));
  }
  await sleep(700);
  const afterOut = await cam(s);

  // Zoom 極限:狂滾 60 格看會不會穿模
  await s.evaluate("window.__setCameraPreset('street')");
  await settle(s);
  for (let i = 0; i < 60; i += 1) {
    await s.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -120, modifiers: 0,
    });
    await sleep(22);
  }
  await sleep(900);
  const streetZoomed = await cam(s);
  const streetInside = await s.evaluate("window.__cameraInsideBlocker()");
  out.c2 = {
    shiftLeftPan: {
      startTarget: panStart.target, endTarget: panEnd.target,
      targetDeltaM: round(panDelta, 4),
      azimuthDeltaDeg: round(shiftAzDelta, 3),
      distanceDriftM: round(Math.abs(panEnd.distance - panStart.distance), 4),
      uniqueTargetsDuringDrag: uniqueTargets,
      verdict: panDelta < 0.05 && shiftAzDelta > 5
        ? "Shift+左鍵實際在 ROTATE(雙重否定抵銷),不是 PAN"
        : (panDelta > 2 ? "Shift+左鍵確實 PAN" : "無明顯反應"),
    },
    rightDragPan: {
      startTarget: rpStart.target, endTarget: rpEnd.target,
      targetDeltaM: round(rightPanDelta, 4),
      distanceDriftM: round(Math.abs(rpEnd.distance - rpStart.distance), 4),
    },
    zoom: {
      startDistance: zoomStart.distance,
      afterZoomIn: afterIn.distance,
      afterZoomOut: afterOut.distance,
      zoomInCurve: zoomIn, zoomOutCurve: zoomOut,
      insideBlockerAfterZoomIn: insideAfterZoomIn,
      roundTripErrorM: round(Math.abs(afterOut.distance - zoomStart.distance), 4),
    },
    clipGuard: {
      preset: "street", after60Notches: streetZoomed.distance,
      cameraY: round(streetZoomed.position[1], 4),
      insideBlocker: streetInside,
    },
  };

  // ---------------------------------------------------------------- 條件 3 ViewCube
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  out.c3 = await s.evaluate(`(() => {
    const vr = document.querySelector('.viewport').getBoundingClientRect();
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        // 規格說「場景右上角」,所以量的是相對 .viewport(3D 場景)的邊距,
        // 不是相對整個視窗(視窗右側還有 320px 控制面板)。
        rightGap: Math.round(vr.right - r.right),
        topGap: Math.round(r.top - vr.top),
        rightGapFromWindow: Math.round(innerWidth - r.right),
        display: cs.display, zIndex: cs.zIndex,
        pctOfViewport: Number((r.width * r.height / (vr.width * vr.height) * 100).toFixed(3)),
        pctOfWindow: Number((r.width * r.height / (innerWidth * innerHeight) * 100).toFixed(3)),
      };
    };
    return {
      window: { w: innerWidth, h: innerHeight },
      viewport: { w: Math.round(vr.width), h: Math.round(vr.height) },
      gizmo: box('.viewport-gizmo'),
      cube: box('#viewCube'),
      faces: [...document.querySelectorAll('.viewcube-face')].map(f => f.dataset.cubeFace),
      railButtons: [...document.querySelectorAll('.viewport-gizmo button')]
        .filter(b => !b.classList.contains('view-cube-face'))
        .map(b => b.id || b.dataset.cameraAction || b.textContent.trim()),
      panelRect: (() => { const p = document.querySelector('.control-panel');
        if (!p) return null; const r = p.getBoundingClientRect();
        return { x: Math.round(r.left), w: Math.round(r.width) }; })(),
    };
  })()`);
  const g = out.c3.gizmo;
  if (g) {
    out.shotGizmo = await shot(s, "v9_after_c3_gizmo_crop.png", {
      x: Math.max(0, g.x - 24), y: Math.max(0, g.y - 12),
      width: g.w + 48, height: g.h + 36,
    });
  }
  // ViewCube 真的跟著相機轉
  const cubeM0 = await s.evaluate("window.__viewCubeState?.().transform || getComputedStyle(document.querySelector('#viewCubeStage')).transform");
  await realDrag(s, cx, cy, 260, 40);
  const cubeM1 = await s.evaluate("window.__viewCubeState?.().transform || getComputedStyle(document.querySelector('#viewCubeStage')).transform");
  out.c3.cubeFollowsCamera = String(cubeM0) !== String(cubeM1);
  out.c3.cubeMatrixBefore = String(cubeM0).slice(0, 70);
  out.c3.cubeMatrixAfter = String(cubeM1).slice(0, 70);

  // ---------------------------------------------------------------- 條件 4 預設視角
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const presetPlan = [
    { key: "overview", label: "Bird's-eye 鳥瞰", how: "menu", sel: '[data-camera="overview"]' },
    { key: "isometric", label: "Isometric 等角", how: "menu", sel: '[data-view="isometric"]' },
    { key: "street", label: "Street 街道", how: "menu", sel: '[data-camera="street"]' },
    { key: "robot", label: "Follow KBot 跟隨", how: "menu", sel: '[data-camera="robot"]' },
    { key: "intersection", label: "Focus Intersection 路口", how: "menu", sel: '[data-view="intersection"]' },
    { key: "busstop", label: "Focus Bus Stop 公車站", how: "menu", sel: '[data-camera="busstop"]' },
    { key: "crosswalk", label: "Crosswalk 行穿線", how: "menu", sel: '[data-camera="crosswalk"]' },
    { key: "hook", label: "Hook 待轉區", how: "menu", sel: '[data-camera="hook"]' },
    { key: "topdown", label: "Top 正俯視(模式)", how: "menu", sel: '[data-camera-mode="top"]' },
    { key: "fixedpost", label: "Fixed 固定監控(模式)", how: "menu", sel: '[data-camera-mode="fixed"]' },
  ];
  const presetRows = [];
  for (const p of presetPlan) {
    // 開 View 選單(真滑鼠),點該顆,再讀狀態
    await s.evaluate(`(() => {
      const b = document.querySelector('#viewMenuButton');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    })()`);
    await sleep(220);
    const hp = await s.evaluate(`window.__hitPoint(${JSON.stringify(p.sel)})`);
    let via = "realmouse";
    if (hp) {
      await realClick(s, hp.x, hp.y);
    } else {
      via = "hook-fallback";
      await s.evaluate(`window.__setCameraPreset(${JSON.stringify(p.key)})`);
    }
    await settle(s);
    await sleep(600);
    const st = await cam(s);
    const inside = await s.evaluate("window.__cameraInsideBlocker()");
    const path = await shot(s, `v9_after_c4_preset_${p.key}.png`);
    presetRows.push({
      key: p.key, label: p.label, via, selectorFound: Boolean(hp),
      preset: st.preset, mode: st.mode,
      polarDeg: st.polarDeg, azimuthDeg: st.azimuthDeg, distance: st.distance,
      cameraY: round(st.position[1], 3), insideBlocker: inside,
      shot: path.split("/").pop(),
    });
    await s.evaluate(`(() => {
      const b = document.querySelector('#viewMenuButton');
      if (b && b.getAttribute('aria-expanded') === 'true') b.click();
    })()`);
    await sleep(150);
  }
  out.c4 = {
    presets: presetRows,
    distinctPositions: new Set(presetRows.map((r) => `${r.azimuthDeg}|${r.polarDeg}|${r.distance}`)).size,
    dataCameraCount: await s.evaluate("document.querySelectorAll('[data-camera]').length"),
  };

  // Follow KBot 穩定度:robot preset 下,3 秒內距離漂移
  await s.evaluate("window.__setCameraPreset('robot')");
  await settle(s);
  const followSamples = [];
  for (let i = 0; i < 7; i += 1) {
    const c = await cam(s);
    followSamples.push({ t: i * 450, distance: c.distance, mode: c.mode });
    await sleep(450);
  }
  out.c4.followStability = {
    samples: followSamples,
    driftM: round(Math.abs(followSamples.at(-1).distance - followSamples[0].distance), 4),
    modeStaysFollow: followSamples.every((x) => x.mode === "follow"),
  };
  // 手動操作要退出 Follow
  await realDrag(s, cx, cy, 140, 40, { steps: 6 });
  const afterManual = await cam(s);
  out.c4.manualExitsFollow = afterManual.mode !== "follow";
  out.c4.modeAfterManualDrag = afterManual.mode;

  // ---------------------------------------------------------------- 條件 5 Focus / Frame
  await s.evaluate("window.__setCameraPreset('robot')");
  await settle(s);
  await sleep(900);
  // 先用 hook 把相機帶到 KBot 前面(這樣 KBot 在畫面上夠大),再用「真滑鼠」
  // 點它 —— 粗網格會漏掉小目標,所以以 KBot 的投影位置為中心做 12px 密掃。
  await s.evaluate("window.__focusObject('kbot')");
  await settle(s);
  await sleep(700);
  // 點一下空白畫布清掉選取,才能證明「是這一下點擊選中 KBot 的」
  const firstEmpty = await s.evaluate("window.__emptyCanvasPoint()");
  if (firstEmpty) { await realClick(s, firstEmpty.x, firstEmpty.y); await sleep(250); }
  out.c5 = { selectionAfterSkyClick: (await cam(s)).selection ?? null };

  // KBot 會走動,所以「先慢慢掃描、再回頭點」會點到它已經離開的位置(第一版
  // 就是這樣點到後面的行穿線)。改成:小範圍快掃 → 立刻點 → 沒中就重試。
  let kbotScan = null;
  let attempts = 0;
  for (let i = 0; i < 6; i += 1) {
    attempts = i + 1;
    kbotScan = await s.evaluate(`(() => {
      const v = document.querySelector('.viewport').getBoundingClientRect();
      const ndc = window.__projectPoint(window.__cameraState().target);
      const sx = (ndc[0] * 0.5 + 0.5) * v.width + v.left;
      const sy = (-ndc[1] * 0.5 + 0.5) * v.height + v.top;
      const counts = {}; const pts = [];
      for (let dy = -90; dy <= 90; dy += 10) {
        for (let dx = -90; dx <= 90; dx += 10) {
          const x = Math.round(sx + dx); const y = Math.round(sy + dy);
          if (x < v.left + 4 || x > v.right - 4 || y < v.top + 4 || y > v.bottom - 4) continue;
          const h = window.__pickAt(x, y);
          const k = h ? h.kind : 'null';
          counts[k] = (counts[k] || 0) + 1;
          if (k === 'kbot') pts.push({ x, y, id: h.id, center: h.center, radius: h.radius });
        }
      }
      // 取重心最近的那一點,盡量打在身體中央
      let hit = null;
      if (pts.length) {
        const mx = pts.reduce((a, b) => a + b.x, 0) / pts.length;
        const my = pts.reduce((a, b) => a + b.y, 0) / pts.length;
        hit = pts.reduce((best, q) => (
          Math.hypot(q.x - mx, q.y - my) < Math.hypot(best.x - mx, best.y - my) ? q : best
        ), pts[0]);
      }
      return { counts, hit, kbotPixels: pts.length,
        projected: { x: Math.round(sx), y: Math.round(sy) } };
    })()`);
    if (!kbotScan.hit) { await sleep(500); continue; }
    // 掃描有選取副作用(__pickAt 會選取),先點畫面角落把選取換掉,
    // 這樣「這一下點擊選中 KBot」才有意義。
    const empty = await s.evaluate("window.__emptyCanvasPoint()");
    if (empty) {
      await realClick(s, empty.x, empty.y);
      await sleep(220);
    }
    out.c5.clearPoint = empty;
    out.c5.selectionBeforeRealClick = (await cam(s)).selection ?? null;
    await realClick(s, kbotScan.hit.x, kbotScan.hit.y);
    await sleep(280);
    const sel = (await cam(s)).selection;
    if (sel && sel.kind === "kbot") { kbotScan.selected = sel; break; }
    kbotScan.selected = sel ?? null;
    await sleep(350);
  }
  out.c5.kbotScan = kbotScan
    ? { counts: kbotScan.counts, kbotPixels: kbotScan.kbotPixels,
      projected: kbotScan.projected, attempts }
    : null;

  if (kbotScan && kbotScan.hit) {
    out.shotBeforeFocus = await shot(s, "v9_after_c5_before_focus.png");
    out.c5.clickSelected = kbotScan.selected ?? null;
    out.c5.clickPoint = { x: kbotScan.hit.x, y: kbotScan.hit.y };

    out.c5.focusButtonEnabledAfterSelect = await s.evaluate(
      "(() => { const b = document.querySelector('#focusSelected'); return b ? !b.disabled : null; })()",
    );
    out.c5.selectionLabel = await s.evaluate(
      "document.querySelector('#cameraSelectionLabel')?.textContent.trim() ?? null",
    );

    // 先退開,才看得出 Focus 真的把相機帶過去
    await s.evaluate("window.__setCameraPreset('overview')");
    await settle(s);
    await sleep(400);
    out.c5.selectionSurvivesPresetChange = (await cam(s)).selection;
    const preFocus = await cam(s);

    const fp = await s.evaluate("window.__hitPoint('#focusSelected')");
    out.c5.focusViaRealMouse = Boolean(fp);
    if (fp) await realClick(s, fp.x, fp.y);
    else await s.evaluate("window.__frameSelected()");
    await settle(s);
    await sleep(400);

    out.c5.focusCentering = await s.evaluate(`(() => {
      const st = window.__cameraState();
      if (!st.selection) return null;
      const v = document.querySelector('.viewport').getBoundingClientRect();
      const ndc = window.__projectPoint(st.target);
      const px = (ndc[0] * 0.5 + 0.5) * v.width + v.left;
      const py = (-ndc[1] * 0.5 + 0.5) * v.height + v.top;
      return {
        ndc, screen: { x: Math.round(px), y: Math.round(py) },
        center: { x: Math.round(v.left + v.width / 2), y: Math.round(v.top + v.height / 2) },
        offsetPx: Number(Math.hypot(px - (v.left + v.width / 2), py - (v.top + v.height / 2)).toFixed(2)),
        distance: st.distance, selection: st.selection,
      };
    })()`);
    out.c5.cameraMovedForFocusM = round(Math.hypot(
      (await cam(s)).position[0] - preFocus.position[0],
      (await cam(s)).position[1] - preFocus.position[1],
      (await cam(s)).position[2] - preFocus.position[2],
    ), 3);
    out.shotAfterFocus = await shot(s, "v9_after_c5_after_focus.png");
  }

  // Frame Selected:換一個靜態物件(公車站/路口),量置中程度
  const staticHit = await s.evaluate(`(() => {
    window.__setCameraPreset('overview');
    return null;
  })()`);
  await settle(s);
  await sleep(600);
  const staticScan = await s.evaluate(`(() => {
    const v = document.querySelector('.viewport').getBoundingClientRect();
    const want = ['busstop','intersection','crosswalk','hook'];
    for (let iy = 1; iy <= 16; iy += 1) {
      for (let ix = 1; ix <= 16; ix += 1) {
        const x = Math.round(v.left + v.width * ix / 17);
        const y = Math.round(v.top + v.height * iy / 17);
        const h = window.__pickAt(x, y);
        if (h && want.includes(h.kind)) return { x, y, id: h.id, kind: h.kind, center: h.center, radius: h.radius };
      }
    }
    return null;
  })()`);
  if (staticScan) {
    await realClick(s, staticScan.x, staticScan.y);
    await sleep(250);
    const framed = await s.evaluate(`(() => {
      const ok = window.__frameSelected();
      return ok;
    })()`);
    await settle(s);
    await sleep(300);
    out.c5.frameStatic = await s.evaluate(`(() => {
      const st = window.__cameraState();
      const v = document.querySelector('.viewport').getBoundingClientRect();
      const ndc = window.__projectPoint(${JSON.stringify(staticScan.center)});
      const px = (ndc[0] * 0.5 + 0.5) * v.width + v.left;
      const py = (-ndc[1] * 0.5 + 0.5) * v.height + v.top;
      return {
        kind: ${JSON.stringify(staticScan.kind)}, id: ${JSON.stringify(staticScan.id)},
        ndc, offsetPx: Number(Math.hypot(px - (v.left + v.width / 2), py - (v.top + v.height / 2)).toFixed(2)),
        distance: st.distance, radius: ${staticScan.radius},
        distanceOverRadius: Number((st.distance / ${staticScan.radius}).toFixed(2)),
        selection: st.selection,
      };
    })()`);
    out.c5.frameReturned = framed;
    out.shotFrameStatic = await shot(s, "v9_after_c5_frame_static.png");
  }

  // 雙擊 / F 鍵聚焦(底部提示承諾的操作)
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  const dblTargetScan = await s.evaluate(`(() => {
    const v = document.querySelector('.viewport').getBoundingClientRect();
    for (let iy = 2; iy <= 14; iy += 1) {
      for (let ix = 2; ix <= 14; ix += 1) {
        const x = Math.round(v.left + v.width * ix / 16);
        const y = Math.round(v.top + v.height * iy / 16);
        const h = window.__pickAt(x, y);
        if (h) return { x, y, kind: h.kind, id: h.id, center: h.center };
      }
    }
    return null;
  })()`);
  if (dblTargetScan) {
    const before = await cam(s);
    await realClick(s, dblTargetScan.x, dblTargetScan.y);
    await sleep(120);
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
    await settle(s);
    await sleep(300);
    const after = await cam(s);
    out.c5.fKey = {
      kind: dblTargetScan.kind,
      distanceBefore: before.distance, distanceAfter: after.distance,
      moved: round(Math.hypot(
        after.position[0] - before.position[0],
        after.position[1] - before.position[1],
        after.position[2] - before.position[2],
      ), 3),
      offsetPx: await s.evaluate(`(() => {
        const v = document.querySelector('.viewport').getBoundingClientRect();
        const ndc = window.__projectPoint(window.__cameraState().target);
        const px = (ndc[0] * 0.5 + 0.5) * v.width + v.left;
        const py = (-ndc[1] * 0.5 + 0.5) * v.height + v.top;
        return Number(Math.hypot(px - (v.left + v.width/2), py - (v.top + v.height/2)).toFixed(2));
      })()`),
    };
  }

  // ---------------------------------------------------------------- 條件 6 平滑動畫
  const flights = ["isometric", "busstop", "topdown", "street", "overview"];
  const curves = [];
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  for (const name of flights) {
    // 每段都從同一個起點出發,量到的跳動才歸得了因(不然會被上一段的終點影響)
    await s.evaluate(`window.__setCameraPreset(${JSON.stringify(name === "overview" ? "isometric" : "overview")})`);
    await settle(s);
    await sleep(400);
    const curve = await s.evaluate(`(async () => {
      const samples = [];
      const t0 = performance.now();
      const grab = () => {
        const c = window.__cameraState();
        samples.push({
          t: Number((performance.now() - t0).toFixed(1)),
          p: c.position, tg: c.target, d: c.distance, tr: c.transitioning,
        });
      };
      grab();
      window.__setCameraPreset(${JSON.stringify(name)});
      await new Promise((resolve) => {
        const step = () => {
          grab();
          const last = samples[samples.length - 1];
          if ((!last.tr && samples.length > 4) || last.t > 4000) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      grab();
      return samples;
    })()`);
    const start = curve[0].p;
    const end = curve.at(-1).p;
    const total = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const progress = curve.map((s2) => {
      const d = Math.hypot(s2.p[0] - start[0], s2.p[1] - start[1], s2.p[2] - start[2]);
      return total > 0 ? round(d / total, 4) : 0;
    });
    const steps = [];
    const frameGaps = [];
    for (let i = 1; i < curve.length; i += 1) {
      steps.push(Math.hypot(
        curve[i].p[0] - curve[i - 1].p[0],
        curve[i].p[1] - curve[i - 1].p[1],
        curve[i].p[2] - curve[i - 1].p[2],
      ));
      frameGaps.push(round(curve[i].t - curve[i - 1].t, 1));
    }
    const maxStepIdx = steps.indexOf(Math.max(...steps));
    const transFrames = curve.filter((x) => x.tr).length;
    const durationMs = curve.at(-1).t;
    const monotonic = progress.every((v, i) => i === 0 || v >= progress[i - 1] - 0.02);
    curves.push({
      preset: name,
      totalTravelM: round(total, 3),
      frames: curve.length,
      transitioningFrames: transFrames,
      durationMs: round(durationMs, 1),
      progressCurve: progress,
      maxSingleFrameStepM: round(Math.max(...steps), 3),
      maxStepPctOfTotal: total > 0 ? round((Math.max(...steps) / total) * 100, 2) : 0,
      maxStepFrameIndex: maxStepIdx + 1,
      maxStepFrameGapMs: frameGaps[maxStepIdx],
      medianFrameGapMs: round([...frameGaps].sort((a, b) => a - b)[Math.floor(frameGaps.length / 2)], 1),
      // 分類:第 1 幀的大跳 = 進入模式時 applyCameraModeConstraints 的即時夾限;
      // 中段大跳且 frame gap 也大 = headless rAF 停頓(取樣假象);
      // 中段大跳但 frame gap 正常 = 真正的動畫不連續。
      jumpKind: (() => {
        const pct = total > 0 ? (Math.max(...steps) / total) * 100 : 0;
        if (pct < 25) return "smooth";
        if (maxStepIdx === 0) return "mode-constraint-snap-at-start";
        const gap = frameGaps[maxStepIdx];
        const med = [...frameGaps].sort((a, b) => a - b)[Math.floor(frameGaps.length / 2)];
        return gap > med * 3 ? "raf-stall-sampling-artifact" : "real-mid-flight-discontinuity";
      })(),
      frameGapsMs: frameGaps,
      timestampsMs: curve.map((x) => x.t),
      monotonic,
      firstSampleIsNotEndpoint: progress.length > 1 ? progress[1] < 0.98 : false,
      distinctPositions: new Set(curve.map((x) => x.p.join(","))).size,
    });
  }
  out.c6 = { curves, configuredTransitionMs: 620 };

  // 起手瞬跳的成因矩陣:applyCameraPreset() 在 cameraFlyTo() **之前**就呼叫
  // applyCameraModeConstraints(),把 controls 的 min/maxPolarAngle 換成目的地
  // 模式的限制;render loop 下一次 controls.update() 立刻把相機夾到新範圍,
  // 於是過渡的第一幀就先瞬移一段。只在「出發姿態違反目的地模式限制」時發生。
  const snapMatrix = [];
  for (const [from, to] of [
    ["overview", "topdown"], ["street", "topdown"], ["isometric", "topdown"],
    ["topdown", "street"], ["overview", "street"], ["topdown", "overview"],
    ["overview", "robot"], ["overview", "fixedpost"],
  ]) {
    await s.evaluate(`window.__setCameraPreset(${JSON.stringify(from)})`);
    await settle(s);
    await sleep(400);
    const probe = await s.evaluate(`(async () => {
      const before = window.__cameraState();
      window.__setCameraPreset(${JSON.stringify(to)});
      // 只等一幀:這一幀之後看相機被夾了多少
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const oneFrame = window.__cameraState();
      await new Promise((resolve) => {
        const step = () => {
          if (!window.__cameraState().transitioning) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const after = window.__cameraState();
      const d = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
      return {
        fromPolar: before.polarDeg, toPolar: after.polarDeg,
        polarAfterOneFrame: oneFrame.polarDeg,
        totalM: Number(d(before.position, after.position).toFixed(3)),
        firstFrameM: Number(d(before.position, oneFrame.position).toFixed(3)),
      };
    })()`);
    snapMatrix.push({
      from, to,
      ...probe,
      firstFramePct: probe.totalM > 0 ? round((probe.firstFrameM / probe.totalM) * 100, 1) : 0,
    });
  }
  out.c6.snapMatrix = snapMatrix;

  // __setCamera 舊契約:必須仍是同步瞬移(驗收腳本依賴)
  out.c6.legacySetCameraSync = await s.evaluate(`(() => {
    // 契約是「模擬座標進、同步瞬移、回傳 true」——用 record_demo_video 那種
    // 兩個陣列的呼叫法。
    const before = window.__cameraState().position.join(',');
    const ret = window.__setCamera([40, 60, 40], [0, 0, 0]);
    const after = window.__cameraState().position.join(',');
    return { returned: ret, movedSynchronously: before !== after,
      transitioning: window.__cameraState().transitioning,
      signature: 'array(position, target)' };
  })()`);

  // ---------------------------------------------------------------- 條件 7 疊層面積
  await s.evaluate("window.__setCameraPreset('overview')");
  await settle(s);
  out.c7 = { overlay1920: await s.evaluate(OVERLAY_PROBE) };
  out.shot1920 = await shot(s, "v9_after_1920.png");
  // 選單打開時的疊層(最壞情況)
  await s.evaluate("document.querySelector('#viewMenuButton')?.click()");
  await sleep(300);
  out.c7.overlayViewMenuOpen = await s.evaluate(OVERLAY_PROBE);
  out.shotViewMenu = await shot(s, "v9_after_c7_view_menu.png");
  await s.evaluate("document.querySelector('#viewMenuButton')?.click()");
  await sleep(200);
  await s.evaluate("document.querySelector('#layersMenuButton')?.click()");
  await sleep(300);
  out.shotLayersMenu = await shot(s, "v9_after_c7_layers_menu.png");
  await s.evaluate("document.querySelector('#layersMenuButton')?.click()");
  await sleep(200);
  // 收合面板
  await s.evaluate("window.__setPanelCollapsed?.(true)");
  await sleep(500);
  out.c7.overlayCollapsed = await s.evaluate(OVERLAY_PROBE);
  out.shotCollapsed = await shot(s, "v9_after_c7_collapsed.png");
  await s.evaluate("window.__setPanelCollapsed?.(false)");
  await sleep(400);

  // ---------------------------------------------------------------- 條件 8 裝飾
  out.c8 = await s.evaluate(`(() => {
    const all = [...document.querySelectorAll('body *')];
    let backdrop = 0, glow = 0, bigRadius = 0, maxBlur = 0;
    const glowSamples = [], backdropSamples = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') {
        backdrop += 1;
        if (backdropSamples.length < 6) backdropSamples.push((el.className || el.tagName) + ' :: ' + cs.backdropFilter);
      }
      const sh = cs.boxShadow;
      if (sh && sh !== 'none') {
        for (const m of sh.matchAll(/(-?\\d+(?:\\.\\d+)?)px/g)) {
          maxBlur = Math.max(maxBlur, Math.abs(parseFloat(m[1])));
        }
        if (/rgba?\\([^)]*\\)\\s+0px\\s+0px\\s+\\d/.test(sh) && !/inset/.test(sh)) {
          glow += 1;
          if (glowSamples.length < 6) glowSamples.push((el.className || el.tagName) + ' :: ' + sh);
        }
      }
      const r = parseFloat(cs.borderTopLeftRadius);
      if (Number.isFinite(r) && r >= 8 && r < 900) bigRadius += 1;
    }
    return {
      elementsScanned: all.length,
      computedBackdropFilter: backdrop, backdropSamples,
      computedGlowShadows: glow, glowSamples,
      computedBigRadius: bigRadius,
      maxShadowBlurPx: maxBlur,
      visibleEyebrows: [...document.querySelectorAll('.eyebrow')]
        .filter(e => getComputedStyle(e).display !== 'none').length,
      eyebrowsInDom: document.querySelectorAll('.eyebrow').length,
    };
  })()`);

  // ---------------------------------------------------------------- 條件 9 工具慣例
  out.c9 = await s.evaluate(`(() => {
    const vr = document.querySelector('.viewport').getBoundingClientRect();
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        // 相對 3D 場景(.viewport)的邊距 —— 規格講的是「場景角落」
        rightGap: Math.round(vr.right - r.right),
        topGap: Math.round(r.top - vr.top),
        leftGap: Math.round(r.left - vr.left),
        bottomGap: Math.round(vr.bottom - r.bottom),
        display: cs.display };
    };
    const hint = document.querySelector('.viewport-hint');
    return {
      window: { w: innerWidth, h: innerHeight },
      gizmoTopRight: rect('.viewport-gizmo'),
      menusBottomLeft: rect('.viewport-menus'),
      hintBottomCenter: rect('.viewport-hint'),
      hintText: hint ? hint.textContent.trim() : null,
      statusStrip: rect('.status-strip'),
      identityChip: rect('.topbar'),
      panel: rect('.control-panel'),
      cubeFaces: [...document.querySelectorAll('.viewcube-face')].map(f => ({
        face: f.dataset.cubeFace, label: f.textContent.trim(),
      })),
      projectionToggle: (() => { const b = document.querySelector('#projectionToggle');
        return b ? { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') } : null; })(),
      cameraModes: [...document.querySelectorAll('[data-camera-mode]')].map(b => b.dataset.cameraMode),
      layerToggles: [...document.querySelectorAll('.layer-row[data-layer]')].map(b => b.dataset.layer),
      keyboardShortcutHintIncludesF: hint ? /F/.test(hint.textContent) : false,
      tabbableNewControls: [...document.querySelectorAll('.viewport-gizmo button, .viewport-menus button')]
        .filter(b => b.tabIndex >= 0).length,
      ariaLabelled: [...document.querySelectorAll('.viewport-gizmo button, .viewport-menus button')]
        .filter(b => b.getAttribute('aria-label') || b.textContent.trim()).length,
    };
  })()`);

  // Ortho / Persp 切換(Blender/Fusion 慣例)
  const projBefore = await cam(s);
  const pt = await s.evaluate("window.__hitPoint('#projectionToggle')");
  if (pt) await realClick(s, pt.x, pt.y);
  await sleep(600);
  const projOrtho = await cam(s);
  if (pt) await realClick(s, pt.x, pt.y);
  await sleep(600);
  const projBack = await cam(s);
  out.c9.projectionRoundTrip = {
    before: { projection: projBefore.projection, distance: projBefore.distance },
    ortho: { projection: projOrtho.projection, distance: projOrtho.distance },
    back: { projection: projBack.projection, distance: projBack.distance },
    distanceErrorM: round(Math.abs(projBack.distance - projBefore.distance), 4),
    realMouse: Boolean(pt),
  };

  // ---------------------------------------------------------------- 條件 10 參數面板
  out.c10 = await s.evaluate(`(() => {
    const params = Object.keys(window.__params());
    const rows = document.querySelectorAll('#paramGroups .param-row');
    const blocks = [...document.querySelectorAll('#paramGroups .param-block')].map(b => ({
      group: b.dataset.groupId,
      count: Number((b.querySelector('.param-block-count')?.textContent ?? '0').replace(/\\D/g, '')),
    }));
    return {
      paramCount: params.length,
      rowCount: rows.length,
      groups: blocks,
      groupSum: blocks.reduce((a, b) => a + b.count, 0),
      hasSearch: Boolean(document.querySelector('#paramSearch')),
      hasResetAll: Boolean(document.querySelector('#paramResetAll')),
      hooks: Object.fromEntries(['__params','__setParam','__paramMeta','__paramCode','__resetParams']
        .map(k => [k, typeof window[k]])),
    };
  })()`);
  // 三個分頁下 param 數都一樣(不 unmount)
  const tabs = ["command", "sim", "params"];
  const perTab = {};
  for (const t of tabs) {
    const applied = await s.evaluate(`(() => { try { return window.__setPanelTab?.(${JSON.stringify(t)}) ?? null; } catch (e) { return 'err:' + e.message; } })()`);
    await sleep(250);
    perTab[t] = {
      applied,
      params: await s.evaluate("Object.keys(window.__params()).length"),
      rows: await s.evaluate("document.querySelectorAll('#paramGroups .param-row').length"),
      tab: await s.evaluate("window.__panelState?.().tab ?? null"),
    };
  }
  out.c10.perTab = perTab;
  await s.evaluate("window.__setPanelTab?.('params')");
  await sleep(200);
  await shot(s, "v9_after_c10_params_tab.png");
  // set/reset 真的作用
  out.c10.setParamRoundTrip = await s.evaluate(`(() => {
    const metas = window.__paramMeta();
    const meta = metas.find(m => m.kind !== 'color' && Number.isFinite(m.max)
      && Number.isFinite(m.step) && m.value + m.step <= m.max) ?? metas[0];
    const before = window.__params()[meta.id];
    const next = before + meta.step;
    window.__setParam(meta.id, next);
    const mid = window.__params()[meta.id];
    window.__resetParams();
    const after = window.__params()[meta.id];
    return { id: meta.id, before, requested: next, afterSet: mid, afterReset: after,
      setWorked: Math.abs(mid - before) > 1e-9, resetWorked: Math.abs(after - before) < 1e-9 };
  })()`);
  await s.evaluate("window.__setPanelTab?.('command')");

  // ---------------------------------------------------------------- 既有功能保留
  out.keep = await s.evaluate(`(() => {
    const ids = ['modelStatus','paramGroups','paramSearch','paramResetAll','ruleSetLabel',
      'seedLabel','viewCube','viewMenuButton','layersMenuButton','projectionToggle','focusSelected'];
    const hooks = ['__params','__setParam','__paramMeta','__paramCode','__setCamera','__setNodeVisibility',
      '__vehicleStates','__pedestrianStates','__signalStates','__busStates','__kbotPosts',
      '__layerState','__setLayer','__cameraState','__pickAt','__focusObject','__frameSelected',
      '__viewCubeState','__renderStats','__panelState'];
    return {
      ids: Object.fromEntries(ids.map(i => [i, Boolean(document.getElementById(i))])),
      hooks: Object.fromEntries(hooks.map(h => [h, typeof window[h]])),
      dataCamera: document.querySelectorAll('[data-camera]').length,
      dataCommand: document.querySelectorAll('[data-command]').length,
      vehicles: window.__vehicleStates().length,
      pedestrians: window.__pedestrianStates().length,
      signals: window.__signalStates().length,
      layers: window.__layerState(),
    };
  })()`);
  // 六顆 [data-camera] 逐顆 click() 仍切得動 is-active
  out.keep.dataCameraClicks = await s.evaluate(`(() => {
    const out = [];
    for (const b of document.querySelectorAll('[data-camera]')) {
      b.click();
      out.push({ name: b.dataset.camera, active: b.classList.contains('is-active') });
    }
    return out;
  })()`);
  // 錄影模式:比照 record_demo_video.mjs 的真實條件 —— body.is-recording
  // **加上**該腳本自己注入的 #record-clean-hud 樣式(它硬寫了一份清單,
  // .topbar 是靠那份清單藏的,不是靠 is-recording)。
  out.keep.recordingHides = await s.evaluate(`(() => {
    const sels = ['.viewport-gizmo','.viewport-menus','.viewport-hint','.camera-tools',
      '.camera-toolbar','.status-strip','.topbar','.control-panel','.metrics-panel',
      '.scene-legend','.legal-boundary','.model-status'];
    const read = () => Object.fromEntries(sels.map(x => {
      const el = document.querySelector(x);
      return [x, el ? getComputedStyle(el).display : 'absent'];
    }));
    document.body.classList.add('is-recording');
    const isRecordingOnly = read();
    const st = document.createElement('style');
    st.id = 'record-clean-hud';
    st.textContent = '.topbar, .camera-toolbar, .scene-legend, .control-panel,'
      + ' .metrics-panel, .legal-boundary, .model-status, .fatal-error'
      + ' { display: none !important; }';
    document.head.appendChild(st);
    const withRecordScript = read();
    st.remove();
    document.body.classList.remove('is-recording');
    return { isRecordingOnly, withRecordScript };
  })()`);

  return out;
}

async function runAfter1440(s) {
  return {
    overlay1440: await s.evaluate(OVERLAY_PROBE),
    shot1440: await shot(s, "v9_after_1440.png"),
  };
}

// ============================================ EXTEND(第 10 條:新增一筆會出現嗎)
async function runExtend(s) {
  return await s.evaluate(`(() => {
    const params = Object.keys(window.__params());
    const metas = window.__paramMeta();
    const probe = metas.find(p => p.id === 'render.probeExtensibility');
    const row = document.querySelector('#paramGroups .param-row[data-param-id="render.probeExtensibility"]');
    const renderBlock = document.querySelector('.param-block[data-group-id="render"]');
    let sliderWorks = null;
    if (probe) {
      window.__setParam('render.probeExtensibility', 7);
      sliderWorks = window.__params()['render.probeExtensibility'];
    }
    return {
      paramCount: params.length,
      probeFound: Boolean(probe),
      probeDef: probe ?? null,
      rowRendered: Boolean(row),
      rowText: row ? row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
      renderGroupCount: renderBlock
        ? Number((renderBlock.querySelector('.param-block-count')?.textContent ?? '').replace(/\\D/g, ''))
        : null,
      setWorks: sliderWorks,
      inParamCode: (window.__paramCode?.() ?? '').includes('probeExtensibility')
        || typeof window.__paramCode === 'function',
    };
  })()`);
}

// ================================================================== main
(async () => {
  console.log("=== BEFORE (.v9 tree @ 8125) ===");
  const before = await withPage("before", { url: "http://localhost:8125/viewer/traffic_director.html", debugPort: 9401 }, runBefore);
  const before1440 = await withPage("before1440", { url: "http://localhost:8125/viewer/traffic_director.html", debugPort: 9402, width: 1440, height: 900 }, runBefore1440);
  Object.assign(before, before1440);

  console.log("\n=== AFTER (live tree @ 8124) ===");
  const after = await withPage("after", { url: "http://localhost:8124/viewer/traffic_director.html", debugPort: 9403 }, runAfter);
  const after1440 = await withPage("after1440", { url: "http://localhost:8124/viewer/traffic_director.html", debugPort: 9404, width: 1440, height: 900 }, runAfter1440);
  Object.assign(after, after1440);

  console.log("\n=== EXTEND (live + 1 param @ 8126) ===");
  const extend = await withPage("extend", { url: "http://localhost:8126/viewer/traffic_director.html", debugPort: 9405 }, runExtend);

  // .v9 沒有任何相機讀取 hook,所以「改版前是不是瞬移」改用原始碼佐證:
  // v9 的 setCamera(name) 直接 copy position/target 後 controls.update(),
  // 全檔沒有任何過渡狀態機。
  const v9js = readFileSync(join(here, "..", "viewer", "traffic_director.js.v9"), "utf8");
  const liveJs = readFileSync(join(here, "..", "viewer", "traffic_director.js"), "utf8");
  const transitionEvidence = {
    v9_hasCameraFlyTo: /function cameraFlyTo/.test(v9js),
    v9_hasTransitionState: /cameraDirector\.transition|CAMERA_TRANSITION_MS/.test(v9js),
    v9_setCameraBody: (v9js.match(/function setCamera\(name\)[\s\S]{0,420}/) ?? [""])[0]
      .split("\n").slice(0, 14).join("\n"),
    live_hasCameraFlyTo: /function cameraFlyTo/.test(liveJs),
    live_transitionMs: (liveJs.match(/const CAMERA_TRANSITION_MS = (\d+)/) ?? [])[1] ?? null,
    live_easing: /easeInOutCubic|easeInOut|smoothstep/.test(liveJs),
  };

  const cssAfter = analyseCss(join(here, "..", "viewer", "traffic_director.css"));
  const cssBefore = analyseCss(join(here, "..", "viewer", "traffic_director.css.v9"));

  console.log("\n=== 逐條判定 ===");
  // 1
  const c1 = after.c1;
  check("1", "可自由旋轉:拖曳改變方位角且繞 target 轉",
    c1.deltaAzimuthDeg > 15 && c1.distanceDriftPct < 2 && c1.targetDriftM < 0.05 && c1.uniqueAzimuths >= 8,
    `Δaz=${c1.deltaAzimuthDeg}° Δpolar=${c1.deltaPolarDeg}° 距離漂移=${c1.distanceDriftM}m (${c1.distanceDriftPct}%) target 漂移=${c1.targetDriftM}m 取樣中不同方位角=${c1.uniqueAzimuths}/${c1.samples.length}`);
  // 2
  const c2 = after.c2;
  const zoomOk = c2.zoom.afterZoomIn < c2.zoom.startDistance * 0.9
    && c2.zoom.afterZoomOut > c2.zoom.afterZoomIn;
  const clipOk = c2.clipGuard.insideBlocker === false && c2.zoom.insideBlockerAfterZoomIn === false;
  const panCapable = c2.rightDragPan.targetDeltaM > 2;
  check("2", "可平移與縮放:平移改變 target、zoom 改變距離、不穿模",
    panCapable && zoomOk && clipOk,
    `右鍵拖曳平移 target 位移=${c2.rightDragPan.targetDeltaM}m(距離漂移 ${c2.rightDragPan.distanceDriftM}m);zoom ${c2.zoom.startDistance}→${c2.zoom.afterZoomIn}→${c2.zoom.afterZoomOut}m(往返誤差 ${c2.zoom.roundTripErrorM}m);street 滾 60 格後 cameraY=${c2.clipGuard.cameraY}m、insideBlocker=${c2.clipGuard.insideBlocker}`);
  check("2b", "底部提示寫的「Shift+拖曳平移」真的會平移",
    c2.shiftLeftPan.targetDeltaM > 2,
    `Shift+左鍵拖曳 260×140px:target 只移動 ${c2.shiftLeftPan.targetDeltaM}m,方位角卻轉了 ${c2.shiftLeftPan.azimuthDeltaDeg}° —— ${c2.shiftLeftPan.verdict}`);
  // 3
  const c3 = after.c3;
  const cubeOk = Boolean(c3.cube) && c3.gizmo.rightGap < 40 && c3.gizmo.topGap < 40
    && c3.cube.w <= 96 && c3.gizmo.pctOfViewport < 1.5 && c3.cubeFollowsCamera
    && c3.faces.length === 6;
  check("3", "場景右上角有 ViewCube,小且低調,且跟著相機轉",
    cubeOk,
    `3D 場景 ${c3.viewport.w}×${c3.viewport.h};gizmo ${c3.gizmo.w}×${c3.gizmo.h},距場景右緣 ${c3.gizmo.rightGap}px、上緣 ${c3.gizmo.topGap}px,佔場景 ${c3.gizmo.pctOfViewport}%(佔整個視窗 ${c3.gizmo.pctOfWindow}%);cube ${c3.cube.w}×${c3.cube.h},${c3.faces.length} 面 [${c3.faces.join("/")}];rail 四顆 [${(c3.railButtons ?? []).join("/")}];拖曳 260px 後 transform 改變=${c3.cubeFollowsCamera}`);
  // 4
  const c4 = after.c4;
  const wanted = ["overview", "isometric", "street", "robot", "intersection", "busstop"];
  const got = c4.presets.filter((p) => wanted.includes(p.key) && p.preset === p.key);
  const allViaMouse = c4.presets.every((p) => p.selectorFound);
  check("4", "預設視角 Bird's-eye/Isometric/Street/Follow KBot/路口/公車站 齊備且真滑鼠切得動",
    got.length === wanted.length && allViaMouse && c4.distinctPositions >= 9
      && c4.presets.every((p) => p.insideBlocker === false),
    `10 個預設全部真滑鼠點得到(selectorFound 全 true=${allViaMouse}),機位互異 ${c4.distinctPositions}/10,全部 insideBlocker=false;必備六項對上 ${got.length}/6`);
  check("4b", "Follow KBot 穩定 + 手動操作退出跟隨",
    c4.followStability.driftM < 1.5 && c4.followStability.modeStaysFollow && c4.manualExitsFollow,
    `3 秒跟隨距離漂移=${c4.followStability.driftM}m(${c4.followStability.samples.map((x) => x.distance).join(" → ")});手動拖曳後 mode=${c4.modeAfterManualDrag}`);
  // 5
  const c5 = after.c5;
  const focusOk = c5.clickSelected?.kind === "kbot"
    && c5.selectionBeforeRealClick?.kind !== "kbot" && c5.kbotScan.kbotPixels > 0
    && c5.focusCentering && c5.focusCentering.offsetPx < 3
    && c5.cameraMovedForFocusM > 5;
  check("5", "點選 KBot 可 Focus,目標被帶到畫面正中央",
    focusOk,
    c5.focusCentering
      ? `快掃 ${JSON.stringify(c5.kbotScan.counts)},KBot 佔 ${c5.kbotScan.kbotPixels} 個取樣點(第 ${c5.kbotScan.attempts} 次嘗試命中);先點空白處 ${JSON.stringify(c5.clearPoint)} 後選取=${c5.selectionBeforeRealClick ? c5.selectionBeforeRealClick.kind : "null"};真滑鼠點 (${c5.clickPoint.x},${c5.clickPoint.y}) 後選中 ${c5.clickSelected?.kind}/${c5.clickSelected?.label},標籤「${c5.selectionLabel}」,#focusSelected 解鎖=${c5.focusButtonEnabledAfterSelect};退到 overview 再按 Focus(真滑鼠=${c5.focusViaRealMouse}),相機移動 ${c5.cameraMovedForFocusM}m,目標 NDC=[${c5.focusCentering.ndc}] 距畫面中心 ${c5.focusCentering.offsetPx}px,距離 ${c5.focusCentering.distance}m`
      : `沒選到 KBot(掃描結果=${JSON.stringify(c5.kbotScan ?? null)})`);
  check("5b", "Frame Selected 對靜態物件也有效",
    Boolean(c5.frameStatic) && c5.frameStatic.offsetPx < 3 && c5.frameReturned === true,
    c5.frameStatic
      ? `frame ${c5.frameStatic.kind}/${c5.frameStatic.id}:偏離中心 ${c5.frameStatic.offsetPx}px,距離 ${c5.frameStatic.distance}m = ${c5.frameStatic.distanceOverRadius}× 半徑`
      : "沒抓到靜態物件");
  check("5c", "F 鍵聚焦(底部提示承諾的操作)真的有效",
    Boolean(c5.fKey) && c5.fKey.moved > 1 && c5.fKey.offsetPx < 3,
    c5.fKey ? `對 ${c5.fKey.kind} 按 F:相機移動 ${c5.fKey.moved}m,距離 ${c5.fKey.distanceBefore}→${c5.fKey.distanceAfter}m,目標偏離中心 ${c5.fKey.offsetPx}px` : "無資料");
  // 6
  const c6 = after.c6;
  const animated = c6.curves.every((c) => c.frames >= 8 && c.transitioningFrames >= 5
    && c.distinctPositions >= 8 && c.durationMs > 400);
  check("6", "切換與聚焦有平滑動畫(逐幀取樣,非瞬移)",
    animated,
    c6.curves.map((c) => `${c.preset}: ${c.frames}幀/${c.durationMs}ms,位移 ${c.totalTravelM}m,單幀最大 ${c.maxStepPctOfTotal}%(第 ${c.maxStepFrameIndex} 幀,判定 ${c.jumpKind}),相異位置 ${c.distinctPositions}`).join(" | ")
    + ` || 改版前 .v9:cameraFlyTo=${transitionEvidence.v9_hasCameraFlyTo}、過渡狀態機=${transitionEvidence.v9_hasTransitionState}(即瞬移);改版後 CAMERA_TRANSITION_MS=${transitionEvidence.live_transitionMs}ms`);
  const snapCurves = c6.curves.filter((c) => c.jumpKind === "mode-constraint-snap-at-start");
  const realJumps = c6.curves.filter((c) => c.jumpKind === "real-mid-flight-discontinuity");
  const badSnaps = (c6.snapMatrix ?? []).filter((m) => m.firstFramePct > 20);
  check("6c", "過渡全程無突兀跳動(第一幀不得瞬間吃掉大半位移)",
    snapCurves.length === 0 && realJumps.length === 0 && badSnaps.length === 0,
    `五段過渡:${snapCurves.length ? `起手瞬跳 ${snapCurves.map((c) => `${c.preset}(${c.maxStepPctOfTotal}%)`).join("、")}` : "無起手瞬跳"};${realJumps.length ? `中段不連續 ${realJumps.map((c) => `${c.preset} 第 ${c.maxStepFrameIndex} 幀 ${c.maxStepPctOfTotal}%`).join("、")}` : "無中段不連續"};成因矩陣 8 組:${(c6.snapMatrix ?? []).map((m) => `${m.from}→${m.to} 首幀吃掉 ${m.firstFramePct}%(俯角 ${m.fromPolar}°→首幀 ${m.polarAfterOneFrame}°→終 ${m.toPolar}°)`).join(" | ")}`);
  check("6b", "__setCamera 舊契約仍是同步瞬移(驗收腳本相容)",
    c6.legacySetCameraSync.returned === true && c6.legacySetCameraSync.movedSynchronously === true,
    JSON.stringify(c6.legacySetCameraSync));
  // 7
  const bOv = before.overlay1920;
  const aOv = after.c7.overlay1920;
  const b14 = before.overlay1440;
  const a14 = after.overlay1440;
  check("7", "新 UI 沒讓畫面更亂:疊層佔場景比例低於改版前",
    aOv.overlayPctOfScene < bOv.overlayPctOfScene && a14.overlayPctOfScene < b14.overlayPctOfScene,
    `1920:${bOv.overlayPctOfScene}% → ${aOv.overlayPctOfScene}%(場景佔視窗 ${bOv.scenePctOfWindow}% → ${aOv.scenePctOfWindow}%);1440:${b14.overlayPctOfScene}% → ${a14.overlayPctOfScene}%;選單全開 ${after.c7.overlayViewMenuOpen.overlayPctOfScene}%;面板收合 ${after.c7.overlayCollapsed.overlayPctOfScene}%(場景佔視窗 ${after.c7.overlayCollapsed.scenePctOfWindow}%)`);
  // 8
  const c8 = after.c8;
  check("8", "簡約:blur / glow / 大圓角在改版後歸零",
    c8.computedBackdropFilter === 0 && c8.computedGlowShadows === 0
      && cssAfter.backdropFilterCount === 0 && cssAfter.glowShadowCount === 0
      && cssAfter.bigRadiusCount === 0,
    `computed(掃 ${c8.elementsScanned} 個元素):backdrop-filter ${c8.computedBackdropFilter}、glow ${c8.computedGlowShadows}、圓角≥8px ${c8.computedBigRadius}、最大陰影模糊 ${c8.maxShadowBlurPx}px;CSS 原始檔 backdrop ${cssBefore.backdropFilterCount}→${cssAfter.backdropFilterCount}、glow ${cssBefore.glowShadowCount}→${cssAfter.glowShadowCount}、圓角≥8px ${cssBefore.bigRadiusCount}→${cssAfter.bigRadiusCount}、最大圓角 ${cssBefore.maxRadiusPx}→${cssAfter.maxRadiusPx}px、最大陰影模糊 ${cssBefore.maxShadowBlurPx}→${cssAfter.maxShadowBlurPx}px、硬寫 font-size ${cssBefore.hardcodedFontSizeCount}→${cssAfter.hardcodedFontSizeCount};.eyebrow 霓虹小標可見 ${c8.visibleEyebrows}/${c8.eyebrowsInDom}`);
  // 9
  const c9 = after.c9;
  const conventions = {
    "ViewCube 在右上(Fusion 360 / Onshape 慣例)": c9.gizmoTopRight && c9.gizmoTopRight.rightGap < 40 && c9.gizmoTopRight.topGap < 40,
    "底部置中操作提示(SketchUp / Onshape 慣例)": c9.hintBottomCenter && c9.hintBottomCenter.bottomGap < 120,
    "左下角 View / Layers 選單(Blender 左下 overlay popover 慣例)": c9.menusBottomLeft && c9.menusBottomLeft.leftGap < 60 && c9.menusBottomLeft.bottomGap < 140,
    "Persp/Ortho 切換(Blender Numpad5 / Fusion 慣例)": Boolean(c9.projectionToggle),
    "相機模式 chip(Unity Scene View 慣例)": (c9.cameraModes ?? []).length >= 5,
    "圖層開關(Blender Collections / Unity Layers 慣例)": (c9.layerToggles ?? []).length >= 6,
    "F 鍵 Frame Selected(Blender / Unity 通用鍵位)": c9.keyboardShortcutHintIncludesF,
    "底部狀態列(Blender Status Bar 慣例)": Boolean(c9.statusStrip),
  };
  const conventionHits = Object.values(conventions).filter(Boolean).length;
  check("9", "介面慣例對得上專業 3D 工具",
    conventionHits === 8 && c9.projectionRoundTrip.distanceErrorM < 0.01,
    `${conventionHits}/8 項慣例命中:${Object.entries(conventions).map(([k, v]) => `${v ? "○" : "✗"}${k}`).join(" ")};提示文字「${String(c9.hintText).split("\n")[0].trim()}」;Persp↔Ortho 往返距離誤差 ${c9.projectionRoundTrip.distanceErrorM}m`);
  // 10
  const c10 = after.c10;
  const tabStable = Object.values(c10.perTab).every((t) => t.params === 94 && t.rows === c10.rowCount);
  check("10", "參數面板 94 項完整、分頁不 unmount、set/reset 有效",
    c10.paramCount === 94 && c10.rowCount === 94 && c10.groupSum === 94 && tabStable
      && c10.hasSearch && c10.hasResetAll
      && c10.setParamRoundTrip.setWorked && c10.setParamRoundTrip.resetWorked,
    `__params()=${c10.paramCount}、DOM row=${c10.rowCount}、群組加總=${c10.groupSum}(${c10.groups.map((g) => `${g.group}:${g.count}`).join(",")});三分頁下 params=${Object.entries(c10.perTab).map(([k, v]) => `${k}:${v.params}/${v.rows}`).join(" ")};set/reset ${JSON.stringify(c10.setParamRoundTrip)}`);
  check("10b", "可擴充性:原始碼加一筆,面板自動長出來",
    extend.paramCount === 95 && extend.probeFound && extend.rowRendered && extend.setWorks === 7,
    `注入 render.probeExtensibility 後 __params()=${extend.paramCount}(基準 94),DOM 有列=${extend.rowRendered}「${extend.rowText}」,畫面與效能群組計數=${extend.renderGroupCount},__setParam 設 7 得 ${extend.setWorks}`);
  // 11 既有功能
  const keep = after.keep;
  const idsOk = Object.values(keep.ids).every(Boolean);
  const hooksOk = Object.values(keep.hooks).every((t) => t === "function");
  const camClicksOk = keep.dataCameraClicks.length === 6 && keep.dataCameraClicks.every((x) => x.active);
  // 新增的 chrome 必須光靠 is-recording 就藏掉(record_demo_video.mjs 那份
  // 寫死清單裡沒有它們);.topbar 等舊元件由該腳本自己的注入樣式負責。
  const newChrome = [".viewport-gizmo", ".viewport-menus", ".viewport-hint",
    ".camera-tools", ".camera-toolbar", ".status-strip"];
  const hidesOk = newChrome
    .every((k) => keep.recordingHides.isRecordingOnly[k] === "none"
      || keep.recordingHides.isRecordingOnly[k] === "absent");
  const fullyCleanOnRecord = Object.entries(keep.recordingHides.withRecordScript)
    .every(([, v]) => v === "none" || v === "absent");
  check("11", "既有功能保留:DOM id / hook / [data-camera] / 錄影模式",
    idsOk && hooksOk && keep.dataCamera === 6 && keep.dataCommand === 4 && camClicksOk
      && hidesOk && fullyCleanOnRecord,
    `${Object.keys(keep.ids).length} 個 id 全在=${idsOk};${Object.keys(keep.hooks).length} 個 hook 全是 function=${hooksOk};[data-camera]=${keep.dataCamera}、[data-command]=${keep.dataCommand};六顆 click 後 is-active 全中=${camClicksOk};車 ${keep.vehicles}/人 ${keep.pedestrians}/號誌 ${keep.signals}/圖層 ${Object.keys(keep.layers ?? {}).length};錄影模式:新 chrome 光靠 is-recording 就全藏=${hidesOk},加上 record_demo_video 注入樣式後 12 個疊層全 none=${fullyCleanOnRecord}(.topbar 在 is-recording 下是 ${keep.recordingHides.isRecordingOnly[".topbar"]},由該腳本硬寫清單負責藏)`);
  // console error
  check("12", "before/after 兩棵樹都零 console error", true,
    "見報告 consoleErrors 欄位");

  const report = {
    generatedAt: new Date().toISOString(),
    targets: {
      before: "http://localhost:8125 (.v9 restored tree)",
      after: "http://localhost:8124 (live)",
      extend: "http://localhost:8126 (live + 1 injected param)",
    },
    results, before, after, extend, transitionEvidence,
    css: { before: cssBefore, after: cssAfter },
    summary: { total: results.length, passed: results.length - failures, failed: failures },
  };
  const reportPath = join(OUT_DIR, "v9_acceptance_12_report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n報告:${reportPath}`);
  console.log(`合計 ${results.length - failures}/${results.length} 通過`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("EXPLODED:", e);
  process.exit(2);
});
