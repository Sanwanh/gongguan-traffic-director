"""偵測框 → 模擬座標 → 聚合量 → `gongguan.intersection.state.v1` JSON。

## 為什麼影像的映射公式跟 VD 不一樣

`data/ingest.py` 從 VD 拿到的是**流率**(輛/5分鐘),而模擬要的是**同一時刻
場景裡有幾台車**,所以它必須繞一圈 `q = k·v` 把流率換成密度。

影像不用繞。一張影格直接就是密度的量測 —— 畫面裡有幾台車就是幾台車。
所以這裡的公式只有一個純幾何的比例放大:

    N = count_in_roi × (generalLanes / roiLanes) × (spanM / roiLengthM)

沒有 `q = k·v`、沒有速度、沒有 `speedFloorKph` 這個工程判斷常數。
**影像量密度比 VD 量密度更直接,而且不需要任何假設。**

## 反過來說,影像量不到什麼(必須誠實)

**車速量不到。** 速度需要「同一台車在兩個時刻的位置」,那就是跨幀身分關聯
(re-ID),隱私契約 §24.3.2 明文禁止。所以 `simulation.speedRangeMps` 一律
`null`,viewer 會沿用目前的車速設定。這是設計取捨,不是還沒做完。

**流率(輛/小時)量不到。** 同上,過線計數需要關聯。輸出的
`detectors[].lanes[].volume` 一律 `null`,另外給一個誠實命名的
`presentCount`(此刻在這條車道上的車數)。

## 信任邊界

`detector.Detection` 只在這個模組的函式區域內存在。投影成 (s, t) 之後
`Detection` 就被丟棄,不進任何回傳值。`assert_privacy_clean()` 會遞迴掃過
輸出 JSON,出現任何個體識別欄位就 raise —— 白名單思維的反面守門。
"""
from __future__ import annotations

import math
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Sequence

import numpy as np

import scene
from detector import Detection, PERSON_CLASSES, VEHICLE_CLASSES
from homography import Calibration, away_direction

SCHEMA_ID = "gongguan.intersection.state.v1"
TAIPEI = timezone(timedelta(hours=8))

# 隱私守門與 data/ingest.py 共用 data/privacy.py 的兩層實作(§27)。
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent / "data"))
from privacy import DENY_NORMALIZED, privacy_problems  # noqa: E402

BANNED_KEYS = DENY_NORMALIZED

# 車種映射:COCO 類別 → 模擬的 5 種。模擬沒有貨車型別,所以 truck 併進 bus
# (與 data/ingest.py 對 VD `Lvolume` 的處理一致),並同樣夾在 20%。
BUS_SHARE_CAP = 0.20
# 速克達 : 打檔車 = 0.55 : 0.10,出自 rules JSON 的
# vehicle_mix_project_assumption。COCO 只有一個 motorcycle 類,分不出來 ——
# **這是專案假設,不是量測**,輸出會標明。
SCOOTER_RATIO = 0.55 / (0.55 + 0.10)

# 佇列判定:相鄰兩台車在 s 方向的間距超過這個值就算「不是同一條車陣」。
# 一台小客車 4.5 m + 停等間距,取 12 m 是工程判斷,輸出標 confidence:estimated。
QUEUE_GAP_LIMIT_M = 12.0


def _now() -> datetime:
    return datetime.now(TAIPEI)


def assert_privacy_clean(payload: Any, path: str = "") -> None:
    """遞迴掃過輸出,出現任何個體識別欄位就 raise。跨越信任邊界前的最後一道門。"""
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in BANNED_KEYS:
                raise AssertionError(f"隱私違規:輸出含禁止欄位 {path}.{key}(硬規則 3)")
            assert_privacy_clean(value, f"{path}.{key}")
    elif isinstance(payload, (list, tuple)):
        for item in payload:
            assert_privacy_clean(item, path + "[]")
    elif isinstance(payload, Detection):
        raise AssertionError(f"隱私違規:偵測框洩漏到輸出 {path}")


def stop_line_for_lane(lane: dict[str, Any]) -> tuple[float, int] | None:
    """車輛依這條車道行進時,第一條會遇到的行穿線邊界。

    回傳 (停止線的 s, 車陣往哪個方向延伸)。純幾何,由 CROSSWALK_BANDS 推出來,
    沒有手打座標。
    """
    direction = int(lane["direction"])
    lane_t = float(lane["t"])
    edges: list[float] = []
    for band in scene.CROSSWALK_BANDS:
        if not (band["tMin"] <= lane_t <= band["tMax"]):
            continue
        # 行進方向 +1(往 +s)先碰到 sMin;方向 −1 先碰到 sMax。
        edges.append(float(band["sMin"] if direction > 0 else band["sMax"]))
    if not edges:
        return None
    stop_s = min(edges) if direction > 0 else max(edges)
    return stop_s, -direction


