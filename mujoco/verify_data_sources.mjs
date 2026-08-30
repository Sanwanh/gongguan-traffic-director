// §24 真實資料層驗收(CDP headless)。
//   A 開機:合成是預設值,場景照常起來、資料層不干擾
//   B 四種來源都切得動:synthetic / replay / tdx / file,而且都不報錯
//   C replay 真的用真實資料驅動車流:換 frame → 車數跟著變(給實測數字)
//   D 過期標示:歷史資料一定標紅,絕不可讓人以為是即時的
//   E 退場:壞 URL / 壞 schema → 靜默退回合成,場景不空、不 fatal
//   F 紅線:[data-camera] 仍 6 顆、[data-command] 仍 4 顆、§19 仍 100 項、
//     window.__* 舊 hook 全在、零 console error
// 用法:node mujoco/verify_data_sources.mjs   (先確認 serve.py 起在 8124)
//
// 硬規則 9:結束時只殺自己 spawn 的那個 pid,絕不 pgrep 砍 Chrome。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_data_sources");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9391);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-data-sources";
const PAGE = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail ?? "")}`);
}

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
async function waitUntil(expression, { timeoutMs = 90000, intervalMs = 300 } = {}) {
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
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text ?? "unknown");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args
          .map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  });
}
async function realClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}
async function clickSelector(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!point) return false;
  await realClick(point.x, point.y);
  await sleep(260);
  return true;
}
async function setFileUrl(url) {
  // 先寫位址再切來源,免得白打一次舊位址。
  await evaluate(`(() => {
    const input = document.querySelector('#dataSourceUrl');
    input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  await evaluate("window.__setDataSource('file')");
  await sleep(600);
}

// 真正跑 data/ingest.py 重寫 feed —— 這一支讓 C 段是端到端而不是造假。
function runIngest(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [join(here, "..", "data", "ingest.py"), ...args], {
      cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("close", (code) => (
      code === 0 ? resolve(true) : reject(new Error(`ingest.py ${code}: ${err}`))
    ));
  });
}

async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, name), Buffer.from(s.data, "base64"));
  return name;
}

