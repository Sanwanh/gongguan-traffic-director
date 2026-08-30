#!/usr/bin/env python3
"""公館路口即時資料層 ingest(SPEC_VIEWER_V2 §24)。

把四種來源統一成 data/SCHEMA.md 定義的一份 JSON:

  synthetic  目前的模擬行為(預設值,永遠可用,不連任何網路)
  replay     用凍結的 2024-11-14 臺北市 VD 快照離線重播(真實資料,無需金鑰)
  tdx        TDX Live VD(需要 san 自己註冊的 client_id / client_secret)
  file       讀一個本機 JSON 檔或 URL(給 CV 影像管線與使用者自架服務用)

viewer 只認 schema,不管資料哪來。任何一步失敗都會輸出一份帶
``degraded``/``warnings`` 的合法 JSON,而不是拋錯 —— 場景永遠不會空掉。

只用 Python 標準函式庫,零外部相依、零 CDN。

用法::

    python3 data/ingest.py --source replay  --out data/live/replay.json
    python3 data/ingest.py --source replay  --frame 1
    python3 data/ingest.py --source synthetic --out data/live/synthetic.json
    python3 data/ingest.py --source tdx     --out data/live/tdx.json
    python3 data/ingest.py --source file --input somewhere.json --out data/live/custom.json
    python3 data/ingest.py --validate data/live/replay.json
    python3 data/ingest.py --serve-loop --source replay --interval 20

隱私(硬規則 3):輸出只含聚合量 —— 計數、密度、流率、速率、方向分佈。
沒有任何個體識別欄位,不做人臉、不做跨幀身分追蹤,不儲存或轉發任何影像。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
from privacy import privacy_problems  # noqa: E402

SCHEMA_ID = "gongguan.intersection.state.v1"
HERE = Path(__file__).resolve().parent
PACKAGE_ROOT = HERE.parent
TAIPEI = timezone(timedelta(hours=8))

TDX_TOKEN_URL = (
    "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/"
    "openid-connect/token"
)
TDX_LIVE_VD_URL = (
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/City/Taipei"
)
TDX_STATIC_VD_URL = (
    "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/VD/City/Taipei"
)
# 認證後的正常程式化存取,User-Agent 誠實表明自己是什麼。
# 絕不偽裝成瀏覽器去用未認證通道 —— 那是繞過認證(硬規則 4)。
USER_AGENT = "gongguan-traffic-director-ingest/1.0 (+https://github.com/Sanwanh/gongguan-traffic-director)"


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def now_taipei() -> datetime:
    return datetime.now(TAIPEI)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def load_config() -> dict[str, Any]:
    return json.loads((HERE / "detectors.json").read_text("utf-8"))


def http_get(url: str, headers: dict[str, str] | None = None,
             timeout: float = 15.0) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, **(headers or {}),
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def largest_remainder(shares: dict[str, float], total: int) -> dict[str, int]:
    """把 total 依 shares 比例配成整數,總和精確等於 total。"""
    if total <= 0 or not shares:
        return {key: 0 for key in shares}
    scaled = {key: share * total for key, share in shares.items()}
    out = {key: int(math.floor(value)) for key, value in scaled.items()}
    remainder = total - sum(out.values())
    order = sorted(shares, key=lambda k: scaled[k] - math.floor(scaled[k]),
                   reverse=True)
    for key in order[:remainder]:
        out[key] += 1
    return out


# ---------------------------------------------------------------------------
# §24.2 映射:VD 逐車道量測 → 模擬參數
#
# 每一條公式與每一個係數的來源都寫在 data/SCHEMA.md「映射公式」一節,
# 以及 detectors.json 的 $comment 裡。這裡只實作,不發明。
# ---------------------------------------------------------------------------

def lane_density(volume_5min: float, speed_kph: float,
                 speed_floor_kph: float) -> tuple[float, float, float, bool]:
    """回傳 (flow_vph, speed_used_kph, density_veh_per_km, speed_floored)。

    q = Volume × 12(單位換算,無係數)
    k = q / v(交通流基本關係式 q = k·v 的定義式)
    """
    flow_vph = max(0.0, volume_5min) * 12.0
    usable = speed_kph if (speed_kph is not None and speed_kph > 0) else 0.0
    speed_used = max(speed_floor_kph, usable)
    return flow_vph, speed_used, flow_vph / speed_used, usable < speed_floor_kph


def classify_lanes(lanes: list[dict[str, Any]]) -> None:
    """就地填入 lanePosition / positionConfidence(detectors.json laneMapping)。"""
    bus_lanes = [
        lane for lane in lanes
        if lane["volume"] >= 5 and lane["classes"]["large"] / max(1.0, lane["volume"]) > 0.9
    ]
    for lane in bus_lanes:
        lane["lanePosition"] = "bus"
        lane["positionConfidence"] = "heuristic"
    general = [lane for lane in lanes if lane not in bus_lanes]
    ranked = sorted(
        general,
        key=lambda lane: (
            -(lane["classes"]["motorcycle"] / max(1.0, lane["volume"])),
            lane["laneNo"],
        ),
    )
    if not ranked:
        return
    third = math.ceil(len(ranked) / 3)
    for index, lane in enumerate(ranked):
        bucket = index // third if third else 0
        lane["lanePosition"] = ["outer", "middle", "inner"][min(2, bucket)]
        lane["positionConfidence"] = "heuristic"


def map_reading_to_state(
    reading: dict[str, Any],
    config: dict[str, Any],
    source_block: dict[str, Any],
    observed_at: str,
    stale_after_s: int,
) -> dict[str, Any]:
    """一台偵測器的逐車道量測 → 一份完整的 schema JSON。"""
    sim = config["simulation"]
    span_m = float(sim["spanM"])
    general_lanes = int(sim["generalLanes"])
    floor_kph = float(sim["speedFloorKph"])
    speed_cap_kph = float(sim["speedLimitKph"]) + float(sim["speedToleranceKph"])
    warnings: list[str] = []

    lanes = reading["lanes"]
    for lane in lanes:
        flow, speed_used, density, floored = lane_density(
            lane["volume"], lane["speedKph"], floor_kph,
        )
        lane["flowVph"] = round(flow, 1)
        lane["speedUsedKph"] = round(speed_used, 2)
        lane["densityVehPerKm"] = round(density, 3)
        lane["speedFloored"] = floored
    classify_lanes(lanes)

    total_volume = sum(lane["volume"] for lane in lanes)
    total_flow = sum(lane["flowVph"] for lane in lanes)
    total_density = sum(lane["densityVehPerKm"] for lane in lanes)
    lane_count = max(1, len(lanes))
    density_per_lane = total_density / lane_count
    raw_population = density_per_lane * (span_m / 1000.0) * general_lanes

    # --- 車速:用偵測器自己的跨車道速度散布,不發明係數 -------------------
    speeds = [lane["speedKph"] for lane in lanes if lane["speedKph"] > 0]
    if speeds:
        speed_lo_raw, speed_hi_raw = min(speeds), max(speeds)
    else:
        speed_lo_raw = speed_hi_raw = floor_kph
        warnings.append("偵測器所有車道速度皆為 0 或異常,車速改用下限值。")
    if len(speeds) == 1:
        warnings.append("偵測器只有一條車道有速度,速度區間退化成單一值。")
    speed_lo = clamp(speed_lo_raw, floor_kph, speed_cap_kph)
    speed_hi = clamp(speed_hi_raw, floor_kph, speed_cap_kph)
    speed_capped = speed_hi_raw > speed_cap_kph or speed_lo_raw > speed_cap_kph
    if speed_capped:
        warnings.append(
            f"量測車速上限 {speed_hi_raw:.1f} km/h 高於路口速限容許值 "
            f"{speed_cap_kph:.0f} km/h,已夾到上限;模擬流率會低於量測流率。"
        )

    # --- 車種組成 --------------------------------------------------------
    mapping = config["vehicleClassMapping"]
    small = sum(lane["classes"]["small"] for lane in lanes)
    motor = sum(lane["classes"]["motorcycle"] for lane in lanes)
    large = sum(lane["classes"]["large"] for lane in lanes)
    class_total = small + motor + large
    bicycle_share = float(mapping["bicycle"]["share"])
    split = mapping["motorcycleSplit"]
    scooter_ratio = float(split["scooter"]) / (float(split["scooter"]) + float(split["motorcycle"]))
    if class_total > 0:
        remaining = 1.0 - bicycle_share
        motor_share = remaining * motor / class_total
        mix = {
            "car": remaining * small / class_total,
            "scooter": motor_share * scooter_ratio,
            "motorcycle": motor_share * (1.0 - scooter_ratio),
            "bus": remaining * large / class_total,
            "bicycle": bicycle_share,
        }
        mix_source = "vd-class-volumes"
    else:
        mix = None
        mix_source = None
        warnings.append("偵測器沒有車種計數,車種組成沿用專案假設。")
    if mix and mix["bus"] > 0.2:
        warnings.append(
            f"大型車佔比 {mix['bus']:.0%} 全部映射成公車(模擬沒有貨車型別),"
            "已夾到 20%,否則兩條公車專用道排不下。"
        )
        excess = mix["bus"] - 0.2
        mix["bus"] = 0.2
        mix["car"] += excess

    # --- 逐車道生成權重(千分比) ----------------------------------------
    position_density: dict[str, float] = {"inner": 0.0, "middle": 0.0, "outer": 0.0}
    for lane in lanes:
        if lane["lanePosition"] in position_density:
            position_density[lane["lanePosition"]] += lane["densityVehPerKm"]
    position_total = sum(position_density.values())
    direction_split = float(config["directionSplit"]["default"])
    direction_split_source = config["directionSplit"]["defaultSource"]
    if reading.get("directionSplit") is not None:
        direction_split = float(reading["directionSplit"])
        direction_split_source = "measured"
    if position_total > 0:
        weights = {
            key: int(round(1000.0 * value / position_total))
            for key, value in position_density.items()
        }
        lane_quota = {"1": dict(weights), "-1": dict(weights)}
    else:
        lane_quota = None
        warnings.append("無法推定逐車道分佈,車道指派沿用模擬預設規則。")

    population_min = int(math.floor(raw_population))
    population_max = int(math.ceil(raw_population))
    if population_max == population_min:
        population_max = population_min + 1
    population_min = int(clamp(population_min, 0, 80))
    population_max = int(clamp(population_max, 0, 80))

    generated = now_taipei()
    observed_dt = datetime.fromisoformat(observed_at)
    age_s = int((generated - observed_dt).total_seconds())

    return {
        "schema": SCHEMA_ID,
        "generatedAt": iso(generated),
        "observedAt": observed_at,
        "ageAtGenerationS": age_s,
        "staleAfterS": stale_after_s,
        "source": source_block,
        "site": config["site"],
        "confidence": {
            "level": "corridor-proxy",
            "labelZhTw": "走廊代理值",
            "note": (
                "羅斯福路四段沒有任何車輛偵測器,全台北也沒有路口/停止線型 VD。"
                "這是 %.0f 公尺外 %s 的量測,不是路口實測值。"
                % (reading["distanceM"], reading["roadZhTw"])
            ),
        },
        "detectors": [{
            "id": reading["id"],
            "roadZhTw": reading["roadZhTw"],
            "role": reading["role"],
            "distanceM": reading["distanceM"],
            "laneCount": lane_count,
            "intervalS": reading.get("intervalS", 300),
            "status": reading.get("status", "ok"),
            "lanes": lanes,
        }],
        "measurement": {
            "volumeVehPer5Min": round(total_volume, 1),
            "flowVph": round(total_flow, 1),
            "densityVehPerKm": round(total_density, 3),
            "densityPerLaneVehPerKm": round(density_per_lane, 3),
            "speedRangeKph": [round(speed_lo_raw, 2), round(speed_hi_raw, 2)],
            "populationRaw": round(raw_population, 3),
            "formula": "q = Volume x 12 ; k = q / max(5, AvgSpeed) ; N = (k / laneCount) x (spanM/1000) x generalLanes",
        },
        "simulation": {
            "densityMode": "live",
            "mainVehicleMin": population_min,
            "mainVehicleMax": population_max,
            "pedestrianMin": None,
            "pedestrianMax": None,
            "sideVehiclesPerColumn": None,
            "speedRangeMps": [round(speed_lo / 3.6, 3), round(speed_hi / 3.6, 3)],
            "speedCapped": speed_capped,
            "mix": ({key: round(value, 4) for key, value in mix.items()} if mix else None),
            "mixSource": mix_source,
            "directionSplit": direction_split,
            "directionSplitSource": direction_split_source,
            "laneQuota": lane_quota,
            "laneQuotaUnit": "permille-weight",
            "laneQuotaMethod": config["laneMapping"]["method"],
            "laneQuotaConfidence": config["laneMapping"]["confidence"],
        },
        "pedestrians": {
            "count": None,
            "source": None,
            "note": "車輛偵測器不量行人。行人數沿用模擬預設,等 CV 影像管線(file 來源)接上才有實測值。",
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
        "degraded": False,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# 來源 1:synthetic
# ---------------------------------------------------------------------------

def build_synthetic(config: dict[str, Any]) -> dict[str, Any]:
    generated = now_taipei()
    return {
        "schema": SCHEMA_ID,
        "generatedAt": iso(generated),
        "observedAt": iso(generated),
        "ageAtGenerationS": 0,
        # 合成資料永不過期:它本來就不宣稱對應任何真實時刻。
        "staleAfterS": 0,
        "source": {
            "id": "synthetic",
            "kind": "synthetic",
            "labelZhTw": "合成模擬",
            "realtime": False,
            "origin": "traffic_simulation_core.mjs TRAFFIC_DENSITY_MODES",
            "originUrl": None,
            "note": "沒有接任何外部資料。這是 viewer 的預設行為,永遠可用。",
        },
        "site": config["site"],
        "confidence": {
            "level": "synthetic",
            "labelZhTw": "合成",
            "note": "場景中的人車數量與速度都是 seeded 亂數,不對應任何真實量測。",
        },
        "detectors": [],
        "measurement": None,
        "simulation": {
            "densityMode": "normal",
            "mainVehicleMin": None,
            "mainVehicleMax": None,
            "pedestrianMin": None,
            "pedestrianMax": None,
            "sideVehiclesPerColumn": None,
            "speedRangeMps": None,
            "speedCapped": False,
            "mix": None,
            "mixSource": None,
            "directionSplit": None,
            "directionSplitSource": None,
            "laneQuota": None,
            "laneQuotaUnit": None,
            "laneQuotaMethod": None,
            "laneQuotaConfidence": None,
        },
        "pedestrians": {"count": None, "source": None, "note": "合成模式"},
        "bus": {"arrivals": None, "source": None},
        "signal": None,
        "privacy": {
            "aggregateOnly": True, "personalData": "none",
            "faceRecognition": False, "reIdentification": False,
            "rawImagery": False,
        },
        "degraded": False,
        "warnings": [],
    }


# ---------------------------------------------------------------------------
# 來源 2:replay(凍結的 2024-11-14 臺北市 VD 快照,真實資料,無需金鑰)
# ---------------------------------------------------------------------------

def parse_frozen_snapshot(path: Path) -> tuple[str, dict[str, dict[str, Any]]]:
    root = ET.parse(path).getroot()
    raw_time = (root.findtext("ExchangeTime") or "").strip()
    # 原始格式 "2024/11/14T16:46:02" —— 非 ISO,轉成 ISO 並補上 +08:00。
    observed = raw_time.replace("/", "-")
    if "+" not in observed:
        observed = f"{observed}+08:00"
    devices: dict[str, dict[str, Any]] = {}
    for device in root.findall(".//VDDevice"):
        device_id = (device.findtext("DeviceID") or "").strip()
        if not device_id:
            continue
        lanes = []
        for lane in device.findall("LaneData"):
            def number(tag: str) -> float:
                try:
                    return float(lane.findtext(tag) or 0.0)
                except ValueError:
                    return 0.0
            lanes.append({
                "laneNo": int(number("LaneNO")),
                "volume": number("Volume"),
                "speedKph": number("AvgSpeed"),
                "occupancy": number("AvgOccupancy"),
                "classes": {
                    "small": number("Svolume"),
                    "motorcycle": number("Mvolume"),
                    "large": number("Lvolume"),
                },
            })
        devices[device_id] = {
            "intervalS": int(float(device.findtext("TimeInterval") or 5) * 60),
            "lanes": lanes,
        }
    return observed, devices


def build_replay(config: dict[str, Any], frame: int | None) -> dict[str, Any]:
    replay_config = config["replay"]
    snapshot = HERE / replay_config["snapshot"]
    observed_at, devices = parse_frozen_snapshot(snapshot)
    entries = config["detectors"]
    if frame is None:
        # 沒指定就用牆上時鐘決定 frame,連續呼叫會自己往前走。
        frame = int(time.time() // int(replay_config["frameSeconds"]))
    index = frame % len(entries)
    entry = entries[index]
    device = devices.get(entry["id"])
    if device is None:
        return degraded_state(
            config, "replay",
            f"快照裡找不到偵測器 {entry['id']}(該裝置可能已除役)。",
        )
    reading = {
        "id": entry["id"],
        "roadZhTw": entry["roadZhTw"],
        "role": entry["role"],
        "distanceM": entry["distanceM"],
        "intervalS": device["intervalS"],
        "status": "ok",
        "lanes": device["lanes"],
        "directionSplit": None,
    }
    source_block = {
        "id": "replay",
        "kind": "replay",
        "labelZhTw": "歷史快照 · 偵測器輪播",
        "realtime": False,
        "origin": "臺北市政府交通局 GetVDDATA.xml(已凍結於 2024-11-14)",
        "originUrl": "https://tcgbusfs.blob.core.windows.net/blobtisv/GetVDDATA.xml",
        "license": "臺北市政府資料開放平臺",
        "snapshotSha256": replay_config["snapshotSha256"],
        "frameKind": replay_config["frameKind"],
        "frameIndex": index,
        "frameCount": len(entries),
        "frameSeconds": replay_config["frameSeconds"],
        "note": (
            "每一個數字都是 2024-11-14 16:46 的真實量測。frame 之間的差異是"
            "**不同偵測器的空間差異**,不是時間變化 —— 臺北市從未公開 VD 時間序列。"
        ),
    }
    state = map_reading_to_state(
        reading, config, source_block, observed_at,
        # 歷史資料一定過期,staleAfterS 設 0 讓 viewer 一律標「已過期」。
        stale_after_s=0,
    )
    state["warnings"].insert(0, (
        "這是 2024-11-14 16:46 的歷史快照,不是即時資料。"
    ))
    return state


def build_replay_from_jsonl(config: dict[str, Any], path: Path,
                            frame: int | None) -> dict[str, Any]:
    """真正的時間序列重播:讀 ingest.py capture 產生的 .jsonl。"""
    lines = [line for line in path.read_text("utf-8").splitlines() if line.strip()]
    if not lines:
        return degraded_state(config, "replay", f"{path.name} 是空的。")
    if frame is None:
        frame = int(time.time() // int(config["replay"]["frameSeconds"]))
    state = json.loads(lines[frame % len(lines)])
    state["source"]["frameKind"] = "temporal"
    state["source"]["labelZhTw"] = "歷史重播"
    state["source"]["frameIndex"] = frame % len(lines)
    state["source"]["frameCount"] = len(lines)
    state["staleAfterS"] = 0
    state["generatedAt"] = iso(now_taipei())
    return state


# ---------------------------------------------------------------------------
# 來源 3:tdx(需要 san 自己註冊的金鑰;金鑰絕不進 repo)
# ---------------------------------------------------------------------------

def tdx_credentials() -> tuple[str, str] | None:
    """讀取順序:環境變數 → data/tdx_credentials.json(已列入 .gitignore)。"""
    client_id = os.environ.get("TDX_CLIENT_ID")
    client_secret = os.environ.get("TDX_CLIENT_SECRET")
    if client_id and client_secret:
        return client_id, client_secret
    local = HERE / "tdx_credentials.json"
    if local.exists():
        try:
            data = json.loads(local.read_text("utf-8"))
        except json.JSONDecodeError:
            return None
        if data.get("client_id") and data.get("client_secret"):
            return str(data["client_id"]), str(data["client_secret"])
    return None


def tdx_token(client_id: str, client_secret: str) -> str:
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }).encode()
    request = urllib.request.Request(TDX_TOKEN_URL, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())["access_token"]


def tdx_fetch(url: str, token: str, params: dict[str, str]) -> Any:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    raw = http_get(full, {
        "Authorization": f"Bearer {token}",
        "Accept-Encoding": "identity",
    }, timeout=25)
    return json.loads(raw)


def build_tdx(config: dict[str, Any], detector_id: str | None) -> dict[str, Any]:
    credentials = tdx_credentials()
    if credentials is None:
        return degraded_state(config, "tdx", (
            "找不到 TDX 金鑰。請設定環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET,"
            "或建立 data/tdx_credentials.json(已列入 .gitignore)。"
            "註冊步驟見 data/README.md —— 只有 san 本人可以註冊,agent 不得代辦。"
        ))
    try:
        token = tdx_token(*credentials)
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, TimeoutError) as error:
        return degraded_state(config, "tdx", f"TDX 換 token 失敗:{error}")

    wanted = detector_id or next(
        entry["id"] for entry in config["detectors"] if entry.get("primary")
    )
    entry = next(e for e in config["detectors"] if e["id"] == wanted)
    try:
        payload = tdx_fetch(TDX_LIVE_VD_URL, token, {
            "$filter": f"VDID eq '{wanted}'",
            "$format": "JSON",
        })
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
        return degraded_state(config, "tdx", f"TDX Live VD 取得失敗:{error}")

    lives = payload.get("VDLives") or []
    if not lives:
        return degraded_state(config, "tdx", f"TDX 沒有回傳 {wanted} 的即時資料。")
    live = lives[0]
    interval_s = int(payload.get("SrcUpdateInterval") or payload.get("UpdateInterval") or 60)
    lanes: list[dict[str, Any]] = []
    per_direction: dict[str, float] = {}
    for link in live.get("LinkFlows") or []:
        link_id = link.get("LinkID")
        for lane in link.get("Lanes") or []:
            volume = 0.0
            small = motor = large = 0.0
            for vehicle in lane.get("Vehicles") or []:
                count = float(vehicle.get("Volume") or 0)
                if count < 0:
                    continue
                volume += count
                kind = vehicle.get("VehicleType")
                if kind == "S":
                    small += count
                elif kind == "M":
                    motor += count
                else:                       # L(大車)與 T(聯結車)
                    large += count
            speed = float(lane.get("Speed") or 0)
            lanes.append({
                "laneNo": int(lane.get("LaneID") or len(lanes)),
                "linkId": link_id,
                "laneType": lane.get("LaneType"),
                # Live VD 的 Volume 是 SrcUpdateInterval 秒內的計數,
                # 換算成與凍結快照相同的「輛/5 分鐘」基準才能共用同一條公式。
                "volume": volume * (300.0 / max(1, interval_s)),
                "volumeRaw": volume,
                "volumeWindowS": interval_s,
                "speedKph": speed if speed > 0 else 0.0,
                "occupancy": float(lane.get("Occupancy") or 0),
                "errorType": lane.get("ErrorType"),
                "classes": {"small": small, "motorcycle": motor, "large": large},
            })
            per_direction[str(link_id)] = per_direction.get(str(link_id), 0.0) + volume
    if not lanes:
        return degraded_state(config, "tdx", f"{wanted} 沒有可用車道資料。")

    # 方向比例:Live VD 的 LinkFlows 是逐 LinkID(=逐方向)。兩個 link 時
    # 直接用流量比;需要靜態表的 Bearing 才知道哪個 link 是西北向,
    # 沒有對應表時保守地回 None,由 detectors.json 的 0.5 接手。
    direction_split = None
    link_map = next(
        (e.get("linkDirections") for e in config["detectors"] if e["id"] == wanted),
        None,
    )
    if link_map and len(per_direction) >= 2:
        northwest = sum(v for k, v in per_direction.items() if link_map.get(k) == 1)
        total = sum(per_direction.values())
        if total > 0:
            direction_split = northwest / total

    observed_at = live.get("DataCollectTime") or payload.get("SrcUpdateTime") \
        or iso(now_taipei())
    reading = {
        "id": wanted,
        "roadZhTw": entry["roadZhTw"],
        "role": entry["role"],
        "distanceM": entry["distanceM"],
        "intervalS": interval_s,
        "status": {0: "ok", 1: "comm-error", 2: "disabled", 3: "fault"}.get(
            int(live.get("Status") or 0), "unknown"),
        "lanes": lanes,
        "directionSplit": direction_split,
    }
    source_block = {
        "id": "tdx",
        "kind": "tdx",
        "labelZhTw": "TDX 即時 VD",
        "realtime": True,
        "origin": "交通部 TDX 運輸資料流通服務平臺 Live VD",
        "originUrl": TDX_LIVE_VD_URL,
        "license": "TDX 服務條款(需註冊金鑰)",
        "updateIntervalS": interval_s,
        "note": "以 san 自己申請的 client_credentials 金鑰認證取得,金鑰不進 repo。",
    }
    return map_reading_to_state(
        reading, config, source_block, observed_at,
        stale_after_s=max(180, interval_s * 3),
    )


def refresh_detectors(config: dict[str, Any]) -> int:
    """用金鑰重新拉 TDX 靜態 VD 表,補上精確經緯度與 DetectionLinks。"""
    credentials = tdx_credentials()
    if credentials is None:
        print("需要 TDX 金鑰才能重新整理偵測器表;見 data/README.md", file=sys.stderr)
        return 2
    token = tdx_token(*credentials)
    payload = tdx_fetch(TDX_STATIC_VD_URL, token, {"$top": "3000", "$format": "JSON"})
    by_id = {row["VDID"]: row for row in payload.get("VDs", [])}
    for entry in config["detectors"]:
        row = by_id.get(entry["id"])
        if not row:
            print(f"  {entry['id']}: 靜態表查無此裝置(可能已除役)")
            continue
        entry["lat"] = row.get("PositionLat")
        entry["lon"] = row.get("PositionLon")
        entry["roadZhTwFromTdx"] = row.get("RoadName")
        entry["detectionType"] = row.get("DetectionType")
        entry["links"] = [{
            "linkId": link.get("LinkID"),
            "bearing": link.get("Bearing"),
            "roadDirection": link.get("RoadDirection"),
            "laneNum": link.get("LaneNum"),
        } for link in row.get("DetectionLinks") or []]
        print(f"  {entry['id']}: {entry['lat']},{entry['lon']} "
              f"{entry['roadZhTwFromTdx']} links={len(entry['links'])}")
    (HERE / "detectors.json").write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print("已更新 data/detectors.json(請自行檢查 linkDirections 對應)")
    return 0


# ---------------------------------------------------------------------------
# 來源 4:file / url
# ---------------------------------------------------------------------------

def build_from_file(config: dict[str, Any], location: str) -> dict[str, Any]:
    try:
        if location.startswith(("http://", "https://")):
            raw = http_get(location).decode("utf-8")
        else:
            raw = Path(location).read_text("utf-8")
        payload = json.loads(raw)
    except (OSError, ValueError, urllib.error.URLError, TimeoutError) as error:
        return degraded_state(config, "file", f"讀取 {location} 失敗:{error}")

    problems = validate_state(payload)
    if problems:
        return degraded_state(
            config, "file",
            f"{location} 不符合 {SCHEMA_ID}:" + "；".join(problems[:3]),
        )
    payload.setdefault("source", {})
    payload["source"].setdefault("id", "file")
    payload["source"]["kind"] = "file"
    payload["source"].setdefault("labelZhTw", "外部檔案 / URL")
    payload["source"]["originUrl"] = location
    payload["generatedAt"] = iso(now_taipei())
    return payload


# ---------------------------------------------------------------------------
# 退場與驗證
# ---------------------------------------------------------------------------

def degraded_state(config: dict[str, Any], source_id: str,
                   reason: str) -> dict[str, Any]:
    """任何一步失敗都回這個 —— 合法 JSON、degraded=true,viewer 會自動退回
    synthetic。絕不拋錯、絕不讓場景空掉(硬規則 2)。"""
    state = build_synthetic(config)
    state["source"]["id"] = source_id
    state["source"]["kind"] = source_id
    state["source"]["labelZhTw"] = f"{source_id}(無資料)"
    state["confidence"] = {
        "level": "unavailable",
        "labelZhTw": "無資料",
        "note": reason,
    }
    state["degraded"] = True
    state["warnings"] = [reason]
    return state


REQUIRED_TOP_LEVEL = (
    "schema", "generatedAt", "observedAt", "staleAfterS",
    "source", "site", "confidence", "simulation", "privacy",
)


def validate_state(payload: Any) -> list[str]:
    problems: list[str] = []
    if not isinstance(payload, dict):
        return ["最外層不是 JSON 物件"]
    if payload.get("schema") != SCHEMA_ID:
        problems.append(f"schema 必須是 {SCHEMA_ID}(收到 {payload.get('schema')!r})")
    for key in REQUIRED_TOP_LEVEL:
        if key not in payload:
            problems.append(f"缺少必要欄位 {key}")
    for key in ("generatedAt", "observedAt"):
        value = payload.get(key)
        if isinstance(value, str):
            try:
                datetime.fromisoformat(value)
            except ValueError:
                problems.append(f"{key} 不是 ISO-8601:{value!r}")
    simulation = payload.get("simulation")
    if isinstance(simulation, dict):
        low = simulation.get("mainVehicleMin")
        high = simulation.get("mainVehicleMax")
        if low is not None and high is not None and low > high:
            problems.append("simulation.mainVehicleMin > mainVehicleMax")
        mix = simulation.get("mix")
        if isinstance(mix, dict):
            total = sum(float(v) for v in mix.values())
            if abs(total - 1.0) > 0.02:
                problems.append(f"simulation.mix 總和 {total:.3f} 不等於 1")
            unknown = set(mix) - {"car", "scooter", "motorcycle", "bus", "bicycle"}
            if unknown:
                problems.append(f"simulation.mix 有未知車種 {sorted(unknown)}")
        quota = simulation.get("laneQuota")
        if quota is not None:
            if set(quota) - {"1", "-1"}:
                problems.append("simulation.laneQuota 的 key 只能是 '1' / '-1'")
            for value in quota.values():
                if set(value) - {"inner", "middle", "outer"}:
                    problems.append("laneQuota 車道位置只能是 inner/middle/outer")
    elif simulation is not None:
        problems.append("simulation 必須是物件或 null")
    # 隱私守門走 data/privacy.py 的兩層(正規化黑名單 + SCHEMA 白名單)。
    # 原本這裡是一份 13 個 key 的大小寫敏感精確比對,名字卻叫「白名單」——
    # boxes / xyxy / track_id / crop 全部漏過,見 §27。
    problems.extend(privacy_problems(payload, strict=True))
    return problems


# ---------------------------------------------------------------------------
# capture:把真實的時間序列一筆一筆附加成 .jsonl
# ---------------------------------------------------------------------------

def capture(config: dict[str, Any], source: str, out: Path,
            interval_s: int, count: int) -> int:
    # 自我餵食防呆:replay 會優先讀 snapshots/captured.jsonl,拿它當 capture
    # 的輸出等於一邊讀一邊往同一個檔追加,只會把同一筆複製 N 次。
    if source == "replay" and out.resolve() == (HERE / "snapshots" / "captured.jsonl").resolve():
        print("capture 不能用 --source replay 寫進 snapshots/captured.jsonl"
              "(replay 會讀那個檔,等於自我餵食)。請用 --source tdx。",
              file=sys.stderr)
        return 2
    out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    for index in range(count):
        state = build_state(config, source, argparse.Namespace(
            frame=None, detector=None, input=None,
        ))
        with out.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(state, ensure_ascii=False) + "\n")
        written += 1
        observed = state.get("observedAt")
        print(f"[{index + 1}/{count}] {observed} "
              f"degraded={state['degraded']} -> {out}")
        if index + 1 < count:
            time.sleep(interval_s)
    return 0 if written else 1


# ---------------------------------------------------------------------------
# 測試素材(mujoco/verify_data_sources.mjs 用)
# ---------------------------------------------------------------------------

def write_test_probes(config: dict[str, Any]) -> int:
    """產生 CDP 驗收需要的固定素材。全部是真實資料的衍生物,不含假造量測。"""
    out_dir = HERE / "examples"
    out_dir.mkdir(parents=True, exist_ok=True)

    def dump(name: str, payload: dict[str, Any]) -> None:
        (out_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
        print(f"  {name}")

    # 一份「此刻剛量到」的 feed:內容沿用 CV 管線範例(真實形狀),
    # 只把時間戳改成現在 —— 用來驗證「沒過期就不可以標成過期」。
    fresh = json.loads((out_dir / "cv_pipeline_example.json").read_text("utf-8"))
    fresh.pop("$comment", None)
    now = now_taipei()
    fresh["observedAt"] = iso(now)
    fresh["generatedAt"] = iso(now)
    fresh["ageAtGenerationS"] = 0
    fresh["staleAfterS"] = 3600
    fresh["source"]["labelZhTw"] = "新鮮度對照組"
    dump("fresh_probe.json", fresh)

    # 合法 JSON、但 schema 欄位不對 —— viewer 必須整份拒收。
    bad = dict(fresh)
    bad["schema"] = "not.the.right.schema.v9"
    dump("bad_schema_probe.json", bad)
    print(f"寫到 {out_dir}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_state(config: dict[str, Any], source: str,
                args: argparse.Namespace) -> dict[str, Any]:
    try:
        if source == "synthetic":
            return build_synthetic(config)
        if source == "replay":
            jsonl = HERE / "snapshots" / "captured.jsonl"
            if jsonl.exists():
                return build_replay_from_jsonl(config, jsonl, args.frame)
            return build_replay(config, args.frame)
        if source == "tdx":
            return build_tdx(config, args.detector)
        if source == "file":
            if not args.input:
                return degraded_state(config, "file", "file 來源需要 --input <路徑或 URL>")
            return build_from_file(config, args.input)
        return degraded_state(config, source, f"未知的來源 {source!r}")
    except Exception as error:                        # noqa: BLE001
        # 最後一道防線:ingest 絕不能因為任何例外而不產出檔案。
        return degraded_state(config, source, f"{type(error).__name__}: {error}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--source", default="replay",
                        choices=["synthetic", "replay", "tdx", "file"])
    parser.add_argument("--out", default=None,
                        help="輸出路徑(預設印到 stdout)")
    parser.add_argument("--frame", type=int, default=None,
                        help="replay 的 frame 編號(預設依牆上時鐘自動前進)")
    parser.add_argument("--detector", default=None, help="tdx:指定 VDID")
    parser.add_argument("--input", default=None, help="file:JSON 路徑或 URL")
    parser.add_argument("--validate", default=None,
                        help="只驗證一份既有 JSON,不抓資料")
    parser.add_argument("--refresh-detectors", action="store_true",
                        help="用 TDX 金鑰重新拉靜態 VD 表補上經緯度")
    parser.add_argument("--serve-loop", action="store_true",
                        help="持續依 --interval 重寫 --out")
    parser.add_argument("--capture", default=None,
                        help="把時間序列附加成 .jsonl(給 replay 用)")
    parser.add_argument("--interval", type=int, default=20)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--all", action="store_true",
                        help="一次寫出 data/live/{synthetic,replay,tdx}.json")
    parser.add_argument("--test-probes", action="store_true",
                        help="產生 mujoco/verify_data_sources.mjs 用的測試素材")
    args = parser.parse_args(argv)

    config = load_config()

    if args.validate:
        payload = json.loads(Path(args.validate).read_text("utf-8"))
        problems = validate_state(payload)
        if problems:
            print(f"FAIL {args.validate}: {len(problems)} 個問題")
            for problem in problems:
                print("  -", problem)
            return 1
        print(f"PASS {args.validate} 符合 {SCHEMA_ID}")
        return 0

    if args.refresh_detectors:
        return refresh_detectors(config)

    if args.capture:
        return capture(config, args.source, Path(args.capture),
                       args.interval, args.count)

    def emit(state: dict[str, Any], out: Path | None) -> None:
        text = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
        if out is None:
            sys.stdout.write(text)
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(out.suffix + ".tmp")
        tmp.write_text(text, "utf-8")
        tmp.replace(out)                 # 原子替換,viewer 不會讀到半份檔

    if args.test_probes:
        return write_test_probes(config)

    if args.all:
        for source in ("synthetic", "replay", "tdx"):
            state = build_state(config, source, args)
            emit(state, HERE / "live" / f"{source}.json")
            print(f"{source}: degraded={state['degraded']} "
                  f"{state['confidence']['labelZhTw']} "
                  f"{state['simulation']['mainVehicleMin']}"
                  f"-{state['simulation']['mainVehicleMax']} 輛")
        return 0

    out = Path(args.out) if args.out else None
    if args.serve_loop:
        if out is None:
            print("--serve-loop 需要 --out", file=sys.stderr)
            return 2
        print(f"每 {args.interval} 秒寫一次 {out}(Ctrl-C 結束)")
        try:
            while True:
                emit(build_state(config, args.source, args), out)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            return 0
    emit(build_state(config, args.source, args), out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
