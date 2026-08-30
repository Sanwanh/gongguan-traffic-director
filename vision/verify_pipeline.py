#!/usr/bin/env python3
"""自我驗證迴圈:沒有真實 CCTV,也要證明這條管線是對的。

## 想法

viewer 的 3D 場景知道每一台車、每一個行人的精確 (s, t),也知道每一條白漆的
精確 (s, t)。把場景截圖當成「攝影機拍到的畫面」,就得到一組免費、可重複、
精度到公分的真值。跑完整條管線再跟真值比,就能量出端到端誤差。

## 閘門(每一道量的東西不一樣,絕對不能混在一起看)

| 閘門 | 量什麼 | 為什麼要分開 |
|---|---|---|
| A1 幾何(無雜訊) | 用畫面內**全部**白漆角點解 H,把真值地面像素餵回去 | 純粹驗單應性數學。確定性、適合當回歸測試。 |
| A2 幾何(真實點擊) | 只用 8 個點、加 σ=1px 點擊雜訊 | 驗「Monte-Carlo 自檢預測的不確定度」有沒有低估真實誤差。自檢說謊比誤差大更危險。 |
| B 偵測 | 跑偵測器,看召回與定位誤差 | 會被 domain gap 汙染(低多邊形渲染對 COCO 權重是 out-of-distribution),數字**不能**拿去推論真實影像。 |
| C 車道 | 投影後的車道歸屬 vs 真值車道 | 這才是數位孿生真正需要的量。誤差幾乎純徑向,所以車道歸屬比絕對位置可信得多。 |
| D 端到端 | 完整 JSON 的車數 / 方向比例 vs 真值 | 含 ROI 外推,是 san 實際會看到的數字。 |
| E 隱私 | 輸出 JSON 掃禁字、跑上一棒的 validate_state、量體積比 | 硬規則 3 與資料契約的可稽核證據。 |

B/C/D 各跑兩種輸入:**理想偵測器**(直接餵真值像素)與**真實偵測器**。
兩者相減就是偵測器本身的貢獻,不會把幾何誤差算到偵測器頭上、反之亦然。

## 用法

    python verify_pipeline.py --harvest          # 先重抓合成影格再驗(要 serve.py 在跑)
    python verify_pipeline.py                    # 用 truth/ 既有的影格
    python verify_pipeline.py --tags p1 p3 --model yolox_m --conf 0.05
    python verify_pipeline.py --json out/verify_report.json
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import scene                                                             # noqa: E402
from aggregate import BANNED_KEYS, aggregate_frames, project_detections  # noqa: E402
from detector import Detector, PERSON_CLASSES                            # noqa: E402
from homography import apply_h, away_direction, solve, solve_h           # noqa: E402

TRUTH_DIR = HERE / "truth"

# `window.__vehicleStates()` 只給 movement,不給 direction / sideAccess,
# 所以在這裡從 movement 推。這兩個名字出自 traffic_simulation_core.mjs 的
# MAIN_ROOSEVELT_LANES[].movement;其餘 movement(lane90_oneway)都是巷弄支流,
# 不屬於主線車流預算。
MAIN_MOVEMENTS = {"roosevelt_northwest": 1, "roosevelt_southeast": -1}

# 配對門檻:偵測框底邊中點與真值地面點的像素距離上限。車輛給 120 px、
# 行人給 60 px(行人小、密,放太寬會亂配)。沿用研究階段的值。
MATCH_GATE_PX = {"vehicle": 120.0, "person": 60.0}

A1_MEDIAN_LIMIT_M = 0.05     # 閘門 A1:無雜訊時真值像素的投影誤差中位數上限
A1_P95_LIMIT_M = 0.20

# 閘門 A2:實測 p95 不得超過自檢預測 p95 的這個倍數。
# 為什麼是 2.0 而不是 1.0:自檢給的是「點擊雜訊分佈下的 p95」,而實測是**單一
# 次抽樣**的 p95,樣本只有畫面裡那二三十個物件。單抽的 p95 高於分佈 p95 大約
# 有一半的機會,倍率 1.5~2 完全在抽樣變異內。真正要擋的是「自檢說 5 cm、實際
# 50 cm」這種數量級的謊,所以再加一道整體中位數的檢查(見 A2_MEDIAN_BAND)。
A2_ENVELOPE = 2.0
A2_MEDIAN_BAND = (0.5, 1.5)  # 全部機位的「實測/預測」比值中位數必須落在這裡
D_IDEAL_MEASUREMENT_LIMIT_PCT = 10.0  # 閘門 D:理想偵測器的量測誤差中位數上限


def load_validate_state():
    """借用 data/ingest.py 的 validate_state,證明輸出真的能被上一棒收下。"""
    path = HERE.parent / "data" / "ingest.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("gongguan_ingest", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules["gongguan_ingest"] = module
    spec.loader.exec_module(module)
    return module.validate_state


# --------------------------------------------------------------------------
# 真值載入
# --------------------------------------------------------------------------

def sim_camera(truth: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """把 camera.position / target 由世界座標換回模擬座標 (s, y, t)。"""
    affine = truth["affine"]
    basis = np.stack([np.array(affine["ds"]), np.array(affine["dy"]),
                      np.array(affine["dt"])], axis=1)
    origin = np.array(affine["origin"])
    position = np.linalg.solve(basis, np.array(truth["camera"]["position"]) - origin)
    target = np.linalg.solve(basis, np.array(truth["camera"]["target"]) - origin)
    return position, target


def in_frame(px: Sequence[float], width: int, height: int, margin: int = 0) -> bool:
    return (-margin <= px[0] < width + margin) and (-margin <= px[1] < height + margin)


def visible_truth(truth: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """畫面內、而且在相機前方的真值物件。

    只用「在畫面內」會把相機**背後**的物件也算進來(透視投影會把它們鏡射到
    畫面裡),召回率就會被無故壓低。所以要再用視線方向濾一次。
    """
    width, height = int(truth["width"]), int(truth["height"])
    cam, target = sim_camera(truth)
    forward = np.array([target[0] - cam[0], target[2] - cam[2]])
    forward = forward / max(np.linalg.norm(forward), 1e-9)

    def front(s: float, t: float) -> bool:
        return bool(np.array([s - cam[0], t - cam[2]]) @ forward > 0)

    vehicles = [v for v in truth["vehicles"]
                if in_frame(v["groundPx"], width, height) and front(v["s"], v["t"])]
    peds = [p for p in truth["pedestrians"]
            if p.get("visible") and in_frame(p["groundPx"], width, height)
            and front(p["s"], p["t"])]
    return {"vehicles": vehicles, "pedestrians": peds}


def all_mark_corners(truth: dict[str, Any]) -> list[dict[str, Any]]:
    width, height = int(truth["width"]), int(truth["height"])
    pool: list[dict[str, Any]] = []
    for group, band in ((truth["stripes"], "straight-crosswalk"),
                        (truth["other"], "other-marking")):
        for mark in group:
            for corner in mark["corners"]:
                if in_frame(corner["px"], width, height):
                    pool.append({"px": list(corner["px"]), "s": corner["s"],
                                 "t": corner["t"], "band": band,
                                 "label": mark["name"]})
    return pool


# --------------------------------------------------------------------------
# 模擬「使用者點校正點」
# --------------------------------------------------------------------------

def pick_calibration_points(pool: list[dict[str, Any]], count: int, sigma_px: float,
                            rng: np.random.Generator) -> list[dict[str, Any]]:
    """依 README 的建議策略挑點:跨帶、散開、加上像素級的點擊雜訊。

    這不是作弊 —— 這正是使用者拿到 `calibrate.py marks` 的清單之後會做的事:
    在畫面上找到那條白漆的角落點下去。σ 就是人手點不準的量。
    """
    if len(pool) < 4:
        return list(pool)
    bands = {p["band"] for p in pool}
    coords = np.array([p["px"] for p in pool], dtype=float)
    # 起手式:全畫面距離最遠的一對。有兩個帶時強制這對來自不同的帶 ——
    # 實測「所有點都在同一條白漆帶上」會讓誤差暴增 20 倍,而條件數毫無反應。
    best_pair, best_gap = (0, 1), -1.0
    for i in range(len(pool)):
        for j in range(i + 1, len(pool)):
            if len(bands) > 1 and pool[i]["band"] == pool[j]["band"]:
                continue
            gap = float(np.hypot(*(coords[i] - coords[j])))
            if gap > best_gap:
                best_pair, best_gap = (i, j), gap
    chosen = list(best_pair)
    while len(chosen) < min(count, len(pool)):
        rest = [i for i in range(len(pool)) if i not in chosen]
        gaps = [min(float(np.hypot(*(coords[i] - coords[j]))) for j in chosen) for i in rest]
        chosen.append(rest[int(np.argmax(gaps))])
    picked = []
    for index in chosen:
        point = dict(pool[index])
        noise = rng.normal(0.0, sigma_px, 2)
        point["px"] = [point["px"][0] + float(noise[0]), point["px"][1] + float(noise[1])]
        picked.append(point)
    return picked


def roi_from_points(points: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """計數區 = 校正點在地面上涵蓋的範圍 ∩ 車道帶。

    **只在校正點涵蓋的範圍內計數。** 超出校正範圍的外推不可信(靠近地平線時
    1 px 可以是幾十公尺),寧可少算再靠幾何比例放大,也不要把地平線上的雜訊
    當成一公里外的車陣。
    """
    ss = [p["s"] for p in points]
    ts = [p["t"] for p in points]
    t_min = max(min(ts), scene.ROADWAY_T_MIN)
    t_max = min(max(ts), scene.ROADWAY_T_MAX)
    lanes = [lane for lane in scene.MAIN_ROOSEVELT_LANES if t_min <= lane["t"] <= t_max]
    return {
        "id": "verify-visible",
        "sMin": float(min(ss)), "sMax": float(max(ss)),
        "tMin": float(t_min), "tMax": float(t_max),
        "lanes": max(1, len(lanes)),
        "note": "校正點在地面上的包絡,交集車道帶。",
    }


# --------------------------------------------------------------------------
# 配對與誤差
# --------------------------------------------------------------------------

def match_and_measure(projected: Sequence[dict[str, Any]],
                      truths: Sequence[dict[str, Any]],
                      group: str, cam_st: np.ndarray,
                      calib_h: np.ndarray) -> dict[str, Any]:
    """把投影點配到真值上,拆成徑向 / 切向誤差。

    誤差幾乎全部落在徑向(沿相機視線)—— 因為框底邊中點對應的是**近側**輪廓
    觸地點而不是物體中心。切向誤差才是決定「車道歸不歸得對」的量。
    """
    gate = MATCH_GATE_PX[group]
    ordered = sorted(projected, key=lambda d: -d["score"])
    used: set[int] = set()
    rows: list[dict[str, Any]] = []
    for det in ordered:
        best, best_gap = None, float("inf")
        for index, item in enumerate(truths):
            if index in used:
                continue
            gap = math.hypot(det["px"][0] - item["groundPx"][0],
                             det["px"][1] - item["groundPx"][1])
            if gap < best_gap:
                best, best_gap = index, gap
        if best is None or best_gap > gate:
            continue
        used.add(best)
        item = truths[best]
        truth_t = item.get("t", item.get("lane_t"))
        unit = np.array([item["s"] - cam_st[0], truth_t - cam_st[2]], dtype=float)
        distance = float(np.linalg.norm(unit))
        if distance < 1e-6:
            continue
        unit = unit / distance
        error = np.array([det["s"] - item["s"], det["t"] - truth_t])
        jac = away_direction(calib_h, det["px"])
        agreement = float(np.clip(jac @ unit, -1.0, 1.0)) if jac is not None else None
        rows.append({
            "radialM": float(error @ unit),
            "tangentialM": float(error @ np.array([-unit[1], unit[0]])),
            "totalM": float(np.linalg.norm(error)),
            "distanceM": distance,
            "matchPx": best_gap,
            "detClass": det["cls"],
            "truthType": item.get("type", "person"),
            "truthT": float(truth_t),
            "projectedT": float(det["t"]),
            "jacobianAgreement": agreement,
        })
    return {"rows": rows, "truthCount": len(truths), "detCount": len(ordered)}


def summarise(values: Sequence[float]) -> dict[str, Any] | None:
    if not len(values):
        return None
    arr = np.asarray(values, dtype=float)
    return {
        "n": int(len(arr)),
        "median": round(float(np.median(arr)), 3),
        "mean": round(float(arr.mean()), 3),
        "p95": round(float(np.percentile(arr, 95)), 3),
        "max": round(float(arr.max()), 3),
    }


def lane_accuracy(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """車道歸屬正確率:投影後的 t 指派到的車道 vs 真值 t 指派到的車道。"""
    hit = miss = unknown = 0
    for row in rows:
        truth_lane = scene.assign_lane(row["truthT"])
        got_lane = scene.assign_lane(row["projectedT"])
        if truth_lane is None:
            unknown += 1
            continue
        if (got_lane is not None
                and got_lane["lanePosition"] == truth_lane["lanePosition"]
                and got_lane["direction"] == truth_lane["direction"]):
            hit += 1
        else:
            miss += 1
    total = hit + miss
    return {"matched": total, "correct": hit, "wrong": miss, "truthOffLane": unknown,
            "accuracy": round(hit / total, 4) if total else None}


def geometry_error(h: np.ndarray, items: Sequence[dict[str, Any]],
                   roi: dict[str, Any] | None = None) -> tuple[list[float], list[float]]:
    """回傳 (ROI 內的誤差, ROI 外的誤差)。

    分開量是必要的:單應性在校正點涵蓋的範圍內是內插,範圍外是外推,而外推誤差
    在靠近地平線時會爆炸。管線只在 ROI 內計數,所以精度承諾也只能對 ROI 內說。
    """
    inside: list[float] = []
    outside: list[float] = []
    for item in items:
        got = apply_h(h, [item["groundPx"]])[0]
        truth_t = item.get("t", item.get("lane_t"))
        if not np.isfinite(got).all():
            continue
        error = float(math.hypot(got[0] - item["s"], got[1] - truth_t))
        if roi is None or scene.in_roi(item["s"], truth_t, roi):
            inside.append(error)
        else:
            outside.append(error)
    return inside, outside


# --------------------------------------------------------------------------
# 單一機位
# --------------------------------------------------------------------------

def verify_tag(tag: str, detector: Detector, args: argparse.Namespace,
               validate_state) -> dict[str, Any]:
    truth_path = TRUTH_DIR / f"truth_{tag}.json"
    shot_path = TRUTH_DIR / f"shot_{tag}.png"
    truth = json.loads(truth_path.read_text(encoding="utf-8"))
    width, height = int(truth["width"]), int(truth["height"])
    cam_st, _ = sim_camera(truth)
    # 用 tag 的位元組當種子:跨行程可重現(Python 的 str hash 有隨機化)。
    rng = np.random.default_rng(int.from_bytes(tag.encode("utf-8")[:8], "little") or 1)

    if truth.get("poseClamped"):
        return {"tag": tag, "skipped":
                f"機位被 viewer 的相機守衛夾走 {truth['poseDeltaM']:.1f} m,"
                "畫面看到的不是要求的視角(實測會拍到屋頂內側)"}

    pool = all_mark_corners(truth)
    if len(pool) < 4:
        return {"tag": tag, "skipped": f"畫面內只有 {len(pool)} 個可用白漆角點"}

    seen = visible_truth(truth)
    veh_truth, ped_truth = seen["vehicles"], seen["pedestrians"]
    targets = veh_truth + ped_truth

    # --- 真實作業條件:N 個點 + σ 點擊雜訊 -------------------------------
    points = pick_calibration_points(pool, args.points, args.click_sigma, rng)
    roi = roi_from_points(points)
    calib = solve(f"verify-{tag}", points, width, height, roi,
                  mc_sigma_px=args.click_sigma, mc_trials=args.mc_trials,
                  min_points=6, note=f"自我驗證迴圈 {tag}")

    # --- 閘門 A1:無雜訊、全部角點 ---------------------------------------
    h_ref = solve_h([p["px"] for p in pool], [(p["s"], p["t"]) for p in pool])
    a1_in, a1_out = geometry_error(h_ref, targets, roi)
    a1 = {
        "calibrationPoints": len(pool),
        "n": len(a1_in),
        "medianM": round(float(np.median(a1_in)), 5) if a1_in else None,
        "p95M": round(float(np.percentile(a1_in, 95)), 5) if a1_in else None,
        "maxM": round(float(max(a1_in)), 5) if a1_in else None,
        "outsideRoiN": len(a1_out),
        "outsideRoiMedianM": round(float(np.median(a1_out)), 5) if a1_out else None,
    }
    a1["pass"] = bool(a1["medianM"] is not None and a1["medianM"] <= A1_MEDIAN_LIMIT_M
                      and a1["p95M"] <= A1_P95_LIMIT_M)

    # --- 閘門 A2:自檢有沒有低估真實誤差 ---------------------------------
    a2_in, a2_out = geometry_error(calib.h, targets, roi)
    predicted = calib.quality["monteCarlo"].get("p95M")
    measured_p95 = float(np.percentile(a2_in, 95)) if a2_in else None
    a2 = {
        "calibrationPoints": len(points),
        "bands": sorted({p["band"] for p in points}),
        "n": len(a2_in),
        "medianM": round(float(np.median(a2_in)), 5) if a2_in else None,
        "measuredP95M": round(measured_p95, 5) if measured_p95 is not None else None,
        "selfCheckP95M": predicted,
        "envelope": A2_ENVELOPE,
        "outsideRoiN": len(a2_out),
        "outsideRoiMedianM": round(float(np.median(a2_out)), 5) if a2_out else None,
    }
    a2["pass"] = bool(predicted is not None and measured_p95 is not None
                      and measured_p95 <= predicted * A2_ENVELOPE)

    # --- 閘門 B/C:理想偵測器 vs 真實偵測器 -------------------------------
    def to_projected(items: Sequence[tuple[str, float, Sequence[float]]]) -> list[dict[str, Any]]:
        out = []
        for cls, score, px in items:
            ground = apply_h(calib.h, [px])[0]
            if not np.isfinite(ground).all():
                continue
            out.append({"cls": cls, "score": score, "px": list(px),
                        "s": float(ground[0]), "t": float(ground[1]),
                        "group": "person" if cls in PERSON_CLASSES else "vehicle"})
        return out

    # 理想偵測器把真值車種一起帶進來,才驗得到 mix 的映射;位置仍走同一條
    # homography,所以它與真實偵測器的差就是「偵測器的貢獻」。
    truth_class = {"car": "car", "taxi": "car", "bus": "bus",
                   "scooter": "motorcycle", "motorcycle": "motorcycle",
                   "bicycle": "bicycle"}
    ideal_input = [(truth_class.get(item.get("type", "car"), "car"), 1.0, item["groundPx"])
                   for item in veh_truth]
    ideal_input += [("person", 1.0, item["groundPx"]) for item in ped_truth]
    ideal_projected = to_projected(ideal_input)

    with Image.open(shot_path) as image:
        detections = detector.detect_image(image, conf=args.conf)
    infer_ms = detector.last_infer_ms
    real_projected = project_detections(detections, calib)
    del detections                    # 框到此為止,不再被引用(信任邊界)

    results: dict[str, Any] = {}
    for name, projected in (("ideal", ideal_projected), ("detector", real_projected)):
        veh = match_and_measure([p for p in projected if p["group"] == "vehicle"],
                                veh_truth, "vehicle", cam_st, calib.h)
        ped = match_and_measure([p for p in projected if p["group"] == "person"],
                                ped_truth, "person", cam_st, calib.h)
        block: dict[str, Any] = {}
        for key, matched, truths in (("vehicle", veh, veh_truth), ("person", ped, ped_truth)):
            rows = matched["rows"]
            block[key] = {
                "matched": len(rows), "truthVisible": matched["truthCount"],
                "detected": matched["detCount"],
                "recall": round(len(rows) / matched["truthCount"], 4)
                          if matched["truthCount"] else None,
                "totalM": summarise([r["totalM"] for r in rows]),
                "radialM": summarise([r["radialM"] for r in rows]),
                "absTangentialM": summarise([abs(r["tangentialM"]) for r in rows]),
                "lane": lane_accuracy(rows),
            }
        agreements = [r["jacobianAgreement"] for r in veh["rows"] + ped["rows"]
                      if r["jacobianAgreement"] is not None]
        block["jacobianVsCameraCos"] = (round(float(np.median(agreements)), 4)
                                        if agreements else None)
        # 閘門 F 要用的原始逐筆徑向 / 切向,留在報表裡(全是聚合幾何量,無識別資訊)。
        block["rows"] = {
            "vehicle": [{"radialM": r["radialM"], "tangentialM": r["tangentialM"]}
                        for r in veh["rows"]],
            "person": [{"radialM": r["radialM"], "tangentialM": r["tangentialM"]}
                       for r in ped["rows"]],
        }
        results[name] = block

    # --- 閘門 D:端到端 JSON ---------------------------------------------
    states = {
        name: aggregate_frames([projected], calib, detector_info=detector.describe(),
                               source_id=f"verify-{tag}-{name}")
        for name, projected in (("ideal", ideal_projected), ("detector", real_projected))
    }
    mains = [v for v in truth["vehicles"] if v["movement"] in MAIN_MOVEMENTS]
    truth_budget = len(mains)
    half_span = scene.SPAWN_SPAN_M / 2
    truth_in_span = len([v for v in mains if abs(v["s"]) <= half_span])
    truth_in_roi = len([v for v in mains if scene.in_roi(v["s"], v["t"], roi)])
    nw = sum(1 for v in mains if MAIN_MOVEMENTS[v["movement"]] > 0)
    truth_split = round(nw / truth_budget, 4) if truth_budget else None
    truth_ped_visible = len(ped_truth)
    scale = states["ideal"]["measurement"]["extrapolationFactor"]
    # 「ROI 代表性」:把 ROI 內的**真值**車數用同一條幾何比例放大之後,
    # 跟真正在跨距內的車數差多少。這一項與偵測器、與單應性都無關 —— 它純粹
    # 是「攝影機剛好看到的那一段路,密度有沒有代表整條路」。
    truth_scaled = truth_in_roi * scale
    representativeness = round(truth_scaled / max(1, truth_in_span), 3)

    end_to_end = {}
    for name, state in states.items():
        simulation = state["simulation"]
        mid = (simulation["mainVehicleMin"] + simulation["mainVehicleMax"]) / 2
        end_to_end[name] = {
            "truthBudget": truth_budget,
            "truthInSpan": truth_in_span,
            "truthInRoi": truth_in_roi,
            "roiRepresentativeness": representativeness,
            "estimated": [simulation["mainVehicleMin"], simulation["mainVehicleMax"]],
            # 純量測誤差:跟「ROI 內真值放大後的值」比,把 ROI 代表性剔除掉。
            "errVsRoiTruthPct": round(100 * (mid - truth_scaled) / max(1e-6, truth_scaled), 1),
            "errVsInSpanPct": round(100 * (mid - truth_in_span) / max(1, truth_in_span), 1),
            "errVsBudgetPct": round(100 * (mid - truth_budget) / max(1, truth_budget), 1),
            "extrapolationFactor": state["measurement"]["extrapolationFactor"],
            "vehiclesInRoi": state["measurement"]["vehiclesInRoi"],
            "truthPedestriansVisible": truth_ped_visible,
            "estimatedPedestrians": state["pedestrians"]["count"],
            "truthDirectionSplit": truth_split,
            "estimatedDirectionSplit": simulation["directionSplit"],
            "mix": simulation["mix"],
            "laneQuota": simulation["laneQuota"],
            "queueLenM": state["measurement"]["queueLenM"],
        }

    # --- 閘門 E:隱私與 schema --------------------------------------------
    serialised = json.dumps(states["detector"], ensure_ascii=False)
    banned_hits = sorted(key for key in BANNED_KEYS if f'"{key}"' in serialised)
    schema_problems = validate_state(states["detector"]) if validate_state else ["未載入驗證器"]
    output_bytes = len(serialised.encode("utf-8"))
    privacy = {
        "bannedKeyHits": banned_hits,
        "schemaProblems": schema_problems,
        "outputBytes": output_bytes,
        "frameBytes": shot_path.stat().st_size,
        "compressionRatio": round(shot_path.stat().st_size / max(1, output_bytes), 1),
        "pass": not banned_hits and not schema_problems,
    }

    return {
        "tag": tag,
        "inferMs": round(infer_ms, 1),
        "calibration": {
            "points": len(points), "bands": a2["bands"],
            "clickSigmaPx": args.click_sigma,
            "verdict": calib.quality["verdict"],
            "cond": calib.quality["cond"],
            "residualMedianM": calib.quality["residualM"]["median"],
            "roi": roi,
        },
        "a1": a1,
        "a2": a2,
        "detection": results,
        "endToEnd": end_to_end,
        "privacy": privacy,
        "state": states["detector"] if args.embed_state else None,
    }


# --------------------------------------------------------------------------
# 閘門 F:徑向修正到底能不能遷移到沒看過的機位
# --------------------------------------------------------------------------

def radial_transfer(frames: Sequence[dict[str, Any]], mode: str,
                    group: str) -> dict[str, Any]:
    """leave-one-frame-out:在其他機位學到的徑向修正,套到沒看過的機位有沒有用。

    這是「自我驗證迴圈到底是不是自我循環論證」的關鍵測試。如果修正只在學它的
    那個機位有效,那它就只是過擬合;要能遷移,才代表真的抓到了系統性偏差
    (框底邊中點 vs 物體中心)。
    """
    live = [f for f in frames if not f.get("skipped")]
    rows = {f["tag"]: f["detection"][mode]["rows"][group] for f in live}
    usable = {tag: value for tag, value in rows.items() if value}
    if len(usable) < 2:
        return {"n": 0, "note": "可用機位不足,無法做 leave-one-out"}
    before: list[float] = []
    after: list[float] = []
    learned: dict[str, float] = {}
    for held in usable:
        train = [r["radialM"] for tag, value in usable.items() if tag != held for r in value]
        if not train:
            continue
        correction = -float(np.median(train))
        learned[held] = round(correction, 3)
        for row in usable[held]:
            before.append(math.hypot(row["radialM"], row["tangentialM"]))
            after.append(math.hypot(row["radialM"] + correction, row["tangentialM"]))
    if not before:
        return {"n": 0, "note": "沒有配對到任何物件"}
    b, a = np.asarray(before), np.asarray(after)
    return {
        "n": int(len(b)),
        "learnedCorrectionM": learned,
        "beforeMedianM": round(float(np.median(b)), 3),
        "afterMedianM": round(float(np.median(a)), 3),
        "beforeP95M": round(float(np.percentile(b, 95)), 3),
        "afterP95M": round(float(np.percentile(a, 95)), 3),
        "medianImprovementPct": round(
            100 * (float(np.median(b)) - float(np.median(a))) / max(float(np.median(b)), 1e-9), 1),
    }


# --------------------------------------------------------------------------
# 報表
# --------------------------------------------------------------------------

def fmt(value: Any, spec: str = ".2f", dash: str = "—") -> str:
    return dash if value is None else format(value, spec)


def print_report(report: dict[str, Any]) -> None:
    meta = report["meta"]
    print("=" * 104)
    print("自我驗證迴圈 —— viewer 合成影格 → YOLOX 偵測 → 單應性投影 → 聚合 JSON")
    print("=" * 104)
    print(f"模型 {meta['detector']['model']}({meta['detector']['license']}, "
          f"{meta['detector']['project']} {meta['detector']['version']})  "
          f"providers={meta['detector']['providers']}  conf={meta['detector']['confThreshold']}")
    print(f"scene.py 對 core 的鏡像:{meta['sceneSync']}")
    print(f"機位 {len(report['frames'])} 個  ·  作業條件:{meta['points']} 個校正點、"
          f"點擊雜訊 σ={meta['clickSigmaPx']} px")

    print("\n[閘門 A1] 純幾何(無點擊雜訊,用畫面內全部白漆角點解 H);誤差只在 ROI 內計")
    print(f"  {'機位':6s} {'角點':>5s} {'ROI內':>6s} {'中位誤差':>11s} {'p95':>10s} "
          f"{'max':>10s} | {'ROI外':>6s} {'ROI外中位':>10s}  判定")
    for frame in report["frames"]:
        if frame.get("skipped"):
            print(f"  {frame['tag']:6s} 略過:{frame['skipped']}")
            continue
        a1 = frame["a1"]
        print(f"  {frame['tag']:6s} {a1['calibrationPoints']:5d} {a1['n']:6d} "
              f"{a1['medianM'] * 100:8.2f} cm {a1['p95M']:9.4f}m {a1['maxM']:9.4f}m | "
              f"{a1['outsideRoiN']:6d} {fmt(a1['outsideRoiMedianM'], '9.3f'):>10s}m  "
              f"{'PASS' if a1['pass'] else 'FAIL'}")

    print("\n[閘門 A2] 真實作業條件(8 個點 + σ=1px):實測誤差 vs 自檢預測的不確定度")
    print(f"  {'機位':6s} {'cond':>8s} {'殘差中位':>10s} {'中位誤差':>10s} "
          f"{'實測 p95':>10s} {'自檢 p95':>10s} {'比值':>7s}  判定")
    for frame in report["frames"]:
        if frame.get("skipped"):
            continue
        a2, cal = frame["a2"], frame["calibration"]
        ratio = (a2["measuredP95M"] / a2["selfCheckP95M"]
                 if a2["selfCheckP95M"] else None)
        print(f"  {frame['tag']:6s} {cal['cond']:8.2f} {cal['residualMedianM']:9.4f}m "
              f"{a2['medianM']:9.4f}m {fmt(a2['measuredP95M'], '9.4f'):>10s}m "
              f"{fmt(a2['selfCheckP95M'], '9.4f'):>10s}m {fmt(ratio, '6.2f'):>7s}  "
              f"{'PASS' if a2['pass'] else 'FAIL'}")

    for mode, title in (("ideal", "理想偵測器(直接餵真值像素,只含幾何誤差)"),
                        ("detector", "真實偵測器(含 domain gap,數字不可外推到真實影像)")):
        print(f"\n[閘門 B/C] {title}")
        print(f"  {'機位':6s} {'車輛配對/可見':>14s} {'召回':>6s} {'總誤差中位':>11s} "
              f"{'徑向中位':>10s} {'|切向|中位':>11s} {'車道正確率':>11s} "
              f"{'行人配對':>10s} {'行人總誤差':>11s}")
        for frame in report["frames"]:
            if frame.get("skipped"):
                continue
            veh = frame["detection"][mode]["vehicle"]
            ped = frame["detection"][mode]["person"]

            def med(block: dict[str, Any], key: str) -> str:
                stat = block.get(key)
                return f"{stat['median']:.2f} m" if stat else "—"

            accuracy = veh["lane"]["accuracy"]
            print(f"  {frame['tag']:6s} {veh['matched']:6d}/{veh['truthVisible']:<7d} "
                  f"{(veh['recall'] or 0) * 100:5.0f}% {med(veh, 'totalM'):>11s} "
                  f"{med(veh, 'radialM'):>10s} {med(veh, 'absTangentialM'):>11s} "
                  f"{(f'{accuracy * 100:.0f}%' if accuracy is not None else '—'):>11s} "
                  f"{ped['matched']:4d}/{ped['truthVisible']:<5d} "
                  f"{med(ped, 'totalM'):>11s}")

    print("\n[閘門 D] 端到端:完整 JSON 的車數 / 方向比例 vs 真值")
    print("  總誤差 = 量測誤差 × ROI 代表性。兩者要分開看:")
    print("    量測誤差   = 估計值 vs「ROI 內真值 × 同一條外推倍率」(管線自己的錯)")
    print("    ROI 代表性 = 「ROI 內真值 × 外推倍率」vs truthInSpan"
          "(攝影機剛好看到的那段路密不密,與管線無關)")
    print("    truthInSpan = 此刻真的在 136 m 生成跨距內的主線車數")
    print("    truthBudget = 模擬的主線車輛總數(mainVehicleMin/Max 的名目定義)")
    print(f"  {'機位':6s} {'模式':9s} {'ROI內':>6s} {'真值ROI':>7s} {'倍率':>6s} "
          f"{'估計':>9s} {'量測誤差':>9s} {'代表性':>7s} {'inSpan':>7s} {'總誤差':>8s} "
          f"{'budget':>7s} {'方向(估/真)':>14s}")
    for frame in report["frames"]:
        if frame.get("skipped"):
            continue
        for mode in ("ideal", "detector"):
            e2e = frame["endToEnd"][mode]
            split = (f"{e2e['estimatedDirectionSplit']:.2f}/{e2e['truthDirectionSplit']:.2f}"
                     if e2e["truthDirectionSplit"] is not None else "—")
            print(f"  {frame['tag']:6s} {mode:9s} {e2e['vehiclesInRoi']:6.1f} "
                  f"{e2e['truthInRoi']:7d} {e2e['extrapolationFactor']:6.2f} "
                  f"{str(e2e['estimated']):>9s} {e2e['errVsRoiTruthPct']:+8.1f}% "
                  f"{e2e['roiRepresentativeness']:7.2f} {e2e['truthInSpan']:7d} "
                  f"{e2e['errVsInSpanPct']:+7.1f}% {e2e['truthBudget']:7d} {split:>14s}")

    print("\n[閘門 F] 徑向修正的可遷移性(leave-one-frame-out)")
    print("  在其他機位學到「沿視線往遠處推 c 公尺」,套到沒看過的機位有沒有用。")
    print(f"  {'對象':8s} {'n':>5s} {'修正前中位':>11s} {'修正後中位':>11s} "
          f"{'修正前p95':>10s} {'修正後p95':>10s} {'改善':>8s}")
    for group, label in (("vehicle", "車輛"), ("person", "行人")):
        block = report["radialTransfer"][group]
        if not block.get("n"):
            print(f"  {label:8s} {block.get('note', '無資料')}")
            continue
        print(f"  {label:8s} {block['n']:5d} {block['beforeMedianM']:10.2f}m "
              f"{block['afterMedianM']:10.2f}m {block['beforeP95M']:9.2f}m "
              f"{block['afterP95M']:9.2f}m {block['medianImprovementPct']:+7.1f}%")

    print("\n[閘門 E] 隱私與 schema(輸出跑過 data/ingest.py 的 validate_state)")
    for frame in report["frames"]:
        if frame.get("skipped"):
            continue
        privacy = frame["privacy"]
        print(f"  {frame['tag']:6s} 禁字命中 {len(privacy['bannedKeyHits'])}  "
              f"schema 問題 {len(privacy['schemaProblems'])}  "
              f"輸出 {privacy['outputBytes']:,} B vs 影格 {privacy['frameBytes']:,} B "
              f"(壓縮 {privacy['compressionRatio']:.0f}x)  "
              f"{'PASS' if privacy['pass'] else 'FAIL'}")
        for problem in privacy["schemaProblems"]:
            print(f"         ! {problem}")

    summary = report["summary"]
    print("\n" + "-" * 104)
    print(f"閘門 A1 幾何(無雜訊)  {summary['a1Pass']}/{summary['frames']} 通過   "
          f"全體中位 {summary['a1MedianCm']} cm,p95 {summary['a1P95Cm']} cm")
    print(f"閘門 A2 自檢誠實度      {summary['a2Pass']}/{summary['frames']} 通過   "
          f"實測 p95 / 自檢預測 p95 中位 = {summary['a2RatioMedian']}")
    print(f"閘門 C 車道歸屬        理想 {summary['laneIdeal']}   "
          f"真實偵測器 {summary['laneDetector']}")
    print(f"閘門 D 量測誤差        理想 |誤差| 中位 {summary['measIdeal']}%  "
          f"(上限 {D_IDEAL_MEASUREMENT_LIMIT_PCT}%)   真實偵測器 {summary['measDetector']}%")
    print(f"閘門 D 總誤差(含代表性) 理想 {summary['popIdeal']}%   "
          f"真實偵測器 {summary['popDetector']}%   "
          f"ROI 代表性中位 {summary['representativeness']}")
    print(f"閘門 E 隱私 + schema    {summary['privacyPass']}/{summary['frames']} 通過")
    print(f"偵測延遲               中位 {summary['inferMsMedian']} ms")
    failed = [name for name, ok in summary["checks"].items() if not ok]
    print(f"\n總判定 {summary['verdict']}"
          + (f"  未過:{failed}" if failed else "")
          + "\n  (判定看 A1、A2、D 的**理想**欄與 E。B/C/D 的偵測器欄是資訊性的 ——"
            "合成畫面的召回率不能外推到真實影像,見下方誠實聲明。)")
    print("-" * 104)
    for line in report["honesty"]:
        print("  " + line)


def build_summary(frames: list[dict[str, Any]]) -> dict[str, Any]:
    live = [f for f in frames if not f.get("skipped")]
    if not live:
        return {"frames": 0, "verdict": "FAIL"}
    a1_pass = sum(1 for f in live if f["a1"]["pass"])
    a2_pass = sum(1 for f in live if f["a2"]["pass"])
    privacy_pass = sum(1 for f in live if f["privacy"]["pass"])
    a1_medians = [f["a1"]["medianM"] for f in live]
    a1_p95 = [f["a1"]["p95M"] for f in live]
    ratios = [f["a2"]["measuredP95M"] / f["a2"]["selfCheckP95M"]
              for f in live if f["a2"]["selfCheckP95M"]]

    def lane(mode: str) -> str:
        hit = sum(f["detection"][mode]["vehicle"]["lane"]["correct"] for f in live)
        total = sum(f["detection"][mode]["vehicle"]["lane"]["matched"] for f in live)
        return f"{100 * hit / total:.0f}% ({hit}/{total})" if total else "—"

    def pop(mode: str) -> float:
        return round(float(np.median([abs(f["endToEnd"][mode]["errVsInSpanPct"])
                                      for f in live])), 1)

    def meas(mode: str) -> float:
        return round(float(np.median([abs(f["endToEnd"][mode]["errVsRoiTruthPct"])
                                      for f in live])), 1)

    ratio_median = round(float(np.median(ratios)), 2) if ratios else None
    meas_ideal = meas("ideal")
    checks = {
        "a1": a1_pass == len(live),
        "a2PerFrame": a2_pass == len(live),
        "a2MedianBand": (ratio_median is not None
                         and A2_MEDIAN_BAND[0] <= ratio_median <= A2_MEDIAN_BAND[1]),
        "dIdealMeasurement": meas_ideal <= D_IDEAL_MEASUREMENT_LIMIT_PCT,
        "privacy": privacy_pass == len(live),
    }
    verdict = "PASS" if all(checks.values()) else "FAIL"
    return {
        "checks": checks,
        "frames": len(live),
        "a1Pass": a1_pass,
        "a1MedianCm": round(float(np.median(a1_medians)) * 100, 2),
        "a1P95Cm": round(float(np.median(a1_p95)) * 100, 2),
        "a2Pass": a2_pass,
        "a2RatioMedian": ratio_median,
        "a2MedianBand": list(A2_MEDIAN_BAND),
        "privacyPass": privacy_pass,
        "laneIdeal": lane("ideal"),
        "laneDetector": lane("detector"),
        "popIdeal": pop("ideal"),
        "popDetector": pop("detector"),
        "measIdeal": meas("ideal"),
        "measDetector": meas("detector"),
        "representativeness": round(float(np.median(
            [f["endToEnd"]["ideal"]["roiRepresentativeness"] for f in live])), 2),
        "inferMsMedian": round(float(np.median([f["inferMs"] for f in live])), 1),
        "recallVehicleDetector": round(float(np.median(
            [f["detection"]["detector"]["vehicle"]["recall"] or 0 for f in live])), 3),
        "recallPersonDetector": round(float(np.median(
            [f["detection"]["detector"]["person"]["recall"] or 0 for f in live])), 3),
        "verdict": verdict,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tags", nargs="*", default=None)
    parser.add_argument("--harvest", action="store_true", help="先跑 harvest_truth.mjs 重抓影格")
    parser.add_argument("--model", default="yolox_s")
    parser.add_argument("--conf", type=float, default=0.10)
    parser.add_argument("--points", type=int, default=8, help="每個機位模擬點幾個校正點")
    parser.add_argument("--click-sigma", type=float, default=1.0, help="模擬人手點擊誤差(像素)")
    parser.add_argument("--mc-trials", type=int, default=120)
    parser.add_argument("--providers", nargs="*", default=None)
    parser.add_argument("--json", default=None, help="把完整報表寫成 JSON")
    parser.add_argument("--embed-state", action="store_true", help="報表內附完整輸出 JSON")
    args = parser.parse_args(argv)

    ok, messages = scene.verify_against_core()
    if not ok:
        print("scene.py 與 traffic_simulation_core.mjs 不一致,先修好再驗:")
        for line in messages:
            print("  ! " + line)
        return 1

    if args.harvest:
        print("重抓合成影格…")
        result = subprocess.run(["node", str(HERE / "harvest_truth.mjs")],
                                cwd=HERE, capture_output=True, text=True)
        print(result.stdout.strip() or result.stderr.strip())
        if result.returncode != 0:
            return 1

    tags = args.tags or sorted(
        path.stem.removeprefix("truth_") for path in TRUTH_DIR.glob("truth_*.json"))
    if not tags:
        print(f"{TRUTH_DIR} 裡沒有真值檔。先跑:node harvest_truth.mjs")
        return 1

    detector = Detector(args.model, providers=args.providers, conf=args.conf)
    validate_state = load_validate_state()
    frames = [verify_tag(tag, detector, args, validate_state) for tag in tags]
    summary = build_summary(frames)
    report = {
        "schema": "gongguan.vision.verify.v1",
        "meta": {
            "detector": detector.describe(),
            "sceneSync": messages[0],
            "points": args.points,
            "clickSigmaPx": args.click_sigma,
            "truthDir": str(TRUTH_DIR),
        },
        "frames": frames,
        "radialTransfer": {
            "vehicle": radial_transfer(frames, "detector", "vehicle"),
            "person": radial_transfer(frames, "detector", "person"),
        },
        "summary": summary,
        "honesty": [
            "1. 閘門 B/C/D 的「真實偵測器」欄**不能**拿來推論真實 CCTV 的表現:低多邊形",
            "   渲染對 COCO 權重是 out-of-distribution,機車尤其會整批漏掉。可遷移的是",
            "   幾何(A1/A2)與方法論(C 的理想欄),不是召回率。真實影像的召回必須用",
            "   使用者自己的攝影機、人工標 20~30 個框來量。",
            "2. 閘門 D 的 truthInSpan 通常小於 truthBudget:模擬的 recycleMainVehicle()",
            "   讓車輛在 ±85 m 的軌道上循環,而生成跨距只有 ±68 m。所以就算密度量得完全",
            "   正確,估計值也不會等於 budget —— 這是模擬自己的性質,不是管線的誤差。",
            "3. 外推倍率越大,單一漏檢的影響越大。攝影機只看得到路口附近幾十公尺,而",
            "   場景是 136 m,這是視野的物理限制,不是管線的缺陷。",
        ],
    }
    print_report(report)

    if args.json:
        target = Path(args.json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
        print(f"\n報表已寫出 {target}")
    return 0 if summary["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
