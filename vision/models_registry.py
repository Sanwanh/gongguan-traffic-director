"""模型登錄表 —— 來源 URL + 版本 + 授權 + SHA256(比照 viewer/models/ASSETS.md)。

**授權硬規則**:viewer repo 是 MIT,所以這裡只收 Apache-2.0 / MIT / BSD。
ultralytics 系列(YOLOv5/v8/v10/v11)是 AGPL-3.0、YOLOv9 是 GPL-3.0,
連「只拿 ONNX 權重」都不行(onnx-community/yolov10n 的 cardData 仍標
agpl-3.0)。它們一律不在這張表上,理由寫在 README「授權」一節。

權重檔本身不進版控(見 .gitignore),用 `python fetch_model.py` 下載,
下載後一律驗 SHA256,不符就刪檔並非零離開。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

MODELS_DIR = Path(__file__).resolve().parent / "models"

YOLOX_RELEASE = (
    "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0"
)

REGISTRY: dict[str, dict[str, Any]] = {
    "yolox_tiny": {
        "file": "yolox_tiny.onnx",
        "url": f"{YOLOX_RELEASE}/yolox_tiny.onnx",
        "sha256": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
        "bytes": 20219662,
        "license": "Apache-2.0",
        "licenseUrl": "https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE",
        "project": "Megvii-BaseDetection/YOLOX",
        "version": "0.1.1rc0",
        "inputSize": 416,
        "note": "最省電。畫面小、物件大時夠用;遠端小機車會掉。",
    },
    "yolox_s": {
        "file": "yolox_s.onnx",
        "url": f"{YOLOX_RELEASE}/yolox_s.onnx",
        "sha256": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
        "bytes": 35858002,
        "license": "Apache-2.0",
        "licenseUrl": "https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE",
        "project": "Megvii-BaseDetection/YOLOX",
        "version": "0.1.1rc0",
        "inputSize": 640,
        "note": "預設。M4 + CoreML 實測 19.4 ms / 51.5 fps。",
    },
    "yolox_m": {
        "file": "yolox_m.onnx",
        "url": f"{YOLOX_RELEASE}/yolox_m.onnx",
        "sha256": "21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f",
        "bytes": 101259744,
        "license": "Apache-2.0",
        "licenseUrl": "https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE",
        "project": "Megvii-BaseDetection/YOLOX",
        "version": "0.1.1rc0",
        "inputSize": 640,
        "note": "召回較高、較慢。離線 replay 或高精度校驗時用。",
    },
}

DEFAULT_MODEL = "yolox_s"


def model_path(name: str) -> Path:
    if name not in REGISTRY:
        raise KeyError(f"未登錄的模型 {name!r};可用:{sorted(REGISTRY)}")
    return MODELS_DIR / REGISTRY[name]["file"]
