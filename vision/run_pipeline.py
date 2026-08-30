#!/usr/bin/env python3
"""影像 → 聚合 JSON 的正式入口。

    # 單張影像(自己的截圖、或 ffmpeg 抽出來的一格)
    python run_pipeline.py --calib calib/cam-se.json --image /tmp/frame.png \
        --out ../data/live/custom.json

    # 影片檔或 HLS 串流,抽 5 格取平均
    python run_pipeline.py --calib calib/cam-se.json \
        --stream https://hls.bote.gov.taipei/stream/171/index.m3u8 \
        --frames 5 --out ../data/live/custom.json

    # 常駐:每 30 秒重抽一次,原子寫檔。viewer 的 §24 資料層直接輪詢這個檔。
    python run_pipeline.py --calib calib/cam-se.json --stream <url> \
        --frames 5 --loop --interval 30 --out ../data/live/custom.json

    # macOS 本機攝影機(裝置編號用 ffmpeg -f avfoundation -list_devices true -i "" 查)
    python run_pipeline.py --calib calib/cam-se.json --device 0 --out ...

## 隱私(硬規則 3,可稽核)

* 影格只存在這個行程的記憶體中。ffmpeg 用 pipe 把 rawvideo 餵進 stdin,
  **不落地**。
* 這支程式**只會**寫一個檔:`--out` 指定的 JSON(先寫 `.tmp` 再 rename)。
  所有寫檔都走 `write_state()` 這一個出口。
* 偵測框在 `aggregate.project_detections()` 投影成 (s, t) 之後立刻丟棄,
  不進任何回傳值。輸出前 `assert_privacy_clean()` 會遞迴掃過整份 JSON。
* 不做人臉、不做跨幀身分追蹤、不配發任何 id。每一格都是獨立的位置快照。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from aggregate import aggregate_frames, degraded_state, project_detections  # noqa: E402
from detector import Detector                                               # noqa: E402
from homography import Calibration                                          # noqa: E402
from models_registry import DEFAULT_MODEL                                   # noqa: E402

TAIPEI = timezone(timedelta(hours=8))


# --------------------------------------------------------------------------
# 影格取得 —— 全部走記憶體,沒有任何一條路徑會把影像寫到磁碟
# --------------------------------------------------------------------------

def frames_from_image(path: str | Path, size: tuple[int, int]) -> Iterator[Image.Image]:
    with Image.open(path) as image:
        yield image.convert("RGB").resize(size, Image.BILINEAR)


def frames_from_ffmpeg(source: str, size: tuple[int, int], count: int,
                       fps: float, input_args: list[str],
                       timeout_s: int = 60) -> Iterator[Image.Image]:
    """用 ffmpeg 抽格,rawvideo 走 pipe。**不寫任何檔案。**"""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("找不到 ffmpeg。macOS:brew install ffmpeg")
    width, height = size
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        *input_args, "-i", source,
        "-frames:v", str(count),
        "-vf", f"fps={fps},scale={width}:{height}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = width * height * 3
    try:
        for _ in range(count):
            buffer = process.stdout.read(frame_bytes)
            if not buffer or len(buffer) < frame_bytes:
                break
            yield Image.frombytes("RGB", size, buffer)
    finally:
        process.stdout.close()
        try:
            process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            process.kill()
        stderr = process.stderr.read().decode("utf-8", "replace").strip()
        process.stderr.close()
        if stderr:
            print(f"[ffmpeg] {stderr}", file=sys.stderr)


def acquire(args: argparse.Namespace, size: tuple[int, int]) -> list[Image.Image]:
    if args.image:
        return list(frames_from_image(args.image, size))
    if args.video:
        return list(frames_from_ffmpeg(args.video, size, args.frames, args.fps, []))
    if args.stream:
        return list(frames_from_ffmpeg(
            args.stream, size, args.frames, args.fps,
            ["-rw_timeout", "8000000", "-user_agent", "gongguan-vision/1.0"]))
    if args.device is not None:
        return list(frames_from_ffmpeg(
            str(args.device), size, args.frames, args.fps,
            ["-f", "avfoundation", "-framerate", "30"]))
    raise SystemExit("要指定影像來源:--image / --video / --stream / --device")


# --------------------------------------------------------------------------
# 輸出 —— 這是整支程式唯一的寫檔出口
# --------------------------------------------------------------------------

def write_state(state: dict[str, Any], out: Path) -> None:
    """原子寫檔:先寫 .tmp 再 rename,viewer 永遠不會讀到寫到一半的 JSON。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, out)


