#!/usr/bin/env python3
"""校正 CLI:在一張影像上標地面對應點 → 解 homography → 存成設定檔。

## 流程(可重複執行,每一步都是獨立子指令)

    # 0. 一次性:把場景裡每條白漆的真實 (s, t) 抓成目錄(需要 viewer 在跑)
    node dump_marks.mjs

    # 1. 看看有哪些可用的地面標記
    python calibrate.py marks --band straight-crosswalk

    # 2. 產生一份待填的點位檔
    python calibrate.py template --camera cam-se --frame 1920x1080 \
        --out calib/cam-se.points.json

    # 3. 在影像上點座標。兩種方式:
    #    (a) 開 calibrate.html(純本機、零 CDN),載入你的影像、點、匯出 JSON
    #    (b) 直接用任何看圖軟體讀出像素座標,手動填進 template 的 px 欄位
    #    地面座標 **不要手打**,用 --mark 指定白漆名稱與角落即可。

    # 4. 解 H + 跑三道閘門 + 存檔
    python calibrate.py solve --points calib/cam-se.points.json \
        --out calib/cam-se.json

    # 5. 隨時回頭檢查
    python calibrate.py inspect --calib calib/cam-se.json

## 三道閘門(缺一不可)

1. **點數 ≥ 6 且跨兩條以上的畫線帶** —— 4 點沒有冗餘,單點對錯查不出來。
2. **DLT 條件數 ≤ 100** —— 擋重複點、共線、秩虧。
3. **Monte-Carlo 抖動自檢:σ=1px 時 ROI 內 p95 ≤ 0.5 m** —— 這是唯一擋得住
   「對應全對但基線太短」的守門員(實測那種情況條件數幾乎不動,誤差卻漲 20 倍)。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import scene                                          # noqa: E402
from homography import Calibration, solve             # noqa: E402

DEFAULT_MARKS = HERE / "calib" / "marks_catalog.json"


def load_marks(path: Path | None = None) -> dict[str, Any]:
    target = path or DEFAULT_MARKS
    if not target.exists():
        raise SystemExit(
            f"找不到地面標記目錄 {target}。\n"
            "先讓 serve.py 跑起來,然後執行:node dump_marks.mjs")
    payload = json.loads(target.read_text(encoding="utf-8"))
    if payload.get("schema") != "gongguan.vision.marks.v1":
        raise SystemExit(f"標記目錄 schema 不符:{payload.get('schema')!r}")
    return payload


def find_mark(catalog: dict[str, Any], name: str) -> dict[str, Any]:
    exact = [m for m in catalog["marks"] if m["name"] == name]
    if exact:
        return exact[0]
    partial = [m for m in catalog["marks"] if name in m["name"]]
    if len(partial) == 1:
        return partial[0]
    if not partial:
        raise SystemExit(f"目錄裡找不到標記 {name!r}。用 `calibrate.py marks` 看清單。")
    raise SystemExit(f"標記名稱 {name!r} 對到 {len(partial)} 筆,請寫完整:"
                     + ", ".join(m["name"] for m in partial[:6]))


def mark_corner(mark: dict[str, Any], corner: str) -> tuple[float, float]:
    for entry in mark["corners"]:
        if entry["corner"] == corner:
            return float(entry["s"]), float(entry["t"])
    raise SystemExit(f"{mark['name']} 沒有角落 {corner!r};"
                     "可用:sMin,tMin / sMax,tMin / sMax,tMax / sMin,tMax")


def resolve_points(raw_points: list[dict[str, Any]],
                   catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """把 {"mark": …, "corner": …, "px": [u, v]} 展開成含 s/t 的完整點位。"""
    out: list[dict[str, Any]] = []
    for index, point in enumerate(raw_points):
        px = point.get("px")
        if not (isinstance(px, (list, tuple)) and len(px) == 2
                and all(isinstance(v, (int, float)) for v in px)):
            raise SystemExit(f"第 {index} 個點還沒填 px(影像上的像素座標)。")
        if "mark" in point and point["mark"]:
            mark = find_mark(catalog, str(point["mark"]))
            s, t = mark_corner(mark, str(point.get("corner", "sMin,tMin")))
            label = f"{mark['name']} [{point.get('corner')}]"
        elif "s" in point and "t" in point:
            s, t = float(point["s"]), float(point["t"])
            label = str(point.get("label", "手動輸入"))
        else:
            raise SystemExit(f"第 {index} 個點既沒有 mark 也沒有 s/t。")
        out.append({"px": [float(px[0]), float(px[1])], "s": s, "t": t,
                    "label": label, "band": point.get("band")})
    return out


def cmd_marks(args: argparse.Namespace) -> int:
    catalog = load_marks(Path(args.catalog) if args.catalog else None)
    marks = catalog["marks"]
    if args.band:
        marks = [m for m in marks if m["band"] == args.band]
    print(f"目錄:{catalog['source']}")
    print(f"帶別統計:{catalog['bands']}")
    print(f"{'名稱':52s} {'帶別':22s} {'s 範圍':>18s} {'t 範圍':>18s}")
    for mark in marks[: args.limit]:
        print(f"{mark['name']:52s} {mark['band']:22s} "
              f"{mark['sMin']:8.2f}..{mark['sMax']:7.2f} "
              f"{mark['tMin']:8.2f}..{mark['tMax']:7.2f}")
    if len(marks) > args.limit:
        print(f"… 還有 {len(marks) - args.limit} 筆(用 --limit 調整)")
    return 0


def cmd_template(args: argparse.Namespace) -> int:
    catalog = load_marks(Path(args.catalog) if args.catalog else None)
    width, height = (int(v) for v in args.frame.lower().split("x"))
    # 預設挑兩條相距很遠的畫線帶,示範「點要散開」這件事。
    straight = [m for m in catalog["marks"] if m["band"] == "straight-crosswalk"]
    staggered = [m for m in catalog["marks"] if m["band"] == "staggered-crosswalk"]
    picks: list[dict[str, Any]] = []
    for band_marks, band in ((straight, "straight-crosswalk"),
                             (staggered, "staggered-crosswalk")):
        if not band_marks:
            continue
        chosen = [band_marks[0], band_marks[len(band_marks) // 2], band_marks[-1]]
        for mark in chosen:
            for corner in ("sMin,tMin", "sMax,tMax"):
                picks.append({"mark": mark["name"], "corner": corner, "band": band,
                              "px": None})
    payload = {
        "schema": "gongguan.vision.points.v1",
        "camera": args.camera,
        "frame": {"width": width, "height": height},
        "roi": scene.default_roi(),
        "howTo": [
            "1. 在你的影像上找到 mark 指的那條白漆的那個角落。",
            "2. 把該點的像素座標填進 px:[u, v](左上角是 0,0)。",
            "3. 用不到的點整筆刪掉;點不夠就照樣式再加,但至少要 6 個、"
            "而且要跨兩條以上的 band。",
            "4. s/t 不要手打 —— 由 mark + corner 自動從場景取真值。",
            "5. roi 要改成攝影機**實際看得到**的範圍,否則車數會被錯誤外推。",
        ],
        "points": picks[: args.count],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已寫出 {out}({len(payload['points'])} 個待填點位)")
    print("下一步:開 calibrate.html 在影像上點,或直接編輯這個檔把 px 填進去。")
    return 0


def cmd_from_truth(args: argparse.Namespace) -> int:
    """從自我驗證迴圈的合成真值檔產生點位檔(示範 / 回歸測試用)。

    真實攝影機沒有這一步 —— 真實流程是人在影像上點。這個子指令的用途是:
    (1) 讓 `run_pipeline.py` 有一份可跑的校正檔可以示範與回歸;
    (2) 證明「點法」本身(跨帶 + 散開 + 8 點)確實能過三道閘門。
    """
    import numpy as np                                          # noqa: PLC0415

    truth = json.loads(Path(args.truth).read_text(encoding="utf-8"))
    width, height = int(truth["width"]), int(truth["height"])
    pool = []
    for group, band in ((truth["stripes"], "straight-crosswalk"),
                        (truth["other"], "other-marking")):
        for mark in group:
            for corner in mark["corners"]:
                px = corner["px"]
                if 0 <= px[0] < width and 0 <= px[1] < height:
                    pool.append({"px": [px[0], px[1]], "s": corner["s"], "t": corner["t"],
                                 "band": band, "label": mark["name"]})
    if len(pool) < 4:
        raise SystemExit(f"這張影格只有 {len(pool)} 個可用角點")

    # 與 verify_pipeline.pick_calibration_points 同一套策略:先取跨帶最遠的一對,
    # 再用最遠點取樣把點撐開。
    bands = {p["band"] for p in pool}
    coords = np.array([p["px"] for p in pool], dtype=float)
    best, best_gap = (0, 1), -1.0
    for i in range(len(pool)):
        for j in range(i + 1, len(pool)):
            if len(bands) > 1 and pool[i]["band"] == pool[j]["band"]:
                continue
            gap = float(np.hypot(*(coords[i] - coords[j])))
            if gap > best_gap:
                best, best_gap = (i, j), gap
    chosen = list(best)
    while len(chosen) < min(args.count, len(pool)):
        rest = [i for i in range(len(pool)) if i not in chosen]
        gaps = [min(float(np.hypot(*(coords[i] - coords[j]))) for j in chosen) for i in rest]
        chosen.append(rest[int(np.argmax(gaps))])

    rng = np.random.default_rng(args.seed)
    points = []
    for index in chosen:
        point = dict(pool[index])
        if args.sigma > 0:
            noise = rng.normal(0.0, args.sigma, 2)
            point["px"] = [point["px"][0] + float(noise[0]), point["px"][1] + float(noise[1])]
        points.append(point)

    ss = [p["s"] for p in points]
    ts = [p["t"] for p in points]
    t_min = max(min(ts), scene.ROADWAY_T_MIN)
    t_max = min(max(ts), scene.ROADWAY_T_MAX)
    lanes = [lane for lane in scene.MAIN_ROOSEVELT_LANES if t_min <= lane["t"] <= t_max]
    payload = {
        "schema": "gongguan.vision.points.v1",
        "camera": args.camera or f"synthetic-{truth.get('tag', 'frame')}",
        "frame": {"width": width, "height": height},
        "roi": {"id": "visible", "sMin": min(ss), "sMax": max(ss),
                "tMin": t_min, "tMax": t_max, "lanes": max(1, len(lanes)),
                "note": "校正點在地面上的包絡 ∩ 車道帶。"},
        "note": (f"由合成真值 {Path(args.truth).name} 產生,點擊雜訊 σ={args.sigma}px。"
                 "真實攝影機請改用 calibrate.html 或手填 template。"),
        "points": points,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已寫出 {out}({len(points)} 個點,跨 {len(set(p['band'] for p in points))} 條帶)")
    return 0


def cmd_solve(args: argparse.Namespace) -> int:
    payload = json.loads(Path(args.points).read_text(encoding="utf-8"))
    if payload.get("schema") != "gongguan.vision.points.v1":
        raise SystemExit(f"點位檔 schema 不符:{payload.get('schema')!r}")
    catalog = load_marks(Path(args.catalog) if args.catalog else None)
    raw = [p for p in payload.get("points", []) if p.get("px")]
    if len(raw) < 4:
        raise SystemExit(f"只有 {len(raw)} 個點填了 px,homography 至少要 4 個。")
    points = resolve_points(raw, catalog)
    frame = payload.get("frame", {})
    width = int(args.width or frame.get("width", 0))
    height = int(args.height or frame.get("height", 0))
    if not (width and height):
        raise SystemExit("需要影像尺寸:點位檔的 frame 或 --width/--height。")
    roi = payload.get("roi") or scene.default_roi()

    calib = solve(payload.get("camera", args.camera or "camera"), points, width, height, roi,
                  mc_sigma_px=args.sigma, mc_trials=args.trials,
                  min_points=args.min_points, note=payload.get("note", ""))
    report(calib)
    bands = {p.get("band") for p in points if p.get("band")}
    if len(bands) < 2:
        print("  ! 所有校正點都在同一條畫線帶上。實測基線縮短會讓誤差暴增 20 倍,"
              "而條件數完全不會警告 —— 請跨帶再點幾個。")
    if calib.quality["verdict"] == "fail" and not args.force:
        print("\n閘門未通過,沒有寫出校正檔。修好點位再跑一次,"
              "或加 --force 強制寫出(輸出的 JSON 會標 verdict=fail)。")
        return 2
    out = Path(args.out)
    calib.save(out)
    print(f"\n已寫出 {out}")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    calib = Calibration.load(args.calib)
    report(calib)
    return 0 if calib.quality.get("verdict") != "fail" else 2


def report(calib: Calibration) -> None:
    quality = calib.quality
    mc = quality.get("monteCarlo", {})
    print(f"攝影機 {calib.id}  影像 {calib.width}x{calib.height}  "
          f"校正點 {quality.get('pointCount')} 個")
    print(f"  ROI  s {calib.roi.get('sMin')}..{calib.roi.get('sMax')}  "
          f"t {calib.roi.get('tMin')}..{calib.roi.get('tMax')}  "
          f"lanes={calib.roi.get('lanes')}")
    print(f"  閘門 1 點數        {quality['gates'].get('count'):5s} "
          f"({quality.get('pointCount')} 個)")
    print(f"  閘門 2 條件數      {quality['gates'].get('cond'):5s} "
          f"(cond={quality.get('cond')}, 上限 {quality.get('condLimit')})")
    print(f"  閘門 3 抖動自檢    {quality['gates'].get('monteCarlo'):5s} "
          f"(σ={mc.get('sigmaPx')}px, {mc.get('trials')} 次, "
          f"ROI 探測點 {mc.get('probes')} 個 → p50={mc.get('p50M')} m "
          f"p95={mc.get('p95M')} m, 上限 {quality.get('monteCarloLimitM')} m)")
    print(f"  參考 殘差比值      {quality['gates'].get('residualRatio'):5s} "
          f"(median={quality['residualM']['median']} m, "
          f"max={quality['residualM']['max']} m, ratio={quality['residualM']['ratio']})")
    print(f"  結論 verdict = {quality.get('verdict')}")
    for reason in quality.get("reasons", []):
        print(f"    - {reason}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", default=None, help="地面標記目錄(預設 calib/marks_catalog.json)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_marks = sub.add_parser("marks", help="列出可用的地面標記")
    p_marks.add_argument("--band", default=None)
    p_marks.add_argument("--limit", type=int, default=40)
    p_marks.set_defaults(func=cmd_marks)

    p_tpl = sub.add_parser("template", help="產生待填的點位檔")
    p_tpl.add_argument("--camera", default="camera")
    p_tpl.add_argument("--frame", default="1920x1080")
    p_tpl.add_argument("--count", type=int, default=12)
    p_tpl.add_argument("--out", required=True)
    p_tpl.set_defaults(func=cmd_template)

    p_solve = sub.add_parser("solve", help="解 H、跑閘門、存校正檔")
    p_solve.add_argument("--points", required=True)
    p_solve.add_argument("--out", required=True)
    p_solve.add_argument("--camera", default=None)
    p_solve.add_argument("--width", type=int, default=None)
    p_solve.add_argument("--height", type=int, default=None)
    p_solve.add_argument("--sigma", type=float, default=1.0, help="Monte-Carlo 點擊雜訊 σ(像素)")
    p_solve.add_argument("--trials", type=int, default=200)
    p_solve.add_argument("--min-points", type=int, default=6)
    p_solve.add_argument("--force", action="store_true", help="閘門沒過也寫出")
    p_solve.set_defaults(func=cmd_solve)

    p_truth = sub.add_parser("from-truth", help="從合成真值檔產生點位檔(示範 / 回歸用)")
    p_truth.add_argument("--truth", required=True)
    p_truth.add_argument("--out", required=True)
    p_truth.add_argument("--camera", default=None)
    p_truth.add_argument("--count", type=int, default=8)
    p_truth.add_argument("--sigma", type=float, default=1.0)
    p_truth.add_argument("--seed", type=int, default=20260831)
    p_truth.set_defaults(func=cmd_from_truth)

    p_inspect = sub.add_parser("inspect", help="檢查既有校正檔")
    p_inspect.add_argument("--calib", required=True)
    p_inspect.set_defaults(func=cmd_inspect)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