def project_detections(
    detections: Iterable[Detection],
    calib: Calibration,
    radial_correction_m: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """把框投影成地面點。**這是 Detection 最後一次被看到的地方。**

    取樣點是框底邊中點(近似觸地點)。實測端到端誤差幾乎純粹是「徑向」的
    (沿相機視線),切向只有 0.16 m —— 物理成因是框底邊對應的是**近側**輪廓
    觸地點而不是車體中心。所以修正量是沿視線往遠處推一個常數,方向由
    `away_direction()` 從 H 的 Jacobian 求得,不需要相機外參。
    """
    correction = radial_correction_m or {}
    out: list[dict[str, Any]] = []
    for det in detections:
        foot = det.foot
        ground = calib.project([foot])[0]
        if not np.isfinite(ground).all():
            continue
        s, t = float(ground[0]), float(ground[1])
        group = "person" if det.cls in PERSON_CLASSES else "vehicle"
        shift = float(correction.get(group, 0.0))
        if shift:
            away = away_direction(calib.h, foot)
            if away is not None:
                s += shift * float(away[0])
                t += shift * float(away[1])
        # `px` 是框底邊中點,留給驗證腳本做配對用;它**不會**進入輸出 JSON
        # (`aggregate_frames` 只讀 cls/s/t/group),框本身到這裡就結束了。
        out.append({"cls": det.cls, "score": round(float(det.score), 4),
                    "s": s, "t": t, "group": group, "px": [foot[0], foot[1]]})
    # det / detections 到此為止不再被引用;呼叫端拿到的只有 (cls, s, t)。
    return out


def _mix_from_counts(counts: Counter[str]) -> tuple[dict[str, float] | None, list[str], str]:
    """COCO 類別計數 → 模擬的 5 種車種比例。"""
    warnings: list[str] = []
    car = counts.get("car", 0)
    moto = counts.get("motorcycle", 0)
    large = counts.get("bus", 0) + counts.get("truck", 0)
    bike = counts.get("bicycle", 0)
    total = car + moto + large + bike
    if total == 0:
        return None, ["畫面中沒有偵測到任何車輛,車種組成沿用專案假設。"], "unavailable"
    mix = {
        "car": car / total,
        "scooter": (moto / total) * SCOOTER_RATIO,
        "motorcycle": (moto / total) * (1.0 - SCOOTER_RATIO),
        "bus": large / total,
        "bicycle": bike / total,
    }
    if counts.get("truck", 0):
        warnings.append(
            f"{counts['truck']} 台貨車併入公車比例(模擬沒有貨車型別),會高估公車。")
    if mix["bus"] > BUS_SHARE_CAP:
        warnings.append(
            f"大型車佔比 {mix['bus']:.0%} 已夾到 {BUS_SHARE_CAP:.0%}"
            "(場景只有兩條公車專用道,超過會撞到防碰撞減車),超出部分補回小客車。")
        excess = mix["bus"] - BUS_SHARE_CAP
        mix["bus"] = BUS_SHARE_CAP
        mix["car"] += excess
    if moto:
        warnings.append(
            "速克達 / 打檔車的比例 0.55:0.10 是專案假設 —— COCO 只有一個 "
            "motorcycle 類,影像分不出來。")
    return mix, warnings, "cv-class-counts"


def aggregate_frames(
    frames: Sequence[Sequence[dict[str, Any]]],
    calib: Calibration,
    *,
    detector_info: dict[str, Any],
    observed_at: datetime | None = None,
    stale_after_s: int = 120,
    site: dict[str, Any] | None = None,
    source_id: str | None = None,
    source_note: str = "",
) -> dict[str, Any]:
    """把 N 張獨立影格的地面點聚合成一份 schema JSON。

    多張影格只是**同一個瞬時量的重複量測**(降低偵測雜訊),逐幀彼此獨立、
    不做任何配對 —— 這不是追蹤。
    """
    warnings: list[str] = []
    roi = calib.roi or scene.default_roi()
    roi_lanes = int(roi.get("lanes", scene.GENERAL_LANES))
    roi_length = scene.roi_length_m(roi)
    if roi_length <= 0:
        raise ValueError("ROI 的 s 範圍必須為正")

    per_frame_vehicles: list[int] = []
    per_frame_pedestrians: list[int] = []
    class_counts: Counter[str] = Counter()
    lane_counts: Counter[tuple[int, str]] = Counter()
    lane_class_counts: dict[tuple[int, str], Counter[str]] = {}
    off_lane = 0
    queue_samples: dict[str, list[float]] = {}

    for points in frames:
        vehicles = 0
        pedestrians = 0
        lane_positions: list[tuple[dict[str, Any], float]] = []
        for point in points:
            s, t = point["s"], point["t"]
            if point["group"] == "person":
                if scene.in_roi(s, t, roi) or scene.in_crosswalk(s, t) is not None:
                    pedestrians += 1
                continue
            if not scene.in_roi(s, t, roi):
                continue
            lane = scene.assign_lane(t)
            if lane is None:
                off_lane += 1
                continue
            vehicles += 1
            class_counts[point["cls"]] += 1
            key = (int(lane["direction"]), str(lane["lanePosition"]))
            lane_counts[key] += 1
            lane_class_counts.setdefault(key, Counter())[point["cls"]] += 1
            lane_positions.append((lane, s))
        per_frame_vehicles.append(vehicles)
        per_frame_pedestrians.append(pedestrians)
        for name, length in _queue_lengths(lane_positions).items():
            queue_samples.setdefault(name, []).append(length)

    frame_count = max(1, len(frames))
    mean_vehicles = sum(per_frame_vehicles) / frame_count
    mean_pedestrians = sum(per_frame_pedestrians) / frame_count

    if off_lane:
        warnings.append(
            f"{off_lane} 個車輛偵測落在車道帶之外(離最近車道中心超過 "
            f"{scene.LANE_WIDTH_M / 2:.1f} m),已排除。")

    # --- 密度 → 場景車數(純幾何比例,無任何擬合係數)---------------------
    scale = (scene.GENERAL_LANES / max(1, roi_lanes)) * (scene.SPAWN_SPAN_M / roi_length)
    raw_population = mean_vehicles * scale
    population_min = int(max(0, math.floor(raw_population)))
    population_max = int(max(0, math.ceil(raw_population)))
    if population_max == population_min:
        population_max = population_min + 1
    population_min = min(population_min, 80)
    population_max = min(population_max, 80)
    if mean_vehicles < 3:
        warnings.append(
            f"計數區內平均只有 {mean_vehicles:.1f} 台車,樣本太小:差一台就是 "
            f"±{100 / max(1.0, mean_vehicles):.0f}% 的估計誤差。請把計數區放大、"
            "或換一個看得到更長路段的機位。")
    if roi_length < scene.SPAWN_SPAN_M * 0.5:
        warnings.append(
            f"計數區只有 {roi_length:.0f} 公尺,不到生成跨距 "
            f"{scene.SPAWN_SPAN_M:.0f} 公尺的一半;車數是 ×{scale:.2f} 外推的,"
            "外推倍率越大、單一漏檢的影響越大。")

    mix, mix_warnings, mix_source = _mix_from_counts(class_counts)
    warnings.extend(mix_warnings)

    # --- 方向比例:由車道歸屬直接得到(幾何,不是追蹤)-------------------
    nw = sum(count for (direction, _), count in lane_counts.items() if direction > 0)
    se = sum(count for (direction, _), count in lane_counts.items() if direction < 0)
    if nw + se > 0:
        direction_split = round(nw / (nw + se), 4)
        direction_split_source = "measured"
    else:
        direction_split = 0.5
        direction_split_source = "assumed-5050"

    # --- 逐車道權重(千分比)---------------------------------------------
    lane_quota: dict[str, dict[str, int]] | None = {}
    for direction, key in ((1, "1"), (-1, "-1")):
        buckets = {position: lane_counts.get((direction, position), 0)
                   for position in ("inner", "middle", "outer")}
        total = sum(buckets.values())
        if total == 0:
            lane_quota = None
            break
        lane_quota[key] = {position: int(round(1000.0 * value / total))
                           for position, value in buckets.items()}
    if lane_quota is None:
        warnings.append("有一個方向完全沒有偵測到車輛,車道權重沿用模擬預設規則。")

    # --- 逐車道明細(schema 的 detectors[].lanes[])------------------------
    lanes_out: list[dict[str, Any]] = []
    for index, lane in enumerate(scene.MAIN_ROOSEVELT_LANES):
        key = (int(lane["direction"]), str(lane["lanePosition"]))
        classes = lane_class_counts.get(key, Counter())
        lanes_out.append({
            "laneNo": index,
            "lanePosition": lane["lanePosition"],
            "positionConfidence": "calibrated",
            "direction": lane["direction"],
            "movement": lane["movement"],
            # 流率量不到(需要跨幀關聯),誠實留 null;給的是此刻在場車數。
            "volume": None,
            "volumeNote": "影像無法在不做跨幀身分關聯的前提下量流率,故為 null。",
            "presentCount": round(lane_counts.get(key, 0) / frame_count, 3),
            "speedKph": None,
            "occupancy": None,
            "classes": {
                "small": classes.get("car", 0),
                "motorcycle": classes.get("motorcycle", 0) + classes.get("bicycle", 0),
                "large": classes.get("bus", 0) + classes.get("truck", 0),
            },
        })

    queue_len = {name: round(float(np.median(values)), 2)
                 for name, values in queue_samples.items() if values}

    observed = observed_at or _now()
    generated = _now()
    quality = calib.quality or {}
    mc = quality.get("monteCarlo") or {}
    verdict = quality.get("verdict", "unknown")
    if verdict != "pass":
        warnings.append(f"校正品質為 {verdict};位置精度可能不如標示值。")

    payload = {
        "schema": SCHEMA_ID,
        "generatedAt": generated.isoformat(timespec="seconds"),
        "observedAt": observed.isoformat(timespec="seconds"),
        "ageAtGenerationS": int((generated - observed).total_seconds()),
        "staleAfterS": int(stale_after_s),
        "source": {
            "id": source_id or f"cv-{calib.id}",
            "kind": "file",
            "labelZhTw": "路口影像偵測(本機)",
            "realtime": True,
            "origin": (f"{detector_info.get('project', '?')} "
                       f"{detector_info.get('model', '?')} + 地面單應性投影"),
            "originUrl": None,
            "license": detector_info.get("license"),
            "updateIntervalS": None,
            "frameKind": "temporal",
            "frameCount": frame_count,
            "note": source_note or (
                "影格只存在偵測程序的行程記憶體中;跨越信任邊界的只有這份聚合 JSON。"),
        },
        "site": site or {
            "id": "gongguan-roosevelt-lane90",
            "labelZhTw": "羅斯福路四段 × 羅斯福路四段90巷",
            "lat": 25.0145,
            "lon": 121.534,
        },
        "confidence": {
            "level": "on-site",
            "labelZhTw": "路口實測",
            "note": (
                "攝影機就在這個路口,不是走廊代理值。"
                + (f"校正自檢:點擊雜訊 σ={mc.get('sigmaPx')}px 時位置不確定度 "
                   f"p95 = {mc.get('p95M')} m。" if mc.get("p95M") is not None else "")
                + "端到端誤差幾乎是徑向的(沿相機視線),切向(車道歸屬)較可信。"
            ),
        },
        "detectors": [{
            "id": calib.id,
            "roadZhTw": "羅斯福路四段",
            "role": "on-site",
            "distanceM": 0,
            "laneCount": len(lanes_out),
            "intervalS": None,
            "status": "ok",
            "lanes": lanes_out,
        }],
        "measurement": {
            "vehiclesInRoi": round(mean_vehicles, 3),
            "pedestriansInRoi": round(mean_pedestrians, 3),
            "sampleFrames": frame_count,
            "perFrameVehicles": per_frame_vehicles,
            "perFramePedestrians": per_frame_pedestrians,
            "roi": {"sMin": roi["sMin"], "sMax": roi["sMax"],
                    "tMin": roi["tMin"], "tMax": roi["tMax"],
                    "lengthM": round(roi_length, 2), "lanes": roi_lanes},
            "extrapolationFactor": round(scale, 4),
            "populationRaw": round(raw_population, 3),
            "queueLenM": queue_len or None,
            "queueMethod": (f"同一車道相鄰車輛間距 < {QUEUE_GAP_LIMIT_M:.0f} m 視為同一條車陣;"
                            "停止線由 CROSSWALK_BANDS 幾何推得"),
            "queueConfidence": "estimated",
            "flowVph": None,
            "speedRangeKph": None,
            "formula": ("N = count_in_roi x (generalLanes / roiLanes) x (spanM / roiLengthM)"
                        " ; 影像直接量密度,不需要 q = k*v"),
        },
        "simulation": {
            "densityMode": "live",
            "mainVehicleMin": population_min,
            "mainVehicleMax": population_max,
            "pedestrianMin": int(math.floor(mean_pedestrians)),
            "pedestrianMax": int(math.ceil(mean_pedestrians)) or 1,
            "sideVehiclesPerColumn": None,
            # 影像量不到車速(需要跨幀關聯,隱私契約禁止)。null = 沿用模擬預設。
            "speedRangeMps": None,
            "speedCapped": False,
            "mix": ({key: round(value, 4) for key, value in mix.items()} if mix else None),
            "mixSource": mix_source,
            "directionSplit": direction_split,
            "directionSplitSource": direction_split_source,
            "laneQuota": lane_quota,
            "laneQuotaUnit": "permille-weight",
            "laneQuotaMethod": "homography-lane-assignment",
            "laneQuotaConfidence": "calibrated",
        },
        "pedestrians": {
            "count": round(mean_pedestrians, 2),
            "source": f"cv-{calib.id}",
            "note": ("此刻在計數區與行穿線帶上的人數(逐幀獨立計數再平均)。"
                     "不做人臉、不做跨幀身分追蹤,不配發任何 id。"),
        },
        "bus": {"arrivals": None, "source": None},
        "signal": None,
        "privacy": {
            "aggregateOnly": True,
            "personalData": "none",
            "faceRecognition": False,
            "reIdentification": False,
            "rawImagery": False,
        },
        "vision": {
            "detector": detector_info,
            "calibrationId": calib.id,
            "calibrationVerdict": verdict,
            "calibrationUncertaintyP95M": mc.get("p95M"),
            "radialCorrectionM": calib.radial_correction_m or {},
        },
        "degraded": False,
        "warnings": warnings,
    }
    assert_privacy_clean(payload)
    return payload


def _queue_lengths(lane_positions: Sequence[tuple[dict[str, Any], float]]) -> dict[str, float]:
    """每個進場方向的停等車陣長度(公尺)。

    從停止線往上游走,只要相鄰兩台車的間距 < QUEUE_GAP_LIMIT_M 就繼續延伸。
    只用「此刻的位置」,不需要任何跨幀資訊。
    """
    grouped: dict[str, list[float]] = {}
    stops: dict[str, tuple[float, int]] = {}
    for lane, s in lane_positions:
        stop = stop_line_for_lane(lane)
        if stop is None:
            continue
        name = str(lane["movement"])
        stops[name] = stop
        stop_s, extend = stop
        # 只算停止線上游的車(車陣往 extend 方向延伸)。
        if (s - stop_s) * extend < 0:
            continue
        grouped.setdefault(name, []).append(s)
    out: dict[str, float] = {}
    for name, positions in grouped.items():
        stop_s, extend = stops[name]
        ordered = sorted(positions, key=lambda value: abs(value - stop_s))
        tail = stop_s
        for value in ordered:
            if abs(value - tail) > QUEUE_GAP_LIMIT_M:
                break
            tail = value
        out[name] = abs(tail - stop_s)
    return out


def degraded_state(reason: str, source_id: str = "cv-unavailable") -> dict[str, Any]:
    """任何一步失敗都回這個 —— 合法 JSON、degraded=true,viewer 自動退回 synthetic。"""
    now = _now()
    payload = {
        "schema": SCHEMA_ID,
        "generatedAt": now.isoformat(timespec="seconds"),
        "observedAt": now.isoformat(timespec="seconds"),
        "ageAtGenerationS": 0,
        "staleAfterS": 0,
        "source": {
            "id": source_id, "kind": "file", "labelZhTw": "路口影像偵測(無資料)",
            "realtime": False, "origin": None, "originUrl": None, "license": None,
            "updateIntervalS": None, "note": reason,
        },
        "site": {"id": "gongguan-roosevelt-lane90",
                 "labelZhTw": "羅斯福路四段 × 羅斯福路四段90巷",
                 "lat": 25.0145, "lon": 121.534},
        "confidence": {"level": "unavailable", "labelZhTw": "無資料", "note": reason},
        "detectors": [],
        "measurement": None,
        "simulation": None,
        "pedestrians": {"count": None, "source": None, "note": reason},
        "bus": {"arrivals": None, "source": None},
        "signal": None,
        "privacy": {"aggregateOnly": True, "personalData": "none",
                    "faceRecognition": False, "reIdentification": False,
                    "rawImagery": False},
        "degraded": True,
        "warnings": [reason],
    }
    assert_privacy_clean(payload)
    return payload
