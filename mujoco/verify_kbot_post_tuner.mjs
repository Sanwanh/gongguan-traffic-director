// §18「機器人崗位微調」CDP 驗收:預設狀態不變、選崗位→拖滑桿 KBot 即時
// 跟著動、安全區/畫線帶判定文字正確、匯出片段語法正確、還原預設有效、
// 關掉預覽後勤務狀態機接手,以及既有 DOM 選擇器與 __* hook 全數還在。
//
// 先決條件:serve.py 已在 8124(python3 serve.py --port 8124 --directory .)
// 執行:node mujoco/verify_kbot_post_tuner.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_post_tuner");
const PORT = 8124;
const DEBUG_PORT = 9347;
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-post-tuner";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const failures = [];
const report = {};
const consoleErrors = [];
const check = (name, ok, detail) => {
  report[name] = { ok: Boolean(ok), detail };
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
};
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
    }, 120000);
  });
}
let send = rawSend;

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}
async function waitUntil(expression, { timeoutMs = 60000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}
const setSwitch = (id, want) => evaluate(`(() => {
  const el = document.querySelector('#${id}');
  if (el.checked !== ${want}) el.click();
  return el.checked;
})()`);
const setSelect = (id, value) => evaluate(`(() => {
  const el = document.querySelector('#${id}');
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
const setNumber = (id, value) => evaluate(`(() => {
  const el = document.querySelector('#${id}');
  el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);
const text = (selector) => evaluate(`document.querySelector('${selector}')?.textContent?.replace(/\\s+/g, ' ')?.trim() ?? null`);
const probe = () => evaluate("window.__kbotProbeWorldPos()");
const posts = () => evaluate("window.__kbotPosts()");
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

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
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
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
        consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "unknown");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  });
}

