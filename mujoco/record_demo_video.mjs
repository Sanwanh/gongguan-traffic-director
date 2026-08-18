// 用 headless Chrome 的 CDP screencast 錄一段「KBot 指揮交通」的成片素材,
// 再用 ffmpeg 壓成 1920x1080 / 30fps 的 H.264 mp4(給 Remotion 當底片)。
//
// 分鏡(事件驅動,不是死時間;實際秒數會寫進 <out>.beats.json):
//   A 鳥瞰      羅斯福路綠燈、車流通過
//   B 行穿線    行人相位:KBot 從人行道走到行穿線中央站定指揮
//   C 行穿線    相位要換了,KBot 沿畫線退回人行道崗位,車流才放行
//
// 先決條件:serve.py 已在 8124 起來、ffmpeg 在 PATH。
// 執行:node mujoco/record_demo_video.mjs [--seconds 30] [--out <mp4>]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const SECONDS = Number(argValue("--seconds", "30"));
// 成片目標長度。錄影是事件驅動的,長度取決於機器人真的走多久;A 段(等
// 主幹道綠燈結束＋路口清空)常常拖到十幾秒。多錄一點再**從頭裁掉**多餘
// 的部分,比縮短動作誠實,也不會把結尾切掉。beats 會一起換算。
const TARGET = Number(argValue("--target", "0"));
const FPS = Number(argValue("--fps", "30"));
const PORT = Number(argValue("--port", "8124"));
const DEBUG_PORT = Number(argValue("--cdp-port", "9339"));
const OUT = argValue("--out", join(packageRoot, "video", "kbot_traffic_30s.mp4"));
const FRAME_DIR = argValue(
  "--frames",
  "/private/tmp/claude-501/-Users-san/kbot-video-frames",
);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-video-record";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(dirname(OUT), { recursive: true });
rmSync(FRAME_DIR, { recursive: true, force: true });
mkdirSync(FRAME_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;
const pending = new Map();
let socket = null;
let sessionId = null;
const frames = [];
const frameWrites = [];
let recording = false;

function send(method, params = {}) {
  const id = (nextId += 1);
  const payload = { id, method, params };
  if (sessionId && !method.startsWith("Target.")) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 120000);
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "eval error");
  }
  return result.result?.value;
}
async function waitUntil(expression, { timeoutMs = 90000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}
const clickCamera = (id) => evaluate(
  `document.querySelector('[data-camera="${id}"]').click()`,
);
const clickCommand = (phase) => evaluate(
  `document.querySelector('[data-command][data-phase="${phase}"]').click()`,
);
async function setSwitch(id, want) {
  return evaluate(`(() => { const el = document.querySelector('#${id}');
    if (el.checked !== ${want}) el.click(); return el.checked; })()`);
}
async function setNumber(id, value) {
  return evaluate(`(() => { const el = document.querySelector('#${id}');
    el.value = '${value}'; el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value; })()`);
}
async function setSelect(id, value) {
  return evaluate(`(() => { const el = document.querySelector('#${id}');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
}

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--window-size=1920,1080",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });

const beats = [];
let recordStartMs = 0;
const mark = (id, label) => {
  beats.push({
    id,
    label,
    atSeconds: Number(((Date.now() - recordStartMs) / 1000).toFixed(3)),
  });
};

let exitCode = 0;
try {
  let wsUrl = null;
  for (let attempt = 0; attempt < 60 && !wsUrl; attempt += 1) {
    try {
      const info = await (await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/version`,
      )).json();
      wsUrl = info.webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  if (!wsUrl) throw new Error(`Chrome 沒起來:\n${chromeStderr}`);

  socket = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (event) => reject(new Error(String(event.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
        return;
      }
      if (message.method === "Page.screencastFrame") {
        const { data, metadata, sessionId: frameSession } = message.params;
        send("Page.screencastFrameAck", { sessionId: frameSession }).catch(() => {});
        if (!recording) return;
        const index = frames.length;
        const file = join(FRAME_DIR, `f${String(index).padStart(6, "0")}.jpg`);
        // 一定要非同步寫。用 writeFileSync 會把事件迴圈卡住(1400 張 × 幾 ms
        // ≈ 好幾秒),所有 sleep/輪詢都會晚到,錄出來的長度與分鏡時間全歪。
        frameWrites.push(writeFileAsync(file, Buffer.from(data, "base64")));
        frames.push({ file, timestamp: metadata.timestamp });
      }
    });
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });
  console.log("[record] 載入 viewer…");
  if (!await waitUntil(
    "Boolean(window.__trafficDirectorDebug) && "
    + "document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false",
    { timeoutMs: 150000 },
  )) throw new Error("viewer 沒有載入完成");

  // 錄影用設定:滿版無面板、動作全開、60FPS 渲染。
  await setSwitch("recordingMode", true);

  /*
   * viewer 內建的 is-recording 只藏 .control-panel 與 .metrics-panel,
   * 上方標題列(.topbar)、下方相機列(.camera-toolbar)、右下角圖例(.scene-legend)
   * 都還留在畫面上 —— 而圖例上直接寫著機型代號,那是企劃書明文不能出現在
   * 成品畫面裡的東西。錄出來的素材要是乾淨的 3D 場景,不是工具截圖,
   * 所以這裡自己補一層 CSS 把所有疊層關掉。
   */
  await evaluate(`(() => {
    const id = 'record-clean-hud';
    document.getElementById(id)?.remove();
    const st = document.createElement('style');
    st.id = id;
    st.textContent = \`
      .topbar, .camera-toolbar, .scene-legend, .control-panel,
      .metrics-panel, .legal-boundary, .model-status, .fatal-error {
        display: none !important;
      }
      .app-shell, .viewport { inset: 0 !important; width: 100vw !important; }
      canvas { width: 100vw !important; height: 100vh !important; }
    \`;
    document.head.appendChild(st);
    window.dispatchEvent(new Event('resize'));
    return true;
  })()`);

  /*
   * 場景裡的真實店招:字樣是幾何(不是貼圖),所以可以只藏「字」與商標,
   * 招牌板、建物、遮陽棚全部留著,天際線不會開洞。藏的是商業品牌識別;
   * 道路名稱牌、捷運出口牌、水源市場(公共設施/地標)一律保留——那些是
   * 這個路口的身分,不是廣告。
   */
  const BRAND_SIGNAGE = [
    "CosmedText",
    "TimberlandSnapshot_VerticalText",
    "TimberlandSnapshot_TreeEmblem",
    "OrangeBillboard_\\d+_Text",
    "AluanSignText",
  ].join("|");
  const hiddenSignage = await evaluate(
    `window.__setNodeVisibility(${JSON.stringify(BRAND_SIGNAGE)}, false)`,
  );
  console.log(`[record] 藏掉 ${hiddenSignage.length} 個店招節點:`
    + `${hiddenSignage.join(", ")}`);
  if (hiddenSignage.length === 0) {
    throw new Error("店招節點一個都沒命中,場景可能換版了——先確認再錄");
  }

  await setSwitch("motionEffects", true);
  await setSwitch("highPerformance", true);
  // 待轉區的白框與「機車待轉」字樣是模擬加畫的,不在實景量測的場景 GLB
  // 裡;成品畫面只放量得到的東西,所以錄影時關掉。
  await setSwitch("hookTurn", false);
  await setSwitch("autoMode", true);
  await setSelect("trafficDensity", "normal");
  // 相位秒數依分鏡調:主幹道夠長讓車流跑起來,行人相位夠長讓機器人走過去。
  await setNumber("durationRoosevelt", 30);
  // 行人相位 30 秒:走到崗位要 14.4s,退場在「剩 9.5 秒」時啟動,
  // 30 秒才留得下約 6 秒站定指揮的畫面(24 秒的話只有 2 秒,像走過場)。
  await setNumber("durationPedestrian", 30);
  await setNumber("durationLane90", 20);

  console.log("[record] 等 KBot 走完進場動線…");
  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true",
    { timeoutMs: 120000 },
  );
  // 暖機:讓車隊排好、公車跑到定位。
  await clickCommand("roosevelt_flow");
  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().phase === 'roosevelt_flow'",
    { timeoutMs: 60000 },
  );
  await sleep(6000);
  await clickCamera("overview");
  await sleep(1200);

  // 分鏡是事件驅動的:實測(§16 重測)行人相位啟動後,走到行穿線中央
  // 約 6.6s、站定約 7.9s、沿畫線退回人行道崗位約 6.6s。要讓這三個動作全部
  // 進畫面又只有 30 秒,A 段就必須壓在 5–8 秒:所以先等主幹道綠燈只剩
  // 約 5 秒才送出 WALK 請求並開錄——A 段拍到的正好是綠燈尾段轉黃、
  // 車輛停在停止線,接著清空、行人相位接上。
  console.log("[record] 等主幹道綠燈尾段…");
  await waitUntil(`(() => {
    const snap = window.__trafficDirectorDebug.snapshot();
    if (snap.phase !== 'roosevelt_flow' || snap.decisionState !== 'active') return null;
    const left = Number(document.querySelector('#phaseCountdown').textContent);
    return (Number.isFinite(left) && left <= 5.2) ? left : null;
  })()`, { timeoutMs: 90000, intervalMs: 120 });

  console.log("[record] 開始錄…");
  await send("Page.startScreencast", {
    format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
  });
  recordStartMs = Date.now();
  recording = true;
  mark("a_overview", "鳥瞰:羅斯福路綠燈尾段,車輛停在實畫停止線");
  await clickCommand("pedestrian_crossing");

  const elapsed = () => (Date.now() - recordStartMs) / 1000;
  const waitClock = async (seconds) => { while (elapsed() < seconds) await sleep(60); };

  // B 段:行人相位一 active 就切到行穿線機位,拍他走進路口。
  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().phase === 'pedestrian_crossing' || null",
    { timeoutMs: 45000, intervalMs: 120 },
  );
  // 走路這 14 秒要用 KBot 跟拍機位:行穿線廣角框的是路口中央,他從人行道
  // 出發的那一段根本不在畫面裡(第一版錄出來就是這樣)。
  await clickCamera("robot");
  mark("b_walk", "跟拍:KBot 從人行道走進路口");

  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.station === '行穿線中央'"
    + " || null",
    { timeoutMs: 40000, intervalMs: 120 },
  );
  await clickCamera("crosswalk");
  mark("b_post", "行穿線:KBot 站上行穿線中央、舉手全停,行人穿越");

  // C 段:他一開始移動就是要退場了。§16 起退場終點是行穿線北端的人行道
  // 崗位(不再是公車站月台),行穿線機位本身就拍得到整段退場,不用換機位。
  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.station !== '行穿線中央'"
    + " || null",
    { timeoutMs: 40000, intervalMs: 120 },
  );
  mark("c_retreat", "行穿線:相位要換了,KBot 沿畫線主動退離車道");

  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.safeZone"
    + " && !window.__trafficDirectorDebug.snapshot().kbotMotion.robotOnRoadway || null",
    { timeoutMs: 40000, intervalMs: 120 },
  );
  mark("c_safe", "退回行穿線旁人行道崗位,安全閘門解除、車流才放行");

  // 收尾:讓他在人行道崗位上站滿 3 秒,總長不超過 --seconds 上限。
  await waitClock(Math.min(SECONDS, elapsed() + 3));
  recording = false;
  await send("Page.stopScreencast");
  await Promise.all(frameWrites);
  console.log(`[record] 收到 ${frames.length} 張畫格`);
  if (frames.length < FPS * 5) throw new Error("畫格太少,錄影失敗");
} catch (error) {
  console.error(`ERROR ${error.message}`);
  if (chromeStderr) console.error(chromeStderr.split("\n").slice(-6).join("\n"));
  exitCode = 2;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}