let exitCode = 0;
const report = {};
const shots = [];
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const base = send;
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? base(method, params)
      : base(method, params, sessionId)
  );
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE });

  // 硬規則 9:載入判準是 #modelStatus .status-dot 沒有 is-loading / is-error。
  const ready = await waitUntil(`(() => {
    const dot = document.querySelector('#modelStatus .status-dot');
    if (!dot) return false;
    return !dot.classList.contains('is-loading')
      && !dot.classList.contains('is-error');
  })()`);
  check("A1_page_loaded", Boolean(ready));
  // 上一輪測試可能在 localStorage 留下自訂 feed 位址,先清乾淨再重載,
  // 否則 file 來源的預設落點會被上一輪的 probe 覆蓋(重跑就不可重現)。
  await evaluate("localStorage.removeItem('gongguan.liveFeedUrl')");
  await send("Page.navigate", { url: PAGE });
  await waitUntil(`(() => {
    const dot = document.querySelector('#modelStatus .status-dot');
    return dot && !dot.classList.contains('is-loading')
      && !dot.classList.contains('is-error');
  })()`);
  await evaluate("window.__setPanelTab('sim')");
  await sleep(600);

  // ------------------------------------------------------------ A 預設狀態
  const boot = await evaluate("window.__dataSource()");
  report.boot = boot;
  check("A2_hook_exists", typeof boot === "object" && boot !== null);
  check("A3_default_is_synthetic",
    boot.sourceId === "synthetic" && boot.trafficMode === "normal", {
      sourceId: boot.sourceId, trafficMode: boot.trafficMode,
    });
  check("A4_synthetic_scene_not_empty", boot.actual.mainVehicles >= 10, boot.actual);
  check("A5_no_polling_when_synthetic", boot.poll.timerActive === false);
  const groupVisible = await evaluate(
    "getComputedStyle(document.querySelector('#dataSourceGroup')).display !== 'none'");
  check("A6_ui_block_present", groupVisible === true);
  shots.push(await shot("ds1_synthetic.png"));

  // ------------------------------------------------------------ B 四種來源
  const switched = {};
  for (const id of ["replay", "tdx", "file", "synthetic"]) {
    const ok = await clickSelector(`#dataSourceSegmented button[data-datasource="${id}"]`);
    await sleep(1400);
    const state = await evaluate("window.__dataSource()");
    switched[id] = {
      clicked: ok, sourceId: state.sourceId, degraded: state.degraded,
      badge: state.badge, trafficMode: state.trafficMode,
      mainVehicles: state.actual.mainVehicles,
      pedestrians: state.actual.pedestrians,
    };
    check(`B_${id}_switches_cleanly`,
      ok && state.sourceId === id && state.actual.mainVehicles >= 1,
      switched[id]);
  }
  report.switched = switched;

  // tdx 沒有金鑰時 ingest 會寫出 degraded 的檔;必須退回合成而不是空場景。
  check("B_tdx_degrades_to_synthetic",
    switched.tdx.degraded === true && switched.tdx.trafficMode !== "live",
    switched.tdx);
  // file 來源指到 data/live/custom.json(CV 管線範例),應該是可用的即時資料。
  check("B_file_feed_usable",
    switched.file.degraded === false && switched.file.trafficMode === "live",
    switched.file);

  // ------------------------------------- C replay 真的讓車流跟著資料變化
  // 真正的端到端:每一輪都用 ingest.py 重寫 data/live/replay.json,
  // viewer 靠自己的輪詢抓到新內容。沒有任何捷徑。
  await evaluate("window.__setDataSource('replay')");
  await sleep(1200);
  const frames = [];
  for (let frame = 0; frame < 3; frame += 1) {
    await runIngest(["--source", "replay", "--frame", String(frame),
      "--out", "data/live/replay.json"]);
    await evaluate("window.__pollDataSource()");
    await sleep(1200);
    const state = await evaluate("window.__dataSource()");
    frames.push({
      frame,
      detector: state.detector?.id ?? null,
      road: state.detector?.road ?? null,
      distanceM: state.detector?.distanceM ?? null,
      budget: [state.budget.mainVehicleMin, state.budget.mainVehicleMax],
      speedRangeMps: state.budget.speedRangeMps,
      mix: state.budget.mix,
      laneQuota: state.budget.laneQuota,
      measured: state.measurement
        ? { volumeVehPer5Min: state.measurement.volumeVehPer5Min,
            flowVph: state.measurement.flowVph,
            densityVehPerKm: state.measurement.densityVehPerKm,
            populationRaw: state.measurement.populationRaw }
        : null,
      actualMainVehicles: state.actual.mainVehicles,
      stale: state.stale,
      badge: state.badge,
      trafficMode: state.trafficMode,
    });
    frames[frame].laneSpread = state.actual.laneSpread;
    frames[frame].typeSpread = state.actual.typeSpread;
    frames[frame].pedestrians = state.actual.pedestrians;
    frames[frame].sideVehicles = state.actual.sideVehicles;
    shots.push(await shot(`ds2_replay_frame${frame}.png`));
  }
  report.replayFrames = frames;
  const counts = frames.map((f) => f.actualMainVehicles);
  const detectors = frames.map((f) => f.detector);
  check("C1_each_frame_is_a_real_detector",
    detectors.every(Boolean) && new Set(detectors).size === 3, detectors);
  check("C2_all_frames_drive_live_mode",
    frames.every((f) => f.trafficMode === "live"),
    frames.map((f) => f.trafficMode));
  check("C3_vehicle_count_tracks_the_data",
    new Set(counts).size >= 3
    && Math.max(...counts) >= Math.max(1, Math.min(...counts)) * 2,
    { counts, ratio: (Math.max(...counts)
      / Math.max(1, Math.min(...counts))).toFixed(2) });
  check("C4_counts_match_the_published_budget",
    frames.every((f) => f.actualMainVehicles >= f.budget[0]
      && f.actualMainVehicles <= f.budget[1]),
    frames.map((f) => ({ got: f.actualMainVehicles, budget: f.budget })));
  check("C5_speed_range_comes_from_the_data",
    frames.every((f) => Array.isArray(f.speedRangeMps)
      && f.speedRangeMps[0] > 0 && f.speedRangeMps[1] >= f.speedRangeMps[0])
      && new Set(frames.map((f) => JSON.stringify(f.speedRangeMps))).size === 3,
    frames.map((f) => f.speedRangeMps));
  check("C6_lane_quota_differs_per_detector",
    new Set(frames.map((f) => JSON.stringify(f.laneQuota))).size === 3,
    frames.map((f) => f.laneQuota?.["1"]));
  check("C7_mix_comes_from_the_data",
    new Set(frames.map((f) => JSON.stringify(f.mix))).size === 3,
    frames.map((f) => f.mix));
  // 映射公式在瀏覽器裡重算一次,必須和 ingest.py 算出來的 populationRaw 一致。
  const formulaCheck = await evaluate(`(() => {
    const s = window.__dataSource();
    const m = s.measurement;
    if (!m) return null;
    const r = window.__vdVolumeToPopulation({
      volumeVehPer5Min: m.volumeVehPer5Min,
      avgSpeedKph: m.flowVph / m.densityVehPerKm,
      laneCount: s.detector.laneCount,
      targetLanes: 6,
    });
    return { js: Number(r.raw.toFixed(3)), py: m.populationRaw };
  })()`);
  report.formulaCheck = formulaCheck;
  check("C8_js_and_python_agree_on_the_formula",
    formulaCheck && Math.abs(formulaCheck.js - formulaCheck.py) < 0.02,
    formulaCheck);

  // schema 用 null 表示「這個來源量不到」。VD 不量行人、也不看巷90,
  // 所以這兩項必須維持模式預設值(行人 10–16、巷90 每列 3 輛 x 2 列 = 6),
  // 而不是被讀成「量到 0」。
  check("C9_null_fields_keep_simulation_defaults",
    frames.every((f) => f.pedestrians >= 10 && f.pedestrians <= 16
      && f.sideVehicles === 6),
    frames.map((f) => ({ pedestrians: f.pedestrians, side: f.sideVehicles })));
  // 逐車道權重真的落到場景上:VCCKW00 推定內側權重為 0,場景就不該有內側車。
  check("C10_lane_quota_reaches_the_scene",
    frames.every((f) => Object.entries(f.laneQuota?.["1"] ?? {})
      .every(([position, weight]) => weight > 0
        || (f.laneSpread?.[position] ?? 0) === 0)),
    frames.map((f) => ({ quota: f.laneQuota?.["1"], spread: f.laneSpread })));

  // ----------------------------------------------- D 過期資料一定標示清楚
  check("D1_historic_data_marked_stale",
    frames.every((f) => f.stale === true), frames.map((f) => f.stale));
  check("D2_badge_says_not_realtime",
    frames.every((f) => typeof f.badge === "string" && f.badge.includes("非即時")),
    frames.map((f) => f.badge));
  const staleUi = await evaluate(`(() => {
    const badge = document.querySelector('#dataSourceBadge');
    const note = document.querySelector('#dataSourceNote');
    return {
      badgeText: badge.textContent.trim(),
      badgeStale: badge.classList.contains('is-stale'),
      noteVisible: !note.hidden,
      noteText: note.textContent.trim().slice(0, 260),
      age: document.querySelector('#dataAgeValue').textContent.trim(),
      detector: document.querySelector('#dataDetectorValue').textContent.trim(),
      vehicles: document.querySelector('#dataVehicleValue').textContent.trim(),
      headline: document.querySelector('#dataSourceHeadline').textContent.trim(),
    };
  })()`);
  report.staleUi = staleUi;
  check("D3_badge_is_red_and_note_shown",
    staleUi.badgeStale && staleUi.noteVisible
    && staleUi.noteText.includes("2024"), staleUi);
  check("D4_ui_shows_detector_and_count",
    staleUi.detector.length > 2 && staleUi.vehicles !== "\u2014", staleUi);
  check("D5_age_is_shown_in_human_units", /前$/.test(staleUi.age), staleUi.age);
  shots.push(await shot("ds3_stale_marked.png"));

  // 對照組:剛量到的 feed 不可以被標成過期(否則標示就沒有資訊量)。
  // §26:examples/fresh_probe.json 的 observedAt 是寫檔當下寫死的,超過
  // staleAfterS(3600 s)之後再跑這支腳本就會假性失敗。這裡在跑之前把
  // 時戳改成「現在」另存到 data/live/(gitignore 不管、也不動範例檔),
  // 檢查的語意「剛量到的 feed 不可被標成過期」完全不變。
  {
    const src = JSON.parse(readFileSync(join(here, "../data/examples/fresh_probe.json"), "utf8"));
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}+08:00`;
    src.generatedAt = stamp;
    src.observedAt = stamp;
    writeFileSync(join(here, "../data/live/fresh_probe_now.json"),
      `${JSON.stringify(src, null, 2)}\n`);
  }
  await setFileUrl("../data/live/fresh_probe_now.json");
  await sleep(2500);
  const fresh = await evaluate("window.__dataSource()");
  report.fresh = {
    stale: fresh.stale, badge: fresh.badge, ageS: fresh.ageS,
    confidence: fresh.confidence, degraded: fresh.degraded,
    trafficMode: fresh.trafficMode,
  };
  check("D6_fresh_feed_not_marked_stale",
    fresh.degraded === false && fresh.stale === false
    && !String(fresh.badge).includes("非即時"), report.fresh);
  check("D7_fresh_feed_drives_the_scene",
    fresh.trafficMode === "live", report.fresh);

  // ---------------------------------------------------------- E 退場行為
  await setFileUrl("../data/live/does_not_exist_404.json");
  // 失敗 1–2 次沿用上一份;第 3 次才退場。輪詢 15 秒一次,所以要等 ~35 秒。
  const fellBack = await waitUntil(
    "window.__dataSource().trafficMode !== 'live'", { timeoutMs: 90000 });
  const broken = await evaluate("window.__dataSource()");
  report.broken = {
    trafficMode: broken.trafficMode, sourceId: broken.sourceId,
    failures: broken.poll.failures, lastError: broken.poll.lastError,
    mainVehicles: broken.actual.mainVehicles, badge: broken.badge,
    backoffMs: broken.poll.intervalMs, timerActive: broken.poll.timerActive,
  };
  check("E1_missing_file_falls_back",
    Boolean(fellBack) && broken.trafficMode !== "live", report.broken);
  check("E2_scene_still_populated",
    broken.actual.mainVehicles >= 10, report.broken);
  check("E3_backoff_engaged_and_still_retrying",
    broken.poll.intervalMs > 15000 && broken.poll.timerActive === true
    && broken.sourceId === "file", report.broken);
  const fatal = await evaluate(
    "document.querySelector('#fatalError').hidden === false");
  check("E4_no_fatal_error", fatal === false);

  // 資料回來要自己復原:間隔收回 15 秒,而且不必使用者按任何東西。
  await setFileUrl("../data/examples/fresh_probe.json");
  const recovered = await waitUntil(
    "window.__dataSource().trafficMode === 'live'", { timeoutMs: 40000 });
  const recovery = await evaluate("window.__dataSource()");
  report.recovery = {
    trafficMode: recovery.trafficMode, failures: recovery.poll.failures,
    intervalMs: recovery.poll.intervalMs, badge: recovery.badge,
    observedAt: recovery.observedAt,
  };
  check("E4b_recovers_without_user_action",
    Boolean(recovered) && recovery.poll.failures === 0
    && recovery.poll.intervalMs === 15000, report.recovery);

  // 壞 schema:合法 JSON 但 schema 欄位不對,必須整份拒收 —— 而且第一次
  // 失敗時要沿用上一份好的 feed(場景完全不動),不是立刻空掉。
  await setFileUrl("../data/examples/bad_schema_probe.json");
  await sleep(3000);
  const badSchema = await evaluate("window.__dataSource()");
  report.badSchema = {
    trafficMode: badSchema.trafficMode, observedAt: badSchema.observedAt,
    lastError: badSchema.poll.lastError, failures: badSchema.poll.failures,
    mainVehicles: badSchema.actual.mainVehicles,
  };
  check("E5a_bad_schema_never_applied",
    String(badSchema.poll.lastError).includes("schema")
    && badSchema.poll.failures >= 1
    && badSchema.observedAt === report.recovery.observedAt,
    report.badSchema);
  check("E5b_scene_holds_the_last_good_feed",
    badSchema.trafficMode === "live" && badSchema.actual.mainVehicles >= 1,
    report.badSchema);
  // 連續失敗滿 3 次才退場。
  const schemaFellBack = await waitUntil(
    "window.__dataSource().trafficMode !== 'live'", { timeoutMs: 90000 });
  const afterSchema = await evaluate("window.__dataSource()");
  report.afterSchema = {
    trafficMode: afterSchema.trafficMode, failures: afterSchema.poll.failures,
    mainVehicles: afterSchema.actual.mainVehicles, badge: afterSchema.badge,
  };
  check("E5c_falls_back_after_three_schema_failures",
    Boolean(schemaFellBack) && afterSchema.trafficMode !== "live"
    && afterSchema.actual.mainVehicles >= 10, report.afterSchema);
  shots.push(await shot("ds4_degraded.png"));

  // 回到合成,確認車速參數與車流檔位都乾淨還原。
  await evaluate("window.__setDataSource('synthetic')");
  await sleep(1200);
  const restored = await evaluate(`(() => {
    const s = window.__dataSource();
    const p = window.__params();
    return { sourceId: s.sourceId, trafficMode: s.trafficMode,
      speedParams: [p['speed.mainMin'], p['speed.mainMax']],
      mainVehicles: s.actual.mainVehicles,
      timerActive: s.poll.timerActive };
  })()`);
  report.restored = restored;
  check("E6_clean_restore",
    restored.sourceId === "synthetic" && restored.trafficMode === "normal"
    && Math.abs(restored.speedParams[0] - 5.5) < 1e-6
    && Math.abs(restored.speedParams[1] - 7.9) < 1e-6
    && restored.mainVehicles >= 10
    && restored.timerActive === false, restored);

  await evaluate("localStorage.removeItem('gongguan.liveFeedUrl')");

  // ---------------------------------------------------------- F 既有紅線
  const redLines = await evaluate(`(() => {
    const hooks = ['__trafficDirectorDebug','__vehicleStates','__pedestrianStates',
      '__busStates','__lane90States','__params','__paramMeta','__setParam',
      '__cameraState','__setCamera','__setCameraMode','__setCameraPreset',
      '__layerState','__setLayer','__panelState','__setPanelTab','__signalStates',
      '__kbotPosts','__setKbotPost','__renderStats','__dataSource'];
    return {
      dataCamera: document.querySelectorAll('[data-camera]').length,
      dataCommand: document.querySelectorAll('[data-command]').length,
      paramRows: document.querySelectorAll('#paramGroups .param-row').length,
      paramCount: Object.keys(window.__params()).length,
      missingHooks: hooks.filter((h) => typeof window[h] !== 'function'
        && typeof window[h] !== 'object'),
      densityButtons: [...document.querySelectorAll('#densitySegmented button')]
        .map((b) => b.dataset.density),
      dataSourceButtons: [...document.querySelectorAll('#dataSourceSegmented button')]
        .map((b) => b.dataset.datasource),
    };
  })()`);
  report.redLines = redLines;
  check("F1_data_camera_still_6", redLines.dataCamera === 6, redLines.dataCamera);
  check("F2_data_command_still_4", redLines.dataCommand === 4, redLines.dataCommand);
  check("F3_params_still_100",
    redLines.paramCount === 100 && redLines.paramRows === 100, redLines);
  check("F4_all_hooks_present", redLines.missingHooks.length === 0,
    redLines.missingHooks);
  check("F5_four_data_sources",
    redLines.dataSourceButtons.join(",") === "synthetic,replay,tdx,file",
    redLines.dataSourceButtons);
  check("F6_no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));

  report.results = results;
  report.consoleErrors = consoleErrors;
  report.shots = shots;
  writeFileSync(join(OUT_DIR, "verify_data_sources_report.json"),
    JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  // 只殺自己 spawn 的那個 pid(硬規則 9)。
  chrome.kill("SIGTERM");
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
console.log(`report: ${join(OUT_DIR, "verify_data_sources_report.json")}`);
process.exit(failures > 0 ? 1 : exitCode);
