// san 四項抱怨的實拍驗收(可重跑,before/after 同一支腳本)。
//   1 走路沒在斑馬線上  2 沒有在指揮交通  3 指揮位置在公車站不在斑馬線中間
//   4 人與車要擬物化
// 用法:
//   node mujoco/verify_san_complaints.mjs                       # after(8124)
//   PORT=8125 TAG=before DEBUG_PORT=9351 node mujoco/verify_san_complaints.mjs
// 先決條件:對應的 serve.py 已在該 port 起著。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_shots");
const PORT = Number(process.env.PORT ?? 8124);
const TAG = process.env.TAG ?? "after";
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9352);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 160000);
const PROFILE_DIR = `/private/tmp/claude-501/-Users-san/chrome-san-${TAG}`;
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const pending = new Map();
let socket = null;
function rawSend(method, params = {}, sessionId) {
  const id = (nextId += 1);
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 300000);
  });
}
let send = rawSend;
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page exception: ${result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}
async function waitUntil(expression, { timeoutMs = 150000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}
async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const buffer = Buffer.from(shot.data, "base64");
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, buffer);
  return { name, file, bytes: buffer.length };
}
const setSwitch = (id, want) => evaluate(`(() => { const el = document.querySelector('#${id}');
  if (!el) return null; if (el.checked !== ${want}) el.click(); return el.checked; })()`);
const setSelect = (id, value) => evaluate(`(() => { const el = document.querySelector('#${id}');
  if (!el) return null; el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
const setCamera = (pos, target) => evaluate(
  `window.__setCamera(${JSON.stringify(pos)}, ${JSON.stringify(target)})`);

// ---------------------------------------------------------------- 幾何(node 端,兩個 build 用同一份判定)
const kerbT = (side, s) => (side > 0 ? 15.66 : -16.67) + 0.0298 * (s + 17.5);
const onRoadway = (s, t) => t < kerbT(1, s) - 0.05 && t > kerbT(-1, s) + 0.05;
// 中央公車月台(traffic_simulation_core BUS_PLATFORMS 實測值,兩版一致)
const onBusPlatform = (s, t) => (
  (s >= 15.6 && s <= 66 && Math.abs(t - 5.2) <= 1.1)
  || (s <= -14.6 && s >= -66 && Math.abs(t + 3.4) <= 1.1)
);
const median = (a) => {
  if (!a.length) return null;
  const v = [...a].sort((x, y) => x - y);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`, "--window-size=1920,1080",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (c) => { chromeStderr += c.toString(); });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  throw new Error(`Chrome 沒起來:\n${chromeStderr}`);
}
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(String(e.message ?? e.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message)); else ok(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text ?? "unknown");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  });
}

