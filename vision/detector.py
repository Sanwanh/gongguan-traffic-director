"""YOLOX-s(Apache-2.0)+ onnxruntime(MIT)物件偵測。

只留這六類:person / bicycle / car / motorcycle / bus / truck。

**信任邊界**:這個模組是唯一看得到影像的地方。它吐出的 `Detection` 只在
行程記憶體中存在,`aggregate.py` 把它投影成 (s, t) 之後就丟掉。
`Detection` 沒有也不會有 `__dict__` 以外的序列化路徑 —— 全套管線裡沒有
任何一行把框寫進 JSON(`aggregate.py` 有一支 assert 守這件事)。

YOLOX 官方 ONNX 的前處理與常見的 YOLO 不同,三件事錯任何一件都會靜默地
少抓一半物件:
  1. letterbox 到 640(補值 114),**不是**直接 resize;
  2. 通道順序是 **BGR**;
  3. **不除 255、不做 mean/std**。
後處理要自己解 grid:(xy + grid) * stride、exp(wh) * stride,再自己做 NMS。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import onnxruntime as ort
from PIL import Image

from models_registry import DEFAULT_MODEL, REGISTRY, model_path

# COCO 索引 → 我們要的類別。其餘一律丟棄(不是過濾顯示,是根本不輸出)。
KEEP_CLASSES: dict[int, str] = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

VEHICLE_CLASSES = frozenset({"bicycle", "car", "motorcycle", "bus", "truck"})
PERSON_CLASSES = frozenset({"person"})

# YOLOX 的分數是 obj_conf × cls_conf,系統性低於 RT-DETR 的 sigmoid(logit)。
# 拿 RT-DETR 慣用的 0.30 去套 YOLOX 會誤判它很爛(實測同一張圖 0.30 只得
# 8 台車,0.10 得 19 台,與 RT-DETR@0.30 打平)。所以預設工作點是 0.10。
DEFAULT_CONF = 0.10
DEFAULT_NMS_IOU = 0.55


@dataclass(frozen=True, slots=True)
class Detection:
    """單一偵測框。**只在記憶體中存在,絕不序列化。**"""

    cls: str
    score: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def foot(self) -> tuple[float, float]:
        """框底邊中點 —— 近似「觸地點」,是投影到地面唯一合理的取樣點。"""
        return ((self.x1 + self.x2) / 2.0, self.y2)

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1


def _letterbox(image: Image.Image, size: int) -> tuple[np.ndarray, float]:
    width, height = image.size
    ratio = min(size / width, size / height)
    new_w, new_h = int(width * ratio), int(height * ratio)
    canvas = np.full((size, size, 3), 114, np.uint8)
    canvas[:new_h, :new_w] = np.asarray(image.resize((new_w, new_h), Image.BILINEAR))
    tensor = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32)  # RGB→BGR
    return np.ascontiguousarray(tensor), ratio


def _grid_and_strides(size: int) -> tuple[np.ndarray, np.ndarray]:
    grids, strides = [], []
    for stride in (8, 16, 32):
        n = size // stride
        gy, gx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        grids.append(np.stack([gx, gy], 2).reshape(-1, 2))
        strides.append(np.full((n * n, 1), stride))
    return np.concatenate(grids), np.concatenate(strides)


def nms(dets: Sequence[Detection], iou_threshold: float = DEFAULT_NMS_IOU) -> list[Detection]:
    """逐類別 greedy NMS。"""
    ordered = sorted(dets, key=lambda d: -d.score)
    keep: list[Detection] = []
    for candidate in ordered:
        drop = False
        for kept in keep:
            if kept.cls != candidate.cls:
                continue
            x1 = max(candidate.x1, kept.x1)
            y1 = max(candidate.y1, kept.y1)
            x2 = min(candidate.x2, kept.x2)
            y2 = min(candidate.y2, kept.y2)
            inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            union = (candidate.width * candidate.height
                     + kept.width * kept.height - inter)
            if inter / max(union, 1e-9) > iou_threshold:
                drop = True
                break
        if not drop:
            keep.append(candidate)
    return keep


class Detector:
    """封裝一個 ONNX session。建立一次、重複 run。"""

    def __init__(self, model: str = DEFAULT_MODEL, providers: Iterable[str] | None = None,
                 conf: float = DEFAULT_CONF, nms_iou: float = DEFAULT_NMS_IOU) -> None:
        if model not in REGISTRY:
            raise KeyError(f"未登錄的模型 {model!r}")
        path: Path = model_path(model)
        if not path.exists():
            raise FileNotFoundError(
                f"找不到權重 {path}。先跑:python fetch_model.py --model {model}")
        self.name = model
        self.entry = REGISTRY[model]
        self.size = int(self.entry["inputSize"])
        self.conf = float(conf)
        self.nms_iou = float(nms_iou)
        options = ort.SessionOptions()
        options.log_severity_level = 3
        wanted = list(providers) if providers else self._auto_providers()
        available = set(ort.get_available_providers())
        self.providers = [p for p in wanted if p in available] or ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(str(path), options, providers=self.providers)
        self.input_name = self.session.get_inputs()[0].name
        self._grid, self._stride = _grid_and_strides(self.size)
        self.last_infer_ms = 0.0

    @staticmethod
    def _auto_providers() -> list[str]:
        # CoreML 對 YOLOX 是實測 3.6 倍加速(70.4 ms → 19.4 ms);對 transformer
        # 型偵測器反而會變慢,所以這個選擇綁在 YOLOX 這個架構上,不是通則。
        return ["CoreMLExecutionProvider", "CPUExecutionProvider"]

    def detect_image(self, image: Image.Image, conf: float | None = None) -> list[Detection]:
        tensor, ratio = _letterbox(image.convert("RGB"), self.size)
        started = time.perf_counter()
        outputs = self.session.run(None, {self.input_name: tensor})
        self.last_infer_ms = (time.perf_counter() - started) * 1000.0
        return self._decode(outputs, ratio, self.conf if conf is None else float(conf))

    def detect_path(self, path: str | Path, conf: float | None = None) -> list[Detection]:
        with Image.open(path) as image:
            return self.detect_image(image, conf)

    def _decode(self, outputs: list[np.ndarray], ratio: float, conf: float) -> list[Detection]:
        raw = outputs[0][0].astype(np.float32, copy=True)      # (8400, 85)
        raw[:, :2] = (raw[:, :2] + self._grid) * self._stride
        raw[:, 2:4] = np.exp(raw[:, 2:4]) * self._stride
        scores = raw[:, 4:5] * raw[:, 5:]
        cls_index = scores.argmax(1)
        best = scores.max(1)
        picked: list[Detection] = []
        for i in np.where(best >= conf)[0]:
            label = KEEP_CLASSES.get(int(cls_index[i]))
            if label is None:
                continue
            cx, cy, bw, bh = raw[i, :4] / ratio
            picked.append(Detection(label, float(best[i]),
                                    float(cx - bw / 2), float(cy - bh / 2),
                                    float(cx + bw / 2), float(cy + bh / 2)))
        return nms(picked, self.nms_iou)

    def describe(self) -> dict[str, Any]:
        return {
            "model": self.name,
            "project": self.entry["project"],
            "version": self.entry["version"],
            "license": self.entry["license"],
            "sha256": self.entry["sha256"],
            "inputSize": self.size,
            "providers": list(self.providers),
            "confThreshold": self.conf,
            "nmsIou": self.nms_iou,
            "classes": sorted(set(KEEP_CLASSES.values())),
        }
