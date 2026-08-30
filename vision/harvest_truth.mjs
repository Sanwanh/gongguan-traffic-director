// 自我驗證迴圈的第 1 步:從 viewer 自己的 3D 場景產生「合成 CCTV 影格 + 座標真值」。
//
// 為什麼要這樣做:我們手上沒有真實 CCTV 的標註資料,但 viewer 知道每一台車、
// 每一個行人的精確 (s, t),也知道每一條白漆的精確 (s, t)。把場景截圖當作
// 「攝影機看到的畫面」,就得到一組完全免費、可重複、精度到公分的真值。
//
// 用法:
//   node harvest_truth.mjs                       # 預設 6 個機位
//   POSES='[{"tag":"a","pose":[[26,11,-19],[2,1.2,1]]}]' node harvest_truth.mjs
//   PORT=8124 OUT=truth node harvest_truth.mjs
//
// 產出(全部在 vision/truth/,已 gitignore):
//   shot_<tag>.png    1920x1080,recordingMode 開啟(畫面上沒有 UI)
//   truth_<tag>.json  {camera, affine, stripes[], other[], vehicles[], pedestrians[]}
//
// 硬規則 9:只殺自己 spawn 的那個 pid,絕不用 pgrep 模式砍 Chrome。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, process.env.OUT ?? "truth");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9413);
const PROFILE_DIR = process.env.PROFILE_DIR
  ?? "/private/tmp/claude-501/-Users-san/chrome-vision-harvest";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = process.env.CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = Number(process.env.WIDTH ?? 1920);
const H = Number(process.env.HEIGHT ?? 1080);
const SETTLE_MS = Number(process.env.SETTLE ?? 1600);

// 八個「像監視器」的機位:高處、俯角、看向路口。刻意涵蓋不同視距與方位,
// 因為實測顯示徑向偏差是逐機位的,不能跨機位共用一個修正常數。
//
// 這幾個座標是掃過候選集之後留下來的:viewer 的相機守衛會把落在建物內部的
// 機位推出來(實測 [6,13,26] 被推了 58 公尺,拍到的是屋頂內側,而真值仍然
// 宣稱 14 台車「在畫面內」)。被推走的機位會被標成 poseClamped,驗證時直接跳過。
const DEFAULT_POSES = [
  { tag: "p1", pose: [[26, 11, -19], [2, 1.2, 1]] },
  { tag: "p2", pose: [[-26, 12, 20], [0, 1.2, 0]] },
  { tag: "p3", pose: [[30, 9, 14], [4, 1.2, -2]] },
  { tag: "p4", pose: [[-8, 10, -26], [-1, 1.2, 3]] },
  { tag: "p5", pose: [[34, 13, 4], [0, 1.2, 2]] },
  { tag: "p6", pose: [[-34, 13, -4], [0, 1.2, -2]] },
  { tag: "p7", pose: [[12, 8, -20], [-4, 1.2, 4]] },
  { tag: "p8", pose: [[-12, 8, 20], [4, 1.2, -4]] },
];
const POSES = JSON.parse(process.env.POSES ?? JSON.stringify(DEFAULT_POSES));

mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const pending = new Map();
let socket = null;
function rawSend(method, params = {}, sessionId) {
  const id = (nextId += 1);
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve_, reject) => {
    pending.set(id, { resolve: resolve_, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }
    }, 120000);
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

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`, `--window-size=${W},${H}`,
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  throw new Error(`Chrome 沒起來:\n${chromeStderr}`);
}

function openSocket(url) {
  return new Promise((resolve_, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve_(ws));
    ws.addEventListener("error", (event) => reject(new Error(String(event.message ?? event.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
      }
    });
  });
}

let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const base = send;
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? base(method, params) : base(method, params, sessionId)
  );
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });

  // 硬規則 9:載入完成 = #modelStatus .status-dot 上沒有 is-loading / is-error。
  const ready = await waitUntil(
    "Boolean(window.__cameraState && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)");
  if (!ready) throw new Error("viewer 沒有在時限內載入完成");
  await sleep(4000);

  // --- 探測 sim -> world 仿射 ------------------------------------------
  // __setCamera 吃模擬座標,__cameraState 回 three.js 世界座標。
  // 注意:camera.position 會被 OrbitControls 的 min/maxDistance 夾住,
  // controls.target 不會 —— 所以拿 target 當探針,而且抬到 y=5 避開防穿模守衛。
  const probesSim = [[0, 5, 0], [10, 5, 0], [0, 5, 10], [0, 15, 0]];
  const probesWorld = [];
  for (const point of probesSim) {
    await evaluate(`window.__setCamera([26, 40, -19], [${point.join(",")}])`);
    probesWorld.push(await evaluate("window.__cameraState().target"));
  }
  const origin0 = probesWorld[0];
  const dy = probesWorld[3].map((v, i) => (v - origin0[i]) / 10);
  const affine = {
    origin: origin0.map((v, i) => v - dy[i] * 5),
    ds: probesWorld[1].map((v, i) => (v - origin0[i]) / 10),
    dt: probesWorld[2].map((v, i) => (v - origin0[i]) / 10),
    dy,
  };
  // 契約檢查:simulationRoot 是「旋轉 + z 鏡射 + 平移」,ds/dt 必須是水平單位
  // 向量、dy 必須是 (0,1,0)。不符就代表探針被夾住了,真值會是假的 —— 寧可
  // 直接失敗,也不要拿被夾住的仿射去產生一整批看起來很合理的錯真值。
  const bad = Math.abs(affine.ds[1]) > 1e-6 || Math.abs(affine.dt[1]) > 1e-6
    || Math.abs(Math.hypot(affine.ds[0], affine.ds[2]) - 1) > 1e-4
    || Math.abs(Math.hypot(affine.dt[0], affine.dt[2]) - 1) > 1e-4
    || Math.abs(affine.dy[1] - 1) > 1e-6;
  if (bad) throw new Error(`sim->world 探針被夾住,affine 不可信:${JSON.stringify(affine)}`);

  // recordingMode:把 UI 收掉,畫面只剩場景。
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (el && !el.checked) el.click(); return el ? el.checked : false; })()`);
  await sleep(600);

  // 世界座標 -> 模擬座標:解 [ds dy dt] x = world - origin。用來檢查 __setCamera
  // 要求的機位有沒有被 OrbitControls 的 min/maxDistance 或防穿模守衛夾走。
  const worldToSim = (world) => {
    const A = [
      [affine.ds[0], affine.dy[0], affine.dt[0]],
      [affine.ds[1], affine.dy[1], affine.dt[1]],
      [affine.ds[2], affine.dy[2], affine.dt[2]],
    ];
    const b = world.map((v, i) => v - affine.origin[i]);
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c += 1) {
      let piv = c;
      for (let r = c + 1; r < 3; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < 3; r += 1) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k < 4; k += 1) M[r][k] -= f * M[c][k];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  };

  const summary = [];
  for (const { tag, pose } of POSES) {
    await evaluate(`window.__setCamera(${JSON.stringify(pose[0])}, ${JSON.stringify(pose[1])})`);
    await sleep(SETTLE_MS);
    const camera = await evaluate("window.__cameraState()");
    // 機位被夾住 = 這張影格看到的不是我以為的東西(實測有一個機位被推進屋頂裡,
    // 畫面 90% 是白色屋頂,但真值仍宣稱 14 台車「在畫面內」)。標出來,別當成
    // 管線的失敗。
    const achievedSim = worldToSim(camera.position);
    const poseDeltaM = Math.hypot(achievedSim[0] - pose[0][0], achievedSim[1] - pose[0][1],
                                  achievedSim[2] - pose[0][2]);
    const poseClamped = poseDeltaM > 3.0;   // 3 m 以內只是輕推,畫面仍可用
    const payload = await evaluate(`(() => {
      const A = ${JSON.stringify(affine)};
      const toWorld = (s, y, t) => [0,1,2].map(i =>
        A.origin[i] + A.ds[i]*s + A.dy[i]*y + A.dt[i]*t);
      const px = (s, y, t) => {
        const ndc = window.__projectPoint(toWorld(s, y, t));
        return [ (ndc[0] + 1) * 0.5 * ${W}, (1 - ndc[1]) * 0.5 * ${H} ];
      };
      const grab = (pattern) => window.__paintedNodeBounds(pattern)
        .map(b => ({ name: b.name, pattern,
          sMin: b.sMin, sMax: b.sMax, tMin: b.tMin, tMax: b.tMax,
          corners: [[b.sMin,b.tMin],[b.sMax,b.tMin],[b.sMax,b.tMax],[b.sMin,b.tMax]]
            .map(([s,t]) => ({ s, t, px: px(s, 0, t) })) }));
      const stripes = grab('MainCrosswalk_Straight.*Stripe');
      const other = [].concat(
        grab('Crosswalk.*Stripe').filter(b => !/Straight/i.test(b.name)),
        grab('StopBar'),
      );
      const vehicles = window.__vehicleStates().map(v => ({
        id: v.id, type: v.type, s: v.s, t: v.lane_t, movement: v.movement,
        lanePosition: v.lanePosition ?? null, direction: v.direction ?? null,
        sideAccess: Boolean(v.sideAccess),
        groundPx: px(v.s, 0, v.lane_t) }));
      const peds = window.__pedestrianStates().map((p, i) => ({
        i, state: p.state, s: p.s, t: p.t, visible: p.visible,
        groundPx: px(p.s, 0, p.t) }));
      return { stripes, other, vehicles, pedestrians: peds };
    })()`);

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `shot_${tag}.png`), Buffer.from(shot.data, "base64"));
    writeFileSync(join(OUT_DIR, `truth_${tag}.json`), JSON.stringify({
      tag, width: W, height: H, camera, affine,
      requestedPoseSim: pose[0], achievedPoseSim: achievedSim,
      poseDeltaM, poseClamped, ...payload,
    }, null, 2));
    summary.push(`${tag}: stripes=${payload.stripes.length} other=${payload.other.length}`
      + ` vehicles=${payload.vehicles.length} pedestrians=${payload.pedestrians.length}`
      + (poseClamped ? `  !! 機位被夾住 ${poseDeltaM.toFixed(1)} m` : ""));
  }
  console.log(summary.join("\n"));
  console.log(`affine.ds=${JSON.stringify(affine.ds)} affine.dt=${JSON.stringify(affine.dt)}`);
  console.log(`OUT=${OUT_DIR}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");            // 只殺自己 spawn 的那個 pid
}
process.exit(exitCode);