if (exitCode === 0) {
  // 畫格是依實際重繪時間到的,間隔不等;用 concat demuxer 帶上每格真實
  // 長度,再讓 ffmpeg 重取樣成固定 30fps,播放速度才等於真實時間。
  const rawBase = frames[0].timestamp;
  const rawSpan = frames[frames.length - 1].timestamp - rawBase;
  console.log(`[record] 實際時長 ${rawSpan.toFixed(2)}s、`
    + `平均 ${(frames.length / rawSpan).toFixed(1)} fps`);

  // 從頭裁到目標長度(結尾一定保留:機器人退回崗位站定才是句點)。
  const trimSeconds = TARGET > 0 && rawSpan > TARGET ? rawSpan - TARGET : 0;
  if (trimSeconds > 0) {
    console.log(`[record] 從片頭裁掉 ${trimSeconds.toFixed(2)}s 以符合 ${TARGET}s`);
  }
  const kept = frames.filter(
    (frame) => frame.timestamp - rawBase >= trimSeconds - 1e-6,
  );
  const base = kept[0].timestamp;
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < kept.length; index += 1) {
    const next = kept[index + 1];
    const duration = next
      ? Math.max(0.001, next.timestamp - kept[index].timestamp)
      : 1 / FPS;
    lines.push(`file '${kept[index].file}'`);
    lines.push(`duration ${duration.toFixed(6)}`);
  }
  lines.push(`file '${kept[kept.length - 1].file}'`);
  const listFile = join(FRAME_DIR, "frames.ffconcat");
  writeFileSync(listFile, `${lines.join("\n")}\n`);
  const span = kept[kept.length - 1].timestamp - base;

  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${command} 失敗 (${result.status})`);
  };
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18",
    "-movflags", "+faststart",
    OUT,
  ]);
  const poster = OUT.replace(/\.mp4$/, "_poster.jpg");
  run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", OUT, "-ss", "00:00:12", "-frames:v", "1", "-q:v", "2", poster,
  ]);

  const probe = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration",
    "-of", "json", OUT,
  ], { encoding: "utf8" });
  const info = probe.status === 0 ? JSON.parse(probe.stdout) : null;
  const durationS = info ? Number(info.format.duration) : span;

  const meta = {
    video: OUT,
    poster,
    fps: FPS,
    width: 1920,
    height: 1080,
    durationSeconds: Number(durationS.toFixed(3)),
    durationFrames: Math.round(durationS * FPS),
    capturedFrames: kept.length,
    trimmedFromHeadSeconds: Number(trimSeconds.toFixed(3)),
    source: PAGE_URL,
    viewer: "V54 traffic_director V4 (SPEC_VIEWER_V2 §13/§14)",
    beats: beats
      .map((beat) => {
        const atSeconds = Number((beat.atSeconds - trimSeconds).toFixed(3));
        return { ...beat, atSeconds, atFrame: Math.round(atSeconds * FPS) };
      })
      // 被裁掉的 beat 一律夾到 0(A 段的開場字卡還是要從第 0 格出現)。
      .map((beat) => (beat.atSeconds < 0
        ? { ...beat, atSeconds: 0, atFrame: 0 }
        : beat)),
  };
  const metaFile = OUT.replace(/\.mp4$/, ".beats.json");
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`\nPASS 影片輸出:${OUT}`);
  console.log(`     海報圖:${poster}`);
  console.log(`     分鏡時間軸:${metaFile}`);
  console.log(`     ${meta.durationSeconds}s / ${FPS}fps / ${meta.durationFrames} 格`);
  for (const beat of meta.beats) {
    console.log(`     ${String(beat.atSeconds).padStart(6)}s  #${beat.atFrame}  ${beat.label}`);
  }
  void basename;
}
process.exit(exitCode);