const report = { tag: TAG, port: PORT, consoleErrors, shots: [] };
let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await rawSend("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rawSend("Target.attachToTarget", { targetId, flatten: true });
  send = (m, p = {}) => (m.startsWith("Target.") || m.startsWith("Browser.")
    ? rawSend(m, p) : rawSend(m, p, sessionId));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(
    "Boolean(window.__trafficDirectorDebug && window.__setCamera"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false)");
  if (!ready) throw new Error("viewer 沒有在 150 秒內載入完成");
  await waitUntil("window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true",
    { timeoutMs: 90000 });

  report.hooks = await evaluate(`({
    handOffsets: typeof window.__kbotHandOffsets === 'function',
    armOffsets: typeof window.__kbotArmOffsets === 'function',
    paintedNodeBounds: typeof window.__paintedNodeBounds === 'function',
    actorRenderAudit: typeof window.__actorRenderAudit === 'function',
    pedestrianGait: typeof window.__pedestrianGait === 'function',
  })`);
  report.panel = {
    autoMode: await setSwitch("autoMode", true),
    motionEffects: await setSwitch("motionEffects", true),
    highPerformance: await setSwitch("highPerformance", true),
    recordingMode: await setSwitch("recordingMode", false),
    downstreamBlocked: await setSwitch("downstreamBlocked", false),
    trafficDensity: await setSelect("trafficDensity", "normal"),
    pacingPreset: await setSelect("pacingPreset", "standard"),
  };
  // 畫線帶:新版有 hook 就現場量並存檔;舊版沒有 hook 就吃同一份存檔
  // (環境 GLB 兩版完全相同 —— before tree 是 symlink 到同一顆檔案)。
  const STRIPES_FILE = process.env.STRIPES_FILE ?? join(OUT_DIR, "straight_crosswalk_stripes.json");
  if (report.hooks.paintedNodeBounds) {
    report.stripes = await evaluate("window.__paintedNodeBounds('MainCrosswalk_Straight.*Stripe')");
    writeFileSync(STRIPES_FILE, `${JSON.stringify(report.stripes, null, 2)}\n`);
    report.stripeSource = "live";
  } else if (existsSync(STRIPES_FILE)) {
    report.stripes = JSON.parse(readFileSync(STRIPES_FILE, "utf8"));
    report.stripeSource = STRIPES_FILE;
  }
  report.postsAtStart = process.env.POSTS_OVERRIDE
    ? JSON.parse(process.env.POSTS_OVERRIDE)
    : await evaluate(
      "window.__kbotPosts ? window.__kbotPosts().posts"
      + " : (window.__trafficDirectorDebug.snapshot().kbotMotion.posts ?? null)");

  // ---------------------------------------------------------------- 取樣
  await evaluate(`window.__sanSample = (durationMs) => new Promise((resolve) => {
    const out = []; const t0 = performance.now(); let last = -1e9;
    const tick = () => {
      const now = performance.now();
      if (now - last >= 100) {
        last = now;
        const s = window.__trafficDirectorDebug.snapshot();
        const km = s.kbotMotion;
        out.push({
          ms: now - t0,
          p: km.holderPosition,
          yaw: km.holderYawRad,
          walk: km.walkKind,
          station: km.station,
          safeZone: km.safeZone,
          onRoad: km.robotOnRoadway,
          phase: s.phase,
          gesture: s.activeKbotGesture,
          arms: window.__kbotArmOffsets ? window.__kbotArmOffsets() : null,
          hands: window.__kbotHandOffsets ? window.__kbotHandOffsets() : null,
        });
      }
      if (performance.now() - t0 < durationMs) requestAnimationFrame(tick);
      else resolve(out);
    };
    requestAnimationFrame(tick);
  })`);
  // SAMPLE_MS=0 → 只補拍截圖(不覆蓋既有的量測報告)
  const samples = SAMPLE_MS >= 1000 ? await evaluate(`window.__sanSample(${SAMPLE_MS})`) : [];
  if (samples.length > 10) {
  writeFileSync(join(OUT_DIR, `${TAG}_san_samples.json`), `${JSON.stringify(samples)}\n`);
  report.sampleCount = samples.length;
  report.sampleSpanS = Number(((samples.at(-1).ms - samples[0].ms) / 1000).toFixed(1));

  // ---------------------------------------------------------------- 分析
  const stripes = report.stripes ?? [];
  const bandT = stripes.length
    ? { min: Math.min(...stripes.map((x) => x.tMin)), max: Math.max(...stripes.map((x) => x.tMax)) }
    : null;
  const inStripe = (s, t) => stripes.some((x) => s >= x.sMin - 0.1 && s <= x.sMax + 0.1
    && t >= x.tMin - 0.1 && t <= x.tMax + 0.1);
  const inBand = (s, t) => stripes.some((x) => s >= x.sMin - 0.1 && s <= x.sMax + 0.1)
    && bandT && t >= bandT.min - 0.1 && t <= bandT.max + 0.1;

  let moveS = 0; let standS = 0; let platformS = 0;
  let roadS = 0; let roadPaintS = 0; let roadBandS = 0;
  const roadSValues = [];
  const walkingRoadSamples = [];
  const speeds = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].ms - samples[i - 1].ms) / 1000;
    if (dt <= 0 || dt > 1.5) continue;
    const a = samples[i - 1].p; const b = samples[i].p;
    const step = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const speed = step / dt;
    speeds.push(speed);
    const moving = speed > 0.08;
    if (moving) moveS += dt; else standS += dt;
    const [s, , t] = b;
    if (onBusPlatform(s, t)) platformS += dt;
    if (onRoadway(s, t)) {
      roadS += dt;
      roadSValues.push(s);
      if (inStripe(s, t)) roadPaintS += dt;
      if (inBand(s, t)) roadBandS += dt;
      if (moving) walkingRoadSamples.push({ s: Number(s.toFixed(3)), t: Number(t.toFixed(3)) });
    }
  }
  const totalS = moveS + standS;
  report.motion = {
    totalS: Number(totalS.toFixed(1)),
    standingS: Number(standS.toFixed(1)),
    standingPct: Number((standS / totalS * 100).toFixed(1)),
    movingS: Number(moveS.toFixed(1)),
    busPlatformS: Number(platformS.toFixed(1)),
    busPlatformPct: Number((platformS / totalS * 100).toFixed(1)),
    onRoadwayS: Number(roadS.toFixed(1)),
    onRoadwayPaintPct: roadS > 0 ? Number((roadPaintS / roadS * 100).toFixed(1)) : null,
    onRoadwayBandPct: roadS > 0 ? Number((roadBandS / roadS * 100).toFixed(1)) : null,
    roadwaySMin: roadSValues.length ? Number(Math.min(...roadSValues).toFixed(3)) : null,
    roadwaySMax: roadSValues.length ? Number(Math.max(...roadSValues).toFixed(3)) : null,
    roadwaySSpread: roadSValues.length
      ? Number((Math.max(...roadSValues) - Math.min(...roadSValues)).toFixed(3)) : null,
    walkingRoadSampleHead: walkingRoadSamples.slice(0, 12),
  };

  // 崗位駐留:離各崗位 < 0.6 m 且靜止
  const posts = report.postsAtStart ?? null;
  const dwell = {};
  if (posts) {
    for (const id of Object.keys(posts)) {
      const post = posts[id];
      let total = 0; let best = 0; let run = 0;
      for (let i = 1; i < samples.length; i += 1) {
        const dt = (samples[i].ms - samples[i - 1].ms) / 1000;
        if (dt <= 0 || dt > 1.5) continue;
        const b = samples[i].p;
        if (Math.hypot(b[0] - post.x, b[2] - post.z) < 0.6) {
          total += dt; run += dt; best = Math.max(best, run);
        } else run = 0;
      }
      dwell[id] = {
        post: { x: post.x, z: post.z },
        totalS: Number(total.toFixed(1)),
        pct: Number((total / totalS * 100).toFixed(1)),
        longestS: Number(best.toFixed(1)),
        inStripe: stripes.length ? inStripe(post.x, post.z) : null,
        inBand: stripes.length ? inBand(post.x, post.z) : null,
        onBusPlatform: onBusPlatform(post.x, post.z),
      };
    }
  }
  report.postDwell = dwell;

  // 「真的在崗位上站定指揮」= 腳沒動 且 距離任一崗位 < 0.6 m。
  // (單看「站定」會把『停在公車站月台不動』也算成指揮,舊版就是這樣。)
  if (posts) {
    const postList = Object.values(posts);
    let standAtPost = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const dt = (samples[i].ms - samples[i - 1].ms) / 1000;
      if (dt <= 0 || dt > 1.5) continue;
      const a = samples[i - 1].p; const b = samples[i].p;
      if (Math.hypot(b[0] - a[0], b[2] - a[2]) / dt > 0.08) continue;
      if (postList.some((q) => Math.hypot(b[0] - q.x, b[2] - q.z) < 0.6)) standAtPost += dt;
    }
    report.motion.standingAtPostS = Number(standAtPost.toFixed(1));
    report.motion.standingAtPostPct = Number((standAtPost / totalS * 100).toFixed(1));
  }

  // 手臂/手掌擺動幅度:peak-to-peak(mm)。窗必須「腳沒動、而且朝向沒轉」
  // ——offset 是相對 holder 位置但沒有去掉 yaw,轉身 90° 會讓手臂 offset
  // 位移 0.5 m,不排除掉會把「轉身」誤讀成「在打手勢」。
  const swing = (key) => {
    const windows = [];
    let run = [];
    for (let i = 1; i < samples.length; i += 1) {
      const dt = (samples[i].ms - samples[i - 1].ms) / 1000;
      const a = samples[i - 1].p; const b = samples[i].p;
      const still = dt > 0 && dt < 1.5
        && Math.hypot(b[0] - a[0], b[2] - a[2]) / dt <= 0.08
        && Math.abs(samples[i].yaw - samples[i - 1].yaw) <= 0.002;
      const value = samples[i][key];
      if (still && value && value.left && value.right) run.push(value);
      else { if (run.length >= 25) windows.push(run); run = []; }
    }
    if (run.length >= 25) windows.push(run);
    const result = { windows: windows.length, left: [], right: [] };
    for (const w of windows) {
      for (const side of ["left", "right"]) {
        let best = 0;
        for (let axis = 0; axis < 3; axis += 1) {
          const vals = w.map((v) => v[side][axis]);
          best = Math.max(best, Math.max(...vals) - Math.min(...vals));
        }
        result[side].push(Number((best * 1000).toFixed(1)));
      }
    }
    return {
      windows: result.windows,
      leftMedianMm: median(result.left),
      rightMedianMm: median(result.right),
      leftMaxMm: result.left.length ? Math.max(...result.left) : null,
      rightMaxMm: result.right.length ? Math.max(...result.right) : null,
    };
  };
  report.armSwing = swing("arms");
  report.handSwing = report.hooks.handOffsets ? swing("hands") : null;

  report.gestureHistogram = samples.reduce((acc, s) => {
    acc[s.gesture] = (acc[s.gesture] ?? 0) + 1; return acc;
  }, {});
  report.stationHistogram = samples.reduce((acc, s) => {
    acc[s.station ?? "null"] = (acc[s.station ?? "null"] ?? 0) + 1; return acc;
  }, {});
  }

  // ---------------------------------------------------------------- 截圖
  const CAMS = {
    overview: [[-28, 35, -34], [8, 0.9, 0]],
    street: [[28, 4.8, -17], [2, 1.2, 0]],
    busstop: [[30, 11, 10], [19, 1.4, 2.6]],
    // 固定機位:兩個 build 用同一組座標,差別只在機器人站哪裡
    crosswalk: [[12.0, 6.0, -4.0], [15.0, 1.1, 8.33]],
  };

  // (1) 走路中:等到他真的在路面上移動時按快門
  const walkShot = await waitUntil(`(() => {
    const km = window.__trafficDirectorDebug.snapshot().kbotMotion;
    const p = km.holderPosition;
    const kerbPos = 15.66 + 0.0298 * (p[0] + 17.5);
    const kerbNeg = -16.67 + 0.0298 * (p[0] + 17.5);
    const onRoad = p[2] < kerbPos - 0.05 && p[2] > kerbNeg + 0.05;
    return (onRoad && p[2] > 4.5 && p[2] < 12.5) ? JSON.stringify(p) : null;
  })()`, { timeoutMs: 120000, intervalMs: 100 });
  if (walkShot) {
    const p = JSON.parse(walkShot);
    await setCamera([p[0] - 3.6, 2.6, p[2] - 5.0], [p[0], 1.0, p[2] + 0.4]);
    await sleep(100);
    report.walkingShotPos = p.map((v) => Number(v.toFixed(3)));
    report.shots.push(await screenshot(`${TAG}_san1_kbot_walking`));
  } else {
    report.walkingShotPos = null;
  }

  // (2) 指揮中特寫:優先等「行人相位 + 站定在行穿線崗位」,等不到就退而
  // 求其次拍「站定在任一崗位」(舊版根本不會去行穿線崗位,必須拍得到東西)。
  const crossPost = report.postsAtStart?.crosswalk ?? { x: 15, z: 8.33 };
  const atCrossPost = `(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    const km = s.kbotMotion; const p = km.holderPosition;
    return (km.walkKind === null || km.walkKind === undefined)
      && s.phase === 'pedestrian_crossing'
      && Math.hypot(p[0] - ${crossPost.x}, p[2] - ${crossPost.z}) < 0.6
      ? JSON.stringify(p) : null;
  })()`;
  const standingAnywhere = `(() => {
    const km = window.__trafficDirectorDebug.snapshot().kbotMotion;
    return (km.walkKind === null || km.walkKind === undefined)
      ? JSON.stringify(km.holderPosition) : null;
  })()`;
  let standShot = await waitUntil(atCrossPost, { timeoutMs: 130000, intervalMs: 150 });
  report.directingShotAtCrossPost = Boolean(standShot);
  if (!standShot) standShot = await waitUntil(standingAnywhere, { timeoutMs: 60000, intervalMs: 200 });
  if (standShot) {
    const p = JSON.parse(standShot);
    await setCamera([p[0] - 2.6, p[1] + 1.9, p[2] - 4.2], [p[0], p[1] + 1.05, p[2]]);
    await sleep(200);
    report.directingShotPos = p.map((v) => Number(v.toFixed(3)));
    report.directingShotState = await evaluate(
      "(() => { const s = window.__trafficDirectorDebug.snapshot();"
      + " return { phase: s.phase, gesture: s.activeKbotGesture,"
      + " station: s.kbotMotion.station, walk: s.kbotMotion.walkKind }; })()");
    report.shots.push(await screenshot(`${TAG}_san2_kbot_directing_closeup`));
    await sleep(400);
    report.shots.push(await screenshot(`${TAG}_san2_kbot_directing_closeup_b`));
  }

  // (3) 固定行穿線機位:等行人相位且他已站定(等不到就在相位中段直接拍)
  await setCamera(...CAMS.crosswalk);
  const settled = await waitUntil(atCrossPost, { timeoutMs: 130000, intervalMs: 150 });
  report.crosswalkShotSettled = Boolean(settled);
  if (!settled) {
    await waitUntil("window.__trafficDirectorDebug.snapshot().phase === 'pedestrian_crossing'",
      { timeoutMs: 150000, intervalMs: 200 });
    await sleep(6000);
  }
  await sleep(200);
  report.crosswalkShotState = await evaluate(
    "(() => { const s = window.__trafficDirectorDebug.snapshot();"
    + " return { phase: s.phase, pos: s.kbotMotion.holderPosition,"
    + " station: s.kbotMotion.station, safeZone: s.kbotMotion.safeZone }; })()");
  report.shots.push(await screenshot(`${TAG}_san3_crosswalk_fixedcam`));

  // (4) 擬物化:三個標準機位 + 逐型別特寫(尖峰車流)
  await setSelect("trafficDensity", "peak");
  await sleep(9000);
  report.renderStats = await evaluate(
    "window.__renderStats ? window.__renderStats()"
    + " : window.__trafficDirectorDebug.snapshot().render");
  if (report.hooks.actorRenderAudit) {
    report.actorAudit = await evaluate("window.__actorRenderAudit()");
  }
  report.actorParts = await evaluate(`(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    const by = {};
    for (const v of s.vehicles) {
      const b = by[v.type] ?? (by[v.type] = { n: 0, parts: 0 });
      b.n += 1; b.parts += v.visualParts.length;
    }
    const p = { n: 0, parts: 0 };
    for (const x of s.pedestrians) { p.n += 1; p.parts += x.visualParts.length; }
    by.pedestrian = p;
    return by;
  })()`);
  for (const [name, cam] of Object.entries(CAMS)) {
    if (name === "crosswalk") continue;
    await setCamera(...cam);
    await sleep(700);
    report.shots.push(await screenshot(`${TAG}_san4_actors_${name}`));
  }
  const closeupTypes = ["car", "bus", "scooter", "motorcycle", "bicycle"];
  for (const type of closeupTypes) {
    // 挑「離其他人車最遠」的一台,免得鏡頭被行人的後腦杓擋掉
    const target = await evaluate(`(() => {
      const s = window.__trafficDirectorDebug.snapshot();
      const others = [...s.pedestrians.map((p) => [p.s, p.t]),
        ...s.vehicles.map((v) => [v.s, v.t])];
      // 公車特寫要挑「沒停在月台」的那台,不然鏡頭會被候車亭雨棚擋掉
      const list = s.vehicles.filter((v) => v.type === ${JSON.stringify(type)}
        && v.s > -38 && v.s < 38
        && (v.type !== 'bus' || !v.busPlatform));
      if (!list.length) return null;
      const score = (v) => {
        let best = Infinity;
        for (const [os, ot] of others) {
          const d = Math.hypot(os - v.s, ot - v.t);
          if (d > 0.01) best = Math.min(best, d);
        }
        return best;
      };
      list.sort((a, b) => score(b) - score(a));
      return [list[0].s, list[0].t, Number(score(list[0]).toFixed(2))];
    })()`);
    if (!target) { report[`closeupMissing_${type}`] = true; continue; }
    report[`closeupClearance_${type}`] = target[2];
    const scale = type === "bus" ? 1.9 : 1.0;
    await setCamera(
      [target[0] - 4.6 * scale, 2.9 * scale, target[1] - 6.2 * scale],
      [target[0], 0.9 * scale, target[1]],
    );
    await sleep(260);
    report.shots.push(await screenshot(`${TAG}_san4_closeup_${type}`));
  }
  const pedTarget = await evaluate(`(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    const others = [...s.pedestrians.map((p) => [p.s, p.t]),
      ...s.vehicles.map((v) => [v.s, v.t])];
    const list = s.pedestrians.filter((p) => Math.abs(p.s) < 34);
    if (!list.length) return null;
    const score = (p) => {
      let best = Infinity;
      for (const [os, ot] of others) {
        const d = Math.hypot(os - p.s, ot - p.t);
        if (d > 0.01) best = Math.min(best, d);
      }
      return best;
    };
    list.sort((a, b) => score(b) - score(a));
    return [list[0].s, list[0].t, Number(score(list[0]).toFixed(2))];
  })()`);
  if (pedTarget) {
    report.closeupClearance_pedestrian = pedTarget[2];
    await setCamera([pedTarget[0] - 2.0, 1.75, pedTarget[1] - 2.8], [pedTarget[0], 0.95, pedTarget[1]]);
    await sleep(200);
    report.shots.push(await screenshot(`${TAG}_san4_closeup_pedestrian`));
    await sleep(400);
    report.shots.push(await screenshot(`${TAG}_san4_closeup_pedestrian_b`));
  }
  if (report.hooks.pedestrianGait) {
    report.pedestrianGait = (await evaluate("window.__pedestrianGait()")).slice(0, 6);
  }

  writeFileSync(
    join(OUT_DIR, samples.length > 10 ? `${TAG}_san_report.json` : `${TAG}_san_shots.json`),
    `${JSON.stringify({ ...report, samplesHead: samples.slice(0, 3) }, null, 2)}\n`);
  console.log(JSON.stringify({
    tag: TAG, motion: report.motion, postDwell: report.postDwell,
    armSwing: report.armSwing, handSwing: report.handSwing,
    renderStats: report.renderStats, actorParts: report.actorParts,
    actorAudit: report.actorAudit ?? null,
    crosswalkShotState: report.crosswalkShotState,
    directingShotState: report.directingShotState ?? null,
    stationHistogram: report.stationHistogram,
    consoleErrors: consoleErrors.length,
    shots: report.shots.map((s) => s.name),
  }, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(`FAILED: ${error.message}`);
} finally {
  try { await rawSend("Browser.close"); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
  socket?.close();
}
process.exit(exitCode);