def run_once(detector: Detector, calib: Calibration, args: argparse.Namespace) -> dict[str, Any]:
    size = (calib.width, calib.height)
    if not all(size):
        return degraded_state("校正檔沒有記錄影像尺寸,無法縮放輸入影格。", args.source_id)
    try:
        images = acquire(args, size)
    except Exception as error:                                    # noqa: BLE001
        return degraded_state(f"取不到影格:{error}", args.source_id)
    if not images:
        return degraded_state("影像來源沒有回傳任何影格(串流可能已中斷)。", args.source_id)

    observed = datetime.now(TAIPEI)
    per_frame: list[list[dict[str, Any]]] = []
    for image in images:
        detections = detector.detect_image(image, conf=args.conf)
        per_frame.append(project_detections(detections, calib, calib.radial_correction_m))
        del detections
    del images                                # 影格到此為止,不再被引用

    state = aggregate_frames(
        per_frame, calib, detector_info=detector.describe(),
        observed_at=observed, stale_after_s=args.stale_after,
        source_id=args.source_id or f"cv-{calib.id}")
    if args.source_label:
        state["source"]["labelZhTw"] = args.source_label
    state["source"]["updateIntervalS"] = args.interval if args.loop else None
    return state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--calib", required=True, help="calibrate.py solve 產生的校正檔")
    parser.add_argument("--out", required=True, help="輸出 JSON 的路徑")
    source = parser.add_argument_group("影像來源(擇一)")
    source.add_argument("--image", default=None)
    source.add_argument("--video", default=None)
    source.add_argument("--stream", default=None, help="HLS / RTSP / 任何 ffmpeg 吃得下的 URL")
    source.add_argument("--device", type=int, default=None, help="macOS avfoundation 裝置編號")
    parser.add_argument("--frames", type=int, default=5, help="每輪抽幾格取平均")
    parser.add_argument("--fps", type=float, default=1.0, help="抽格頻率")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--conf", type=float, default=0.10)
    parser.add_argument("--providers", nargs="*", default=None)
    parser.add_argument("--loop", action="store_true", help="常駐,每 --interval 秒跑一輪")
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--stale-after", type=int, default=120,
                        help="viewer 超過這個秒數就把資料標成過期")
    parser.add_argument("--source-id", default=None)
    parser.add_argument("--source-label", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    out = Path(args.out)
    try:
        calib = Calibration.load(args.calib)
    except Exception as error:                                    # noqa: BLE001
        write_state(degraded_state(f"校正檔讀不進來:{error}", args.source_id or "cv"), out)
        print(f"校正檔讀不進來:{error}", file=sys.stderr)
        return 1
    if calib.quality.get("verdict") == "fail" and not args.quiet:
        print("! 這份校正檔的閘門沒過(verdict=fail),位置會不準。"
              "先跑 calibrate.py inspect 看原因。", file=sys.stderr)

    try:
        detector = Detector(args.model, providers=args.providers, conf=args.conf)
    except Exception as error:                                    # noqa: BLE001
        write_state(degraded_state(f"偵測模型載不起來:{error}", args.source_id or "cv"), out)
        print(f"偵測模型載不起來:{error}", file=sys.stderr)
        return 1

    while True:
        started = time.monotonic()
        try:
            state = run_once(detector, calib, args)
        except Exception as error:                                # noqa: BLE001
            # 任何未預期的例外都退化成合法 JSON,絕不讓 viewer 的場景空掉(硬規則 2)。
            state = degraded_state(f"管線例外:{type(error).__name__}: {error}",
                                   args.source_id or "cv")
        write_state(state, out)
        if not args.quiet:
            simulation = state.get("simulation") or {}
            measurement = state.get("measurement") or {}
            print(f"{state['observedAt']}  車 {measurement.get('vehiclesInRoi', '—')} "
                  f"→ 場景 [{simulation.get('mainVehicleMin')}, "
                  f"{simulation.get('mainVehicleMax')}]  "
                  f"行人 {(state.get('pedestrians') or {}).get('count')}  "
                  f"{'DEGRADED' if state.get('degraded') else 'ok'}  "
                  f"→ {out}")
            for warning in state.get("warnings", [])[:3]:
                print(f"    ! {warning}")
        if not args.loop:
            return 0
        time.sleep(max(1.0, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    sys.exit(main())
