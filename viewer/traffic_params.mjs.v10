// ---------------------------------------------------------------------------
// §19 參數登錄表(共用層)
//
// san 的需求:「我想要所有參數都是可以控制設定的,而不是只有某些部分可以設定」。
//
// 這個模組不擁有任何參數,只負責:分組metadata、註冊、套用、還原、
// 序列化(localStorage / JSON 檔 / 可貼回原始碼的片段)。
// 參數本身的 get/set 住在擁有該綁定的模組裡(coreParamDefs() 在
// traffic_simulation_core.mjs;viewerParamDefs() 在 traffic_director.js),
// 因為 ES module 的匯出是 live binding —— 只有定義它的模組能重新指派,
// 而重新指派之後所有 import 端自動看到新值。
// ---------------------------------------------------------------------------

export const PARAM_GROUPS = Object.freeze([
  Object.freeze({
    id: "signal", label: "號誌與相位",
    note: "相位秒數、黃燈尾段、淨空判定",
  }),
  Object.freeze({
    id: "speed", label: "速度",
    note: "車速範圍、行人步速、轉彎速限",
  }),
  Object.freeze({
    id: "density", label: "車流量與生成",
    note: "三種模式的車數/人數、生成跨距、排隊間距。改了要按「重新產生」",
  }),
  Object.freeze({
    id: "following", label: "跟車與安全",
    note: "跟車間距、路口衝突區、行穿線淨空餘裕",
  }),
  Object.freeze({
    id: "kbot", label: "KBot 勤務",
    note: "崗位座標、走路與勤務速度、進場延遲、駐留門檻",
  }),
  Object.freeze({
    id: "bus", label: "公車靠站",
    note: "停留秒數、上車判定、停靠點",
  }),
  Object.freeze({
    id: "pedestrian", label: "行人",
    note: "穿越走廊、庇護帶、月台、模型身高與步態",
  }),
  Object.freeze({
    id: "hook", label: "機車待轉區",
    note: "待轉格幾何與淨空門檻(待轉區預設關閉,見「進階」)",
  }),
  Object.freeze({
    id: "appearance", label: "外觀與配色",
    note: "KBot 塗裝、輪胎輪圈、車輛與行人配色",
  }),
  Object.freeze({
    id: "render", label: "畫面與效能",
    note: "目標張數、像素比、UI 更新頻率、曝光與燈光",
  }),
  Object.freeze({
    id: "geometry", label: "實景校準幾何",
    note: "這一組是從 gongguan_v54_environment.glb 實測出來的。"
      + "改了模擬就會偏離實景,只有在重新校準時才該動。",
    calibration: true,
  }),
]);

const STORAGE_KEY = "gongguan.params.v1";

export function createParamRegistry(defs) {
  const params = new Map();
  const defaults = new Map();
  for (const def of defs) {
    if (params.has(def.id)) throw new Error(`參數 id 重複:${def.id}`);
    params.set(def.id, def);
    defaults.set(def.id, def.get());
  }

  const clamp = (def, value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return def.get();
    if (def.kind === "color") {
      return Math.max(0, Math.min(0xffffff, Math.round(n)));
    }
    const lo = Number.isFinite(def.min) ? def.min : -Infinity;
    const hi = Number.isFinite(def.max) ? def.max : Infinity;
    return Math.max(lo, Math.min(hi, n));
  };

  return {
    groups: PARAM_GROUPS,
    defs: () => [...params.values()],
    get: (id) => params.get(id)?.get(),
    def: (id) => params.get(id),
    defaultOf: (id) => defaults.get(id),
    isDirty: (id) => {
      const def = params.get(id);
      if (!def) return false;
      return Math.abs(def.get() - defaults.get(id)) > 1e-9;
    },
    dirtyIds() {
      return [...params.keys()].filter((id) => (
        Math.abs(params.get(id).get() - defaults.get(id)) > 1e-9
      ));
    },
    set(id, value) {
      const def = params.get(id);
      if (!def) return null;
      const next = clamp(def, value);
      def.set(next);
      return next;
    },
    reset(id) {
      const def = params.get(id);
      if (!def) return null;
      def.set(defaults.get(id));
      return defaults.get(id);
    },
    resetGroup(groupId) {
      const touched = [];
      for (const [id, def] of params) {
        if (def.group !== groupId) continue;
        def.set(defaults.get(id));
        touched.push(id);
      }
      return touched;
    },
    resetAll() {
      for (const [id, def] of params) def.set(defaults.get(id));
      return [...params.keys()];
    },
    // 只序列化「與預設不同」的值,檔案才不會被幾十個沒動過的數字淹掉。
    toJSON() {
      const out = {};
      for (const [id, def] of params) {
        const value = def.get();
        if (Math.abs(value - defaults.get(id)) > 1e-9) out[id] = value;
      }
      return out;
    },
    fromJSON(data) {
      const applied = [];
      const unknown = [];
      for (const [id, value] of Object.entries(data ?? {})) {
        const def = params.get(id);
        if (!def) { unknown.push(id); continue; }
        def.set(clamp(def, value));
        applied.push(id);
      }
      return { applied, unknown };
    },
    save() {
      try {
        const payload = this.toJSON();
        if (Object.keys(payload).length === 0) {
          localStorage.removeItem(STORAGE_KEY);
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        }
        return true;
      } catch { return false; }
    },
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { applied: [], unknown: [] };
        return this.fromJSON(JSON.parse(raw));
      } catch { return { applied: [], unknown: [] }; }
    },
    clearSaved() {
      try { localStorage.removeItem(STORAGE_KEY); return true; } catch { return false; }
    },
    // 產生可直接貼回原始碼的片段:只列改過的項目,附原值註解。
    toCodeSnippet() {
      const dirty = [...params.entries()].filter(([id, def]) => (
        Math.abs(def.get() - defaults.get(id)) > 1e-9
      ));
      if (dirty.length === 0) {
        return "// 目前所有參數都是預設值,沒有需要貼回原始碼的變更。";
      }
      const lines = [
        "// 公館 viewer 參數覆寫(由控制面板「全部參數」匯出)",
        "// 貼回對應模組的常數宣告,或用 applyParamOverrides() 餵進去。",
        "{",
      ];
      for (const [id, def] of dirty) {
        const now = def.get();
        const was = defaults.get(id);
        const shown = def.kind === "color"
          ? `0x${Math.round(now).toString(16).padStart(6, "0")}`
          : String(Number(now.toFixed(4)));
        const wasShown = def.kind === "color"
          ? `0x${Math.round(was).toString(16).padStart(6, "0")}`
          : String(Number(was.toFixed(4)));
        lines.push(`  ${JSON.stringify(id)}: ${shown},`
          + `  // ${def.label}${def.unit ? ` (${def.unit})` : ""}，原值 ${wasShown}`);
      }
      lines.push("}");
      return lines.join("\n");
    },
  };
}
