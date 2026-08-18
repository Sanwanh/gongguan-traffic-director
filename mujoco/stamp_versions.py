#!/usr/bin/env python3
"""Idempotent cache-busting stamper for the viewer (SPEC_VIEWER_V2 section 1b).

Rewrites ``?v=<sha256[:8]>`` query strings onto app resources referenced by
``viewer/traffic_director.html`` and ``viewer/traffic_director.js``:

* in traffic_director.js: the traffic_simulation_core.mjs import, the rules
  JSON URL and the three GLB URLs;
* in traffic_director.html: the stylesheet, the app module script and the
  vendored three.module.js importmap entry.

The JS file is stamped first so the HTML picks up the hash of the stamped
JS. Re-running is a no-op when nothing changed. Never touches ``.orig`` or
``.v1`` backups.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
VIEWER = PACKAGE_ROOT / "viewer"


def sha8(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def stamp_references(host: Path, references: dict[str, Path]) -> bool:
    text = host.read_text(encoding="utf-8")
    original = text
    for url, target in references.items():
        digest = sha8(target)
        pattern = re.compile(re.escape(url) + r'(?:\?v=[A-Za-z0-9]+)?(?=")')
        text, count = pattern.subn(f"{url}?v={digest}", text)
        if count == 0:
            raise SystemExit(f"{host.name}: reference not found: {url}")
        print(f"  {url} -> ?v={digest} ({count}x)")
    changed = text != original
    if changed:
        host.write_text(text, encoding="utf-8")
    print(f"  {'wrote' if changed else 'unchanged'} {host.relative_to(PACKAGE_ROOT)}")
    return changed


def main() -> int:
    js_references = {
        "./traffic_simulation_core.mjs": VIEWER / "traffic_simulation_core.mjs",
        "./traffic_params.mjs": VIEWER / "traffic_params.mjs",
        "../traffic_rules/taiwan_traffic_director_rules.json":
            PACKAGE_ROOT / "traffic_rules"
            / "taiwan_traffic_director_rules.json",
        "models/gongguan_v54_environment.glb":
            VIEWER / "models" / "gongguan_v54_environment.glb",
        "models/kbot_traffic_director.glb":
            VIEWER / "models" / "kbot_traffic_director.glb",
        "models/gongguan_v54_signal_aspects.glb":
            VIEWER / "models" / "gongguan_v54_signal_aspects.glb",
        "models/pedestrian_walker.glb":
            VIEWER / "models" / "pedestrian_walker.glb",
    }
    html_references = {
        "traffic_director.css": VIEWER / "traffic_director.css",
        "traffic_director.js": VIEWER / "traffic_director.js",
        "./vendor/three.module.js": VIEWER / "vendor" / "three.module.js",
    }
    print("[stamp] viewer/traffic_director.js")
    stamp_references(VIEWER / "traffic_director.js", js_references)
    print("[stamp] viewer/traffic_director.html")
    stamp_references(VIEWER / "traffic_director.html", html_references)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
