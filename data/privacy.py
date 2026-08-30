"""§27 隱私守門(data/ 與 vision/ 共用的唯一一份)。

背景:先前 SPEC / README / 交付報告都寫「遞迴白名單守門」,但實作是一份
13 個 key 的**大小寫敏感精確比對黑名單**。驗收實測 reId / track_id /
bounding_box / boxes / xyxy / crop / frameJpeg / detections:[{x1,y1,x2,y2}]
全部通過,連 {"totallyFine":123} 都通過 —— 它從來就不是白名單。而且
boxes / xyxy 正好是 YOLO 生態最常見的輸出鍵名,漏得最不該漏。

這個模組提供兩層:
  第一層 正規化黑名單 —— 鍵名轉小寫、去掉 _ - . 空白之後比對,涵蓋常見別名。
                        任何 payload 都要過。
  第二層 真白名單     —— 只允許 SCHEMA.md 定義的鍵。state payload 走這層。

兩層都過才算乾淨。
"""
from __future__ import annotations

from typing import Any, Iterable

__all__ = [
    "normalize_key", "DENY_NORMALIZED", "STATE_ALLOWED_KEYS",
    "privacy_problems", "assert_privacy_clean",
]


def normalize_key(key: str) -> str:
    """小寫並去掉分隔符,讓 track_id / trackId / Track-ID 收斂成同一個字。"""
    return "".join(ch for ch in str(key).lower() if ch.isalnum())


# 個體識別 / 原始影像 / 偵測框 的別名總表(已正規化)。
DENY_NORMALIZED = frozenset(normalize_key(k) for k in {
    # 身分與追蹤
    "trackId", "trackIds", "tracks", "track", "personId", "personIds",
    "objectId", "globalId", "reid", "reIdVector", "reIdentificationVector",
    "identity", "identities",
    # 生物特徵 / 描述子
    "embedding", "embeddings", "descriptor", "descriptors",
    "feature", "features", "featureVector", "signature",
    "face", "faces", "faceCrop", "landmark", "landmarks",
    "keypoint", "keypoints", "pose", "poses", "skeleton",
    # 車牌
    "plate", "plates", "licensePlate", "plateNumber", "plateText",
    # 原始影像與裁切
    "image", "images", "imageUrl", "imageData", "imageBase64",
    "frame", "frames", "frameJpeg", "framePng", "frameData",
    "jpeg", "jpg", "png", "base64", "thumbnail", "snapshot",
    "crop", "crops", "patch", "patches", "roiImage",
    # 偵測框(YOLO 生態最常見的輸出鍵)
    "bbox", "bboxes", "boundingBox", "boundingBoxes", "box", "boxes",
    "xyxy", "xywh", "cxcywh", "ltrb", "rect", "rects",
    "detection", "detections", "mask", "masks", "segmentation",
})

# SCHEMA.md 定義的鍵(state payload 唯一允許出現的集合)。
# 來源:data/examples/fresh_probe.json 與 data/live/*.json 的實際鍵集合,
# 加上 schema 允許但範例可能沒出現的可選鍵。新增欄位時要同步這裡 ——
# 這是刻意的,白名單就是要「新欄位必須有人明確放行」。
STATE_ALLOWED_KEYS = frozenset({
    "$comment", "schema", "version", "generatedAt", "observedAt",
    "ageAtGenerationS", "staleAfterS", "updateIntervalS", "intervalS",
    "source", "origin", "originUrl", "kind", "id", "note", "warnings",
    "status", "degraded", "realtime", "confidence", "level", "license",
    "site", "lat", "lon", "roadZhTw", "labelZhTw", "distanceM", "role",
    "detectors", "lanes", "laneNo", "laneCount", "lanePosition",
    "volume", "volumeVehPer5Min", "volumeNote", "occupancy",
    "speedKph", "speedRangeKph", "speedRangeMps", "speedCapped",
    "flowVph", "densityVehPerKm", "densityPerLaneVehPerKm",
    "queueLenM", "queueMethod", "queueConfidence",
    "classes", "small", "large", "mix", "mixSource",
    "car", "scooter", "motorcycle", "bus", "bicycle", "person",
    "pedestrians", "pedestriansInRoi", "estimatedPedestrians",
    "count", "presentCount", "arrivals",
    "directionSplit", "directionSplitSource", "estimatedDirectionSplit",
    "movement", "direction", "nw", "se", "inner", "middle", "outer",
    "roosevelt_sw", "roosevelt_northwest", "lane90",
    "signal", "phases", "cycleS", "greenS",
    "simulation", "densityMode", "mainVehicleMin", "mainVehicleMax",
    "pedestrianMin", "pedestrianMax", "sideVehiclesPerColumn",
    "laneQuota", "laneQuotaMethod", "laneQuotaUnit", "laneQuotaConfidence",
    "measurement", "formula", "populationRaw", "positionConfidence",
    "privacy", "aggregateOnly", "rawImagery", "faceRecognition",
    "reIdentification", "personalData",
    "vision", "detector", "model", "calibration", "calibrationId",
    "sMin", "sMax", "tMin", "tMax", "roi", "sha256",
    "1", "-1",
})


def _walk(node: Any, path: str, out: list[str],
          allowed: frozenset[str] | None) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else key
            norm = normalize_key(key)
            if norm in DENY_NORMALIZED:
                out.append(
                    f"禁止欄位 {here}(正規化為 {norm!r};個體識別/原始影像/偵測框)"
                )
            elif allowed is not None and key not in allowed:
                out.append(
                    f"未在 SCHEMA.md 白名單內的欄位 {here} —— "
                    "新增欄位必須先加進 STATE_ALLOWED_KEYS"
                )
            _walk(value, here, out, allowed)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            _walk(item, f"{path}[{index}]", out, allowed)


def privacy_problems(payload: Any, *, strict: bool = True) -> list[str]:
    """回傳問題清單。strict=True 才套用白名單(state payload 用)。"""
    problems: list[str] = []
    _walk(payload, "", problems, STATE_ALLOWED_KEYS if strict else None)
    return problems


def assert_privacy_clean(payload: Any, *, strict: bool = True) -> None:
    problems = privacy_problems(payload, strict=strict)
    if problems:
        raise ValueError("隱私守門攔截:\n  " + "\n  ".join(problems))
