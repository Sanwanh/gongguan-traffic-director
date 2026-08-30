"""地面單應性(homography):像素 → 模擬座標 (s, t)。

一個平面到另一個平面的投影只需要 4 個對應點,但**4 個點在工程上是不夠的**。
實測(300 次擾動試驗、209 個評估點):

| 校正點          | 點擊雜訊 σ=1px 的中位誤差 | p95     |
|-----------------|--------------------------:|--------:|
| 4 點、集中一處  | 0.116 m                   | 1.039 m |
| 8 點、散開兩帶  | 0.037 m                   | 0.121 m |

差 3 倍;有鏡頭徑向畸變(k1=−0.10,一般廣角監視器等級)時差 3~4 倍。
所以這裡的預設要求是 **≥6 點、跨兩條以上的畫線帶**,並且一定要跑
Monte-Carlo 抖動自檢。

**為什麼不能只看殘差或條件數**(兩者都實測會漏掉真正危險的校正):
- 對應關係全對、只是基線縮短(兩條斑馬線由相距 25.10 m 靠到 0.92 m):
  條件數幾乎不動(8.3 → 8.1),σ=1px 的中位誤差卻暴增 20.6 倍。
- 4 個點沒有冗餘,殘差恆為 0,單點對錯完全查不出來。
只有「對點擊位置加雜訊、重解、看關注區域的誤差」這招擋得住。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np

CALIB_SCHEMA = "gongguan.vision.calibration.v1"
TAIPEI = timezone(timedelta(hours=8))

# 閘門門檻。全部可在 solve() 覆寫,但預設值有實測依據(見模組 docstring)。
MIN_POINTS = 6
COND_LIMIT = 100.0            # σ_max / σ_倒數第二
RESIDUAL_RATIO_LIMIT = 4.0    # max/median,N≥8 才有意義
# 絕對殘差上限。一條斑馬線白漆約 0.5 m 寬,單一校正點的殘差超過 0.30 m 幾乎
# 一定是「點到隔壁那條」。實測比值門檻對這種錯不夠敏感(8 個散開的點、其中
# 一點挪 1.2 m,最小平方會把誤差攤掉,比值只有 2.5),所以要再加這一道。
RESIDUAL_MAX_LIMIT_M = 0.30
MC_SIGMA_PX = 1.0
MC_TRIALS = 200
MC_P95_LIMIT_M = 0.5


def _normalise(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    centre = points.mean(0)
    spread = np.sqrt(((points - centre) ** 2).sum(1)).mean()
    scale = math.sqrt(2.0) / max(spread, 1e-12)
    matrix = np.array([[scale, 0.0, -scale * centre[0]],
                       [0.0, scale, -scale * centre[1]],
                       [0.0, 0.0, 1.0]])
    return matrix, (points - centre) * scale


def solve_h(pixels: Sequence[Sequence[float]],
            ground: Sequence[Sequence[float]]) -> np.ndarray:
    """normalized DLT 最小平方解,回傳 3x3 的 H(像素 → (s, t))。"""
    px = np.asarray(pixels, dtype=float).reshape(-1, 2)
    gd = np.asarray(ground, dtype=float).reshape(-1, 2)
    if len(px) != len(gd):
        raise ValueError("像素點與地面點數量不一致")
    if len(px) < 4:
        raise ValueError("homography 至少需要 4 個對應點")
    t_px, a = _normalise(px)
    t_gd, b = _normalise(gd)
    rows = []
    for (u, v), (x, y) in zip(a, b):
        rows.append([-u, -v, -1, 0, 0, 0, x * u, x * v, x])
        rows.append([0, 0, 0, -u, -v, -1, y * u, y * v, y])
    _, _, vt = np.linalg.svd(np.asarray(rows))
    return np.linalg.inv(t_gd) @ vt[-1].reshape(3, 3) @ t_px


def dlt_singular_values(pixels: Sequence[Sequence[float]],
                        ground: Sequence[Sequence[float]]) -> np.ndarray:
    px = np.asarray(pixels, dtype=float).reshape(-1, 2)
    gd = np.asarray(ground, dtype=float).reshape(-1, 2)
    _, a = _normalise(px)
    _, b = _normalise(gd)
    rows = []
    for (u, v), (x, y) in zip(a, b):
        rows.append([-u, -v, -1, 0, 0, 0, x * u, x * v, x])
        rows.append([0, 0, 0, -u, -v, -1, y * u, y * v, y])
    return np.linalg.svd(np.asarray(rows), compute_uv=False)


def apply_h(h: np.ndarray, pixels: Sequence[Sequence[float]]) -> np.ndarray:
    """把像素點投影成 (s, t)。回傳 (N, 2)。"""
    px = np.asarray(pixels, dtype=float).reshape(-1, 2)
    homo = np.hstack([px, np.ones((len(px), 1))]) @ np.asarray(h, dtype=float).T
    denom = homo[:, 2:3]
    denom = np.where(np.abs(denom) < 1e-12, np.nan, denom)
    return homo[:, :2] / denom


def _dp_dv(h: np.ndarray, u: float, v: float) -> np.ndarray | None:
    """∂(s,t)/∂v 的解析解(不是差分 —— 投影是非線性的,1 px 差分會差幾度)。

    P(u,v) = (h1·x / h3·x, h2·x / h3·x),x = (u, v, 1)
    ⇒ ∂P/∂v = (h1[1]·d − n1·h3[1], h2[1]·d − n2·h3[1]) / d²
    """
    matrix = np.asarray(h, dtype=float)
    x = np.array([u, v, 1.0])
    n1, n2, d = matrix @ x
    if not np.isfinite(d) or abs(d) < 1e-12:
        return None
    return np.array([matrix[0, 1] * d - n1 * matrix[2, 1],
                     matrix[1, 1] * d - n2 * matrix[2, 1]]) / (d * d)


def pencil_point(h: np.ndarray) -> tuple[np.ndarray, bool]:
    """影像上所有「垂直線」(u 固定)在地面上會聚到的那個點 C。

    影像的垂直線全部通過影像無窮遠點 (0, 1, 0),所以 C = H·(0,1,0),
    也就是 H 的第二個直行。回傳 ((s, t), 是否為有限點)。
    """
    column = np.asarray(h, dtype=float)[:, 1]
    if abs(column[2]) < 1e-12:
        return column[:2], False           # C 在無窮遠 → 整個 pencil 是平行線
    return column[:2] / column[2], True


def away_direction(h: np.ndarray, pixel: Sequence[float]) -> np.ndarray | None:
    """框底邊偏差要修正的方向,在地面上的單位向量。**不需要相機外參。**

    幾何依據:影像上「u 固定、v 改變」的那條線,在地面上是通過
    C = H·(0,1,0) 的一條直線(見 `pencil_point`)。而 2D 框的底邊就是這個
    物體在影像上 **v 最大** 的那一列 —— 也就是物體footprint 上最靠近 C 的
    那個點。所以「框底邊 vs 物體中心」的偏差,**恰好**沿著 ∂P/∂v 這個方向,
    這個方向是解析可得、誤差為零的。

    注意:這**不完全等於**「相機的方位角方向」。真正的相機正下方點(nadir)
    要靠鉛垂消失點才求得到,而鉛垂消失點無法只從地面單應性推出來。實測兩者
    差 3° 左右 —— 對 1 公尺級的修正量而言,橫向殘差只有幾公分。而且要修的
    本來就是框底邊的偏差,所以這個 pencil 方向才是對的那一個。

    正負號由「每像素幾公尺」決定:越遠的地方單位像素涵蓋的距離越大,所以
    |∂P/∂v| 較大的那一側就是遠端。這樣連相機上下顛倒都不會反。
    """
    u, v = float(pixel[0]), float(pixel[1])
    delta = _dp_dv(h, u, v)
    if delta is None:
        return None
    norm = float(np.hypot(delta[0], delta[1]))
    if not np.isfinite(norm) or norm < 1e-12:
        return None
    unit = delta / norm
    near = _dp_dv(h, u, v + 1.0)
    far = _dp_dv(h, u, v - 1.0)
    if near is None or far is None:
        return -unit                      # 退回「影像往上就是往遠處」的常見情況
    # 往 v 減少的方向如果單位像素涵蓋更多公尺,那一側就是遠端。
    return -unit if np.linalg.norm(far) > np.linalg.norm(near) else unit


def residuals_m(h: np.ndarray, pixels: Sequence[Sequence[float]],
                ground: Sequence[Sequence[float]]) -> np.ndarray:
    projected = apply_h(h, pixels)
    truth = np.asarray(ground, dtype=float).reshape(-1, 2)
    return np.hypot(projected[:, 0] - truth[:, 0], projected[:, 1] - truth[:, 1])


def roi_probe_points(h: np.ndarray, width: int, height: int, roi: dict[str, Any],
                     step: int = 60) -> np.ndarray:
    """在畫面上撒一張網格,只留投影後落在 ROI 內的像素點。

    Monte-Carlo 自檢要量的是「**我關心的區域**的不確定度」,不是校正點自己的
    殘差 —— 後者永遠會很小,那正是它騙人的地方。
    """
    us = np.arange(step // 2, width, step)
    vs = np.arange(step // 2, height, step)
    grid = np.array([(u, v) for v in vs for u in us], dtype=float)
    projected = apply_h(h, grid)
    inside = (
        np.isfinite(projected).all(1)
        & (projected[:, 0] >= float(roi["sMin"])) & (projected[:, 0] <= float(roi["sMax"]))
        & (projected[:, 1] >= float(roi["tMin"])) & (projected[:, 1] <= float(roi["tMax"]))
    )
    return grid[inside]


def monte_carlo(pixels: Sequence[Sequence[float]], ground: Sequence[Sequence[float]],
                probes: np.ndarray, sigma_px: float = MC_SIGMA_PX,
                trials: int = MC_TRIALS, seed: int = 20260831) -> dict[str, Any]:
    """對點擊位置加高斯雜訊重解 H,回報關注區域的 (s,t) 不確定度。"""
    px = np.asarray(pixels, dtype=float).reshape(-1, 2)
    gd = np.asarray(ground, dtype=float).reshape(-1, 2)
    if len(probes) == 0:
        return {"sigmaPx": sigma_px, "trials": 0, "probes": 0,
                "p50M": None, "p95M": None, "maxM": None,
                "note": "ROI 內沒有可用的探測點,無法自檢"}
    base = apply_h(solve_h(px, gd), probes)
    rng = np.random.default_rng(seed)
    errors: list[float] = []
    for _ in range(trials):
        jittered = px + rng.normal(0.0, sigma_px, px.shape)
        try:
            moved = apply_h(solve_h(jittered, gd), probes)
        except (np.linalg.LinAlgError, ValueError):
            continue
        delta = np.hypot(moved[:, 0] - base[:, 0], moved[:, 1] - base[:, 1])
        errors.extend(float(x) for x in delta[np.isfinite(delta)])
    if not errors:
        return {"sigmaPx": sigma_px, "trials": trials, "probes": int(len(probes)),
                "p50M": None, "p95M": None, "maxM": None, "note": "全部重解都失敗"}
    arr = np.asarray(errors)
    return {
        "sigmaPx": sigma_px,
        "trials": trials,
        "probes": int(len(probes)),
        "p50M": round(float(np.percentile(arr, 50)), 4),
        "p95M": round(float(np.percentile(arr, 95)), 4),
        "maxM": round(float(arr.max()), 4),
    }


@dataclass
class Calibration:
    """一台攝影機的校正結果。"""

    id: str
    h: np.ndarray
    width: int
    height: int
    points: list[dict[str, Any]] = field(default_factory=list)
    roi: dict[str, Any] = field(default_factory=dict)
    quality: dict[str, Any] = field(default_factory=dict)
    radial_correction_m: dict[str, float] = field(default_factory=dict)
    created_at: str = ""
    note: str = ""

    def project(self, pixels: Sequence[Sequence[float]]) -> np.ndarray:
        return apply_h(self.h, pixels)

    def to_json(self) -> dict[str, Any]:
        return {
            "schema": CALIB_SCHEMA,
            "id": self.id,
            "createdAt": self.created_at or datetime.now(TAIPEI).isoformat(timespec="seconds"),
            "frame": {"width": self.width, "height": self.height},
            "H": [[float(x) for x in row] for row in np.asarray(self.h)],
            "HMapsTo": "simulation (s, t) in metres",
            "points": self.points,
            "roi": self.roi,
            "quality": self.quality,
            "radialCorrectionM": self.radial_correction_m,
            "note": self.note,
            "privacy": {
                "storesImagery": False,
                "note": "校正檔只有像素座標與地面座標,沒有任何影像資料。",
            },
        }

    def save(self, path: str | Path) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
        return target

    @classmethod
    def load(cls, path: str | Path) -> "Calibration":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        if payload.get("schema") != CALIB_SCHEMA:
            raise ValueError(f"校正檔 schema 不符:{payload.get('schema')!r}")
        frame = payload.get("frame", {})
        return cls(
            id=str(payload.get("id", "camera")),
            h=np.asarray(payload["H"], dtype=float),
            width=int(frame.get("width", 0)),
            height=int(frame.get("height", 0)),
            points=list(payload.get("points", [])),
            roi=dict(payload.get("roi", {})),
            quality=dict(payload.get("quality", {})),
            radial_correction_m={k: float(v) for k, v
                                 in (payload.get("radialCorrectionM") or {}).items()},
            created_at=str(payload.get("createdAt", "")),
            note=str(payload.get("note", "")),
        )


def solve(camera_id: str, points: Sequence[dict[str, Any]], width: int, height: int,
          roi: dict[str, Any], *, mc_sigma_px: float = MC_SIGMA_PX,
          mc_trials: int = MC_TRIALS, min_points: int = MIN_POINTS,
          note: str = "") -> Calibration:
    """解 H 並跑三道閘門。`points` 每筆是 {"px": [u, v], "s": …, "t": …, "label": …}。"""
    pixels = [(float(p["px"][0]), float(p["px"][1])) for p in points]
    ground = [(float(p["s"]), float(p["t"])) for p in points]
    h = solve_h(pixels, ground)

    singular = dlt_singular_values(pixels, ground)
    cond = float(singular[0] / max(singular[-2], 1e-300)) if len(singular) >= 2 else float("inf")

    res = residuals_m(h, pixels, ground)
    res_median = float(np.median(res))
    res_max = float(res.max())
    res_ratio = res_max / max(res_median, 1e-9)

    probes = roi_probe_points(h, width, height, roi)
    mc = monte_carlo(pixels, ground, probes, mc_sigma_px, mc_trials)

    gates: dict[str, str] = {}
    reasons: list[str] = []

    gates["count"] = "pass" if len(points) >= min_points else "fail"
    if gates["count"] == "fail":
        reasons.append(f"校正點只有 {len(points)} 個,少於建議的 {min_points} 個。"
                       "4 點沒有冗餘,單點對錯查不出來。")

    gates["cond"] = "pass" if cond <= COND_LIMIT else "fail"
    if gates["cond"] == "fail":
        reasons.append(f"DLT 條件數 {cond:.3g} 超過 {COND_LIMIT:.0f}"
                       "(通常是點重複、共線,或秩虧)。")

    if len(points) >= 8:
        bad_ratio = res_ratio > RESIDUAL_RATIO_LIMIT
        bad_absolute = res_max > RESIDUAL_MAX_LIMIT_M
        gates["residualRatio"] = "warn" if (bad_ratio or bad_absolute) else "pass"
        if gates["residualRatio"] == "warn":
            worst = int(np.argmax(res))
            reasons.append(
                f"第 {worst} 個校正點的殘差 {res_max:.3f} m"
                f"(中位數的 {res_ratio:.1f} 倍)—— 很可能對到隔壁那條白漆,請重點。")
    else:
        gates["residualRatio"] = "skip"

    p95 = mc.get("p95M")
    if p95 is None:
        gates["monteCarlo"] = "fail"
        reasons.append("Monte-Carlo 自檢無法執行(ROI 內沒有探測點,"
                       "很可能 ROI 設在畫面外或 H 是退化解)。")
    elif p95 <= MC_P95_LIMIT_M:
        gates["monteCarlo"] = "pass"
    else:
        gates["monteCarlo"] = "fail"
        reasons.append(
            f"點擊雜訊 σ={mc_sigma_px:.0f}px 時,ROI 內位置不確定度 p95 = {p95:.2f} m,"
            f"超過 {MC_P95_LIMIT_M:.1f} m。請再多點幾個、而且點得更散"
            "(跨不同的白漆帶、涵蓋畫面近端與遠端)。")

    if "fail" in gates.values():
        verdict = "fail"
    elif "warn" in gates.values():
        verdict = "warn"
    else:
        verdict = "pass"

    quality = {
        "pointCount": len(points),
        "cond": round(cond, 4) if math.isfinite(cond) else None,
        "condLimit": COND_LIMIT,
        "residualM": {"median": round(res_median, 5), "max": round(res_max, 5),
                      "ratio": round(res_ratio, 3),
                      "ratioLimit": RESIDUAL_RATIO_LIMIT,
                      "maxLimitM": RESIDUAL_MAX_LIMIT_M},
        "monteCarlo": mc,
        "monteCarloLimitM": MC_P95_LIMIT_M,
        "gates": gates,
        "verdict": verdict,
        "reasons": reasons,
        "method": "normalized-DLT-least-squares",
    }
    return Calibration(
        id=camera_id, h=h, width=width, height=height,
        points=[{"px": [float(p["px"][0]), float(p["px"][1])],
                 "s": float(p["s"]), "t": float(p["t"]),
                 "label": str(p.get("label", "")),
                 "residualM": round(float(r), 5)}
                for p, r in zip(points, res)],
        roi=roi, quality=quality, note=note,
        created_at=datetime.now(TAIPEI).isoformat(timespec="seconds"),
    )
