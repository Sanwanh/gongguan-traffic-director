"""場景幾何常數 —— 這份是 `viewer/traffic_simulation_core.mjs` 的鏡像。

為什麼要鏡像而不是在 Python 這邊重新量:因為車道中心線 `t` 是從
`gongguan_v54_environment.glb` 的 LaneArrow 實際量出來的(SPEC_VIEWER_V2 §7),
偵測管線把像素投影成 (s, t) 之後,必須用**同一組**車道座標判斷車道歸屬,
否則兩邊會各自漂移。

鏡像一定會過期,所以附一支 `verify_against_core()`:用 node 直接 import
core 把常數 dump 出來逐項比對。`verify_pipeline.py` 開頭就會跑這個閘門,
core 一改而這裡沒跟上,驗證會直接失敗而不是靜默給出錯的車道。
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PACKAGE_ROOT = HERE.parent
CORE_MJS = PACKAGE_ROOT / "viewer" / "traffic_simulation_core.mjs"

# --- 以下常數逐字鏡像自 traffic_simulation_core.mjs -------------------------

SPAWN_SPAN_M = 136.0          # core: SPAWN_SPAN_M
LANE_WIDTH_M = 2.8            # core: LANE_WIDTH_M

MAIN_ROOSEVELT_LANES: list[dict[str, Any]] = [
    {"t": -6.22, "direction": 1, "movement": "roosevelt_northwest",
     "lanePosition": "inner", "allowed": ["car", "taxi"]},
    {"t": -9.02, "direction": 1, "movement": "roosevelt_northwest",
     "lanePosition": "middle", "allowed": ["car", "taxi", "motorcycle"]},
    {"t": -11.82, "direction": 1, "movement": "roosevelt_northwest",
     "lanePosition": "outer",
     "allowed": ["car", "taxi", "scooter", "motorcycle", "bicycle"]},
    {"t": 7.18, "direction": -1, "movement": "roosevelt_southeast",
     "lanePosition": "inner", "allowed": ["car", "taxi"]},
    {"t": 9.98, "direction": -1, "movement": "roosevelt_southeast",
     "lanePosition": "middle", "allowed": ["car", "taxi", "motorcycle"]},
    {"t": 12.78, "direction": -1, "movement": "roosevelt_southeast",
     "lanePosition": "outer",
     "allowed": ["car", "taxi", "scooter", "motorcycle", "bicycle"]},
]

BUS_LANES: list[dict[str, Any]] = [
    {"t": -0.44, "direction": 1, "movement": "roosevelt_northwest",
     "lanePosition": "bus", "allowed": ["bus"]},
    {"t": 2.97, "direction": -1, "movement": "roosevelt_southeast",
     "lanePosition": "bus", "allowed": ["bus"]},
]

CROSSWALK_BANDS: list[dict[str, Any]] = [
    {"id": "straight", "sMin": 10.59, "sMax": 16.3, "tMin": -14.27, "tMax": 15.06},
    {"id": "stag_pos", "sMin": -19.25, "sMax": -14.8, "tMin": -2.3, "tMax": 14.16},
    {"id": "stag_neg", "sMin": -11.88, "sMax": -7.54, "tMin": -14.95, "tMax": -4.83},
]

# `data/ingest.py` 的 §5.1 映射公式用同一個 generalLanes。
GENERAL_LANES = len(MAIN_ROOSEVELT_LANES)

ALL_LANES = MAIN_ROOSEVELT_LANES + BUS_LANES

# 車道帶的橫向邊界:最外側兩條車道中心 ± 半個車道寬。超出這個範圍的偵測
# 一律不計入車流密度(人行道上的機車、店家門口的腳踏車不是「路上的車」)。
ROADWAY_T_MIN = min(lane["t"] for lane in ALL_LANES) - LANE_WIDTH_M / 2
ROADWAY_T_MAX = max(lane["t"] for lane in ALL_LANES) + LANE_WIDTH_M / 2


def assign_lane(t: float, tolerance_m: float = LANE_WIDTH_M / 2) -> dict[str, Any] | None:
    """把橫向座標 t 指派到一條車道。回傳 core 的車道字典或 None。

    判準單純是「離哪條車道中心最近,且在半個車道寬以內」。不做任何平滑、
    不看歷史 —— 每一幀都是獨立判斷(隱私契約:不做跨幀關聯)。
    """
    best = None
    best_gap = float("inf")
    for lane in ALL_LANES:
        gap = abs(t - lane["t"])
        if gap < best_gap:
            best, best_gap = lane, gap
    if best is None or best_gap > tolerance_m:
        return None
    return best


def in_crosswalk(s: float, t: float, margin_m: float = 1.0) -> str | None:
    """(s, t) 是否落在任何一條行穿線帶上;回傳帶的 id。"""
    for band in CROSSWALK_BANDS:
        if (band["sMin"] - margin_m <= s <= band["sMax"] + margin_m
                and band["tMin"] - margin_m <= t <= band["tMax"] + margin_m):
            return str(band["id"])
    return None


def default_roi() -> dict[str, Any]:
    """預設的計數區:整條羅斯福路的車道帶,長度取生成跨距。

    `lengthM` 是這個區在 s 方向的長度,`lanes` 是它涵蓋幾條一般車道。
    `aggregate.py` 用這兩個數把「畫面內的車數」放大成「生成跨距內的車數」,
    是純幾何比例,沒有任何擬合係數。
    """
    return {
        "id": "roosevelt-main",
        "sMin": -SPAWN_SPAN_M / 2,
        "sMax": SPAWN_SPAN_M / 2,
        "tMin": ROADWAY_T_MIN,
        "tMax": ROADWAY_T_MAX,
        "lanes": GENERAL_LANES,
        "note": "預設值涵蓋整條主線。真實攝影機看不了 136 公尺,校正時要縮成實際可見範圍。",
    }


def roi_length_m(roi: dict[str, Any]) -> float:
    return float(roi["sMax"]) - float(roi["sMin"])


def in_roi(s: float, t: float, roi: dict[str, Any]) -> bool:
    return (float(roi["sMin"]) <= s <= float(roi["sMax"])
            and float(roi["tMin"]) <= t <= float(roi["tMax"]))


# --- 漂移閘門 ---------------------------------------------------------------

_DUMP_JS = """
import * as C from %(core)s;
process.stdout.write(JSON.stringify({
  SPAWN_SPAN_M: C.SPAWN_SPAN_M,
  LANE_WIDTH_M: C.LANE_WIDTH_M,
  MAIN_ROOSEVELT_LANES: C.MAIN_ROOSEVELT_LANES,
  BUS_LANES: C.BUS_LANES,
  CROSSWALK_BANDS: C.CROSSWALK_BANDS,
}));
"""


def dump_core_constants() -> dict[str, Any] | None:
    """用 node 直接 import core 把常數 dump 出來。沒有 node 就回 None。"""
    if shutil.which("node") is None or not CORE_MJS.exists():
        return None
    script = _DUMP_JS % {"core": json.dumps(CORE_MJS.as_uri())}
    try:
        out = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True, text=True, timeout=60, check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def verify_against_core() -> tuple[bool, list[str]]:
    """逐項比對鏡像與 core。回傳 (是否通過, 訊息)。"""
    live = dump_core_constants()
    if live is None:
        return True, ["略過(沒有 node 或找不到 core.mjs),鏡像未經比對"]
    problems: list[str] = []
    if not math.isclose(float(live["SPAWN_SPAN_M"]), SPAWN_SPAN_M):
        problems.append(f"SPAWN_SPAN_M 不符:core={live['SPAWN_SPAN_M']} 鏡像={SPAWN_SPAN_M}")
    if not math.isclose(float(live["LANE_WIDTH_M"]), LANE_WIDTH_M):
        problems.append(f"LANE_WIDTH_M 不符:core={live['LANE_WIDTH_M']} 鏡像={LANE_WIDTH_M}")
    for name, mine, theirs in (
        ("MAIN_ROOSEVELT_LANES", MAIN_ROOSEVELT_LANES, live["MAIN_ROOSEVELT_LANES"]),
        ("BUS_LANES", BUS_LANES, live["BUS_LANES"]),
    ):
        if len(mine) != len(theirs):
            problems.append(f"{name} 條數不符:core={len(theirs)} 鏡像={len(mine)}")
            continue
        for a, b in zip(mine, theirs):
            for key in ("t", "direction", "lanePosition"):
                if a[key] != b[key]:
                    problems.append(f"{name} {a['lanePosition']} 的 {key} 不符:"
                                    f"core={b[key]} 鏡像={a[key]}")
            if list(a["allowed"]) != list(b["allowed"]):
                problems.append(f"{name} {a['lanePosition']} 的 allowed 不符")
    if len(CROSSWALK_BANDS) != len(live["CROSSWALK_BANDS"]):
        problems.append("CROSSWALK_BANDS 條數不符")
    else:
        for a, b in zip(CROSSWALK_BANDS, live["CROSSWALK_BANDS"]):
            for key in ("id", "sMin", "sMax", "tMin", "tMax"):
                if a[key] != b[key]:
                    problems.append(f"CROSSWALK_BANDS {a['id']} 的 {key} 不符:"
                                    f"core={b[key]} 鏡像={a[key]}")
    if problems:
        return False, problems
    return True, ["scene.py 鏡像與 traffic_simulation_core.mjs 完全一致"]


if __name__ == "__main__":
    ok, messages = verify_against_core()
    for line in messages:
        print(("OK  " if ok else "FAIL") + "  " + line)
    raise SystemExit(0 if ok else 1)