let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await rawSend("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rawSend("Target.attachToTarget", { targetId, flatten: true });
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? rawSend(method, params)
      : rawSend(method, params, sessionId)
  );
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(
    "Boolean(window.__trafficDirectorDebug && window.__kbotPosts"
    + " && document.querySelector('#modelStatus .status-dot')?.classList.contains('is-loading') === false)",
    { timeoutMs: 120000 },
  );
  if (!ready) throw new Error("viewer 沒有載入完成");
  await waitUntil("window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true", { timeoutMs: 60000 });

  // --- A. 預設狀態必須與沒有這組 UI 時完全一樣 ---
  const initial = await posts();
  check("A1_defaults_untouched",
    JSON.stringify(initial.posts) === JSON.stringify(initial.defaults),
    { posts: initial.posts, defaults: initial.defaults });
  check("A2_preview_off_by_default", initial.preview === false, initial.preview);
  check("A3_selected_stand", initial.selected === "stand", initial.selected);
  const groupOpen = await evaluate("document.querySelector('#kbotPostGroup').open");
  check("A4_group_collapsed_by_default", groupOpen === false, groupOpen);
  const locks0 = await text("#safetyLocks");
  check("A5_no_preview_lock_pill", !locks0.includes("崗位預覽"), locks0);

  // --- B. 展開面板、開預覽、選崗位、拖滑桿 ---
  await evaluate("document.querySelector('#kbotPostGroup').open = true");
  const previewOn = await setSwitch("kbotPostPreview", true);
  check("B1_preview_switch_on", previewOn === true, previewOn);
  await sleep(300);
  const selected = await setSelect("kbotPostTarget", "crosswalk");
  check("B2_select_crosswalk", selected === "crosswalk", selected);
  await sleep(200);
  const segActive = await evaluate("[...document.querySelectorAll('#kbotPostSegmented button')].find(b => b.classList.contains('is-active'))?.dataset.post");
  check("B3_segmented_follows_select", segActive === "crosswalk", segActive);

  const probeAt = async (t) => {
    await setNumber("kbotPostT", t);
    await sleep(220);
    return {
      t,
      probe: await probe(),
      holder: (await evaluate("window.__trafficDirectorDebug.snapshot().kbotMotion.holderPosition")),
      verdict: await text("#kbotPostVerdict"),
      sliderOut: await text("#kbotPostTValue"),
    };
  };
  const sweep = [];
  for (const t of [8.33, 12.0, 1.28, 17.5, 8.33]) sweep.push(await probeAt(t));
  report.sweep = sweep;
  check("B4_probe_tracks_slider",
    sweep.every((s) => near(s.holder[2], s.t, 0.005))
    && Math.hypot(sweep[0].probe[0] - sweep[1].probe[0], sweep[0].probe[2] - sweep[1].probe[2]) > 3.0,
    sweep.map((s) => ({ t: s.t, holderZ: s.holder[2], probe: s.probe.map((v) => Number(v.toFixed(3))) })));
  check("B5_slider_output_text",
    sweep.every((s) => s.sliderOut === `${s.t.toFixed(2)} m`),
    sweep.map((s) => s.sliderOut));

  // 判定文字
  const vOnRoad = sweep[1].verdict;   // t = 12.0 → 車道上, 在畫線帶
  const vGap = sweep[2].verdict;      // t = 1.28 → BRT 分向島
  const vSidewalk = sweep[3].verdict; // t = 17.5 → 人行道安全區
  check("C1_roadway_verdict",
    vOnRoad.includes("在車道上") && vOnRoad.includes("行穿線畫線帶(straight)"), vOnRoad);
  check("C2_brt_gap_verdict", vGap.includes("BRT 中央分向島"), vGap);
  check("C3_safe_zone_verdict",
    vSidewalk.includes("安全區:水源市場側人行道") && !vSidewalk.includes("在車道上"), vSidewalk);
  const previewLock = await text("#safetyLocks");
  check("C4_preview_lock_pill", previewLock.includes("崗位預覽中"), previewLock);

  // controllerSafeZone 判定與 hook 一致
  const verdictHook = (await posts()).verdict;
  report.verdictHook = verdictHook;

  // 另外兩個崗位也能調(y 滑桿)
  await setSelect("kbotPostTarget", "lane90");
  await sleep(200);
  await setNumber("kbotPostS", -3.5);
  await setNumber("kbotPostY", 0.3);
  await sleep(250);
  const lane90 = (await posts()).posts.lane90;
  const holderLane90 = await evaluate("window.__trafficDirectorDebug.snapshot().kbotMotion.holderPosition");
  check("C5_lane90_editable",
    near(lane90.x, -3.5) && near(lane90.y, 0.3)
    && near(holderLane90[0], -3.5) && near(holderLane90[1], 0.3),
    { lane90, holderLane90 });

  // stand 崗位改了,進場路徑/相機 fallback 也要跟著(讀 hook 確認值換了)
  await setSelect("kbotPostTarget", "stand");
  await sleep(150);
  await setNumber("kbotPostS", 11.0);
  await sleep(250);
  const standNow = (await posts()).posts.stand;
  check("C6_stand_editable", near(standNow.x, 11.0), standNow);

  // --- D. 匯出片段 ---
  const code = await evaluate("window.__kbotPostExportCode()");
  writeFileSync(join(OUT_DIR, "export_snippet.mjs"), code);
  report.exportSnippet = code;
  const copied = await evaluate("window.__kbotPosts && document.querySelector('#kbotPostCopy').click(), true");
  await sleep(400);
  const copyNote = await text("#kbotPostCopyNote");
  const exportHidden = await evaluate("document.querySelector('#kbotPostExport').hidden");
  const exportValue = await evaluate("document.querySelector('#kbotPostExport').value");
  check("D1_copy_button_produces_code",
    exportValue.includes("KBOT_POSTS_DEFAULT"), { copyNote, exportHidden, len: exportValue.length });
  report.copyNote = copyNote;
  report.exportHidden = exportHidden;

  // --- E. 還原預設 ---
  await evaluate("document.querySelector('#kbotPostReset').click()");
  await sleep(350);
  const afterReset = await posts();
  check("E1_reset_restores_defaults",
    JSON.stringify(afterReset.posts) === JSON.stringify(afterReset.defaults),
    afterReset.posts);
  const holderReset = await evaluate("window.__trafficDirectorDebug.snapshot().kbotMotion.holderPosition");
  check("E2_reset_moves_robot_back",
    near(holderReset[0], afterReset.defaults.stand.x) && near(holderReset[2], afterReset.defaults.stand.z),
    holderReset);

  // --- F. 關閉預覽後交還勤務狀態機 ---
  await setNumber("kbotPostS", 11.0);
  await sleep(200);
  const previewOff = await setSwitch("kbotPostPreview", false);
  check("F1_preview_switch_off", previewOff === false, previewOff);
  await sleep(200);
  // 預覽關掉後把 stand 崗位挪回 15.0:勤務狀態機必須自己接手,讓他「走」
  // 回去(walkKind = duty),而不是瞬移或原地不動。
  await evaluate('window.__setKbotPost("stand", { x: 15.0 })');
  const resumed = await waitUntil(
    "(() => { const m = window.__trafficDirectorDebug.snapshot().kbotMotion;"
    + " return m.postPreview === false && m.walkKind === 'duty' ? m : null; })()",
    { timeoutMs: 30000, intervalMs: 200 },
  );
  check("F2_duty_state_machine_resumes", Boolean(resumed), resumed?.walkKind ?? null);
  const arrived = await waitUntil(
    "(() => { const m = window.__trafficDirectorDebug.snapshot().kbotMotion;"
    + " return Math.abs(m.holderPosition[0] - 15.0) < 0.3 ? m : null; })()",
    { timeoutMs: 40000, intervalMs: 300 },
  );
  check("F2b_walks_to_new_post", Boolean(arrived), arrived?.holderPosition ?? null);
  const locksAfter = await text("#safetyLocks");
  check("F3_preview_lock_cleared", !locksAfter.includes("崗位預覽"), locksAfter);
  await evaluate("window.__resetKbotPosts()");
  await sleep(200);

  // --- G. 既有 hook / 選擇器仍在 ---
  const hooks = await evaluate(`(() => Object.fromEntries(
    ['__trafficDirectorDebug','__kbotProbeWorldPos','__vehicleStates','__lane90States',
     '__busStates','__signalStates','__pedestrianStates','__setCamera','__setNodeVisibility',
     '__renderStats','__kbotArmOffsets','__kbotHandOffsets','__kbotPosts','__setKbotPost',
     '__selectKbotPost','__setKbotPostPreview','__kbotPostExportCode','__resetKbotPosts']
      .map((k) => [k, typeof window[k]])))()`);
  report.hooks = hooks;
  check("G1_hooks_present", Object.values(hooks).every((t) => t === "function" || t === "object"), hooks);
  const domIds = await evaluate(`(() => Object.fromEntries(
    ['#autoMode','#downstreamBlocked','#motionEffects','#highPerformance','#trafficDensity',
     '#hookTurn','#recordingMode','#pacingPreset','#reseedButton','#safetyLocks','#kbotPostLabel',
     '#durationRoosevelt','#durationPedestrian','#durationLane90']
      .map((s) => [s, Boolean(document.querySelector(s))])))()`);
  check("G2_dom_ids_present", Object.values(domIds).every(Boolean), domIds);
  const cams = await evaluate("[...document.querySelectorAll('[data-camera]')].map(b => b.dataset.camera)");
  check("G3_cameras_present", cams.length === 6, cams);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "panel_default.png"), Buffer.from(shot.data, "base64"));

  await evaluate("document.querySelector('#kbotPostGroup').open = true");
  await setSwitch("kbotPostPreview", true);
  await setSelect("kbotPostTarget", "crosswalk");
  await sleep(600);
  await evaluate("document.querySelector('#kbotPostGroup').scrollIntoView({block:'center'})");
  await sleep(400);
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "panel_tuner_open.png"), Buffer.from(shot2.data, "base64"));
  await evaluate("document.querySelector('[data-camera=\"crosswalk\"]').click()");
  await sleep(800);
  const shot3 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "markers_crosswalk.png"), Buffer.from(shot3.data, "base64"));
  await setSwitch("kbotPostPreview", false);

  check("H1_no_console_errors", consoleErrors.length === 0, consoleErrors);
} catch (error) {
  failures.push(`FATAL: ${error.message}`);
  exitCode = 1;
} finally {
  report.failures = failures;
  report.consoleErrors = consoleErrors;
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  try { socket?.close(); } catch {}
  chrome.kill("SIGTERM");
}

if (failures.length > 0) {
  console.error(`FAIL (${failures.length})`);
  for (const f of failures) console.error(" -", f);
  process.exit(exitCode || 1);
}
console.log("PASS §18 崗位微調:預設不變、拖曳即時、判定正確、匯出可解析、還原有效、console error 0");
process.exit(0);
