#!/usr/bin/env python3
"""下載偵測模型權重並驗 SHA256。權重不進版控。

    python fetch_model.py                 # 下載預設(yolox_s)
    python fetch_model.py --all
    python fetch_model.py --model yolox_m
    python fetch_model.py --check         # 只驗現有檔案,不下載

只用標準函式庫,不需要 venv 就能跑。
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.error
import urllib.request

from models_registry import DEFAULT_MODEL, MODELS_DIR, REGISTRY, model_path

CHUNK = 1 << 20


def sha256_of(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def check(name: str) -> bool:
    entry = REGISTRY[name]
    path = model_path(name)
    if not path.exists():
        print(f"  {name:12s} 缺檔 {path}")
        return False
    size = path.stat().st_size
    if size != entry["bytes"]:
        print(f"  {name:12s} 大小不符:預期 {entry['bytes']} 實際 {size}")
        return False
    got = sha256_of(path)
    if got != entry["sha256"]:
        print(f"  {name:12s} SHA256 不符\n      預期 {entry['sha256']}\n      實際 {got}")
        return False
    print(f"  {name:12s} OK  {size:,} bytes  {entry['license']}  sha256={got[:16]}…")
    return True


def download(name: str, force: bool = False) -> bool:
    entry = REGISTRY[name]
    path = model_path(name)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if path.exists() and not force and check(name):
        return True
    print(f"  {name:12s} 下載 {entry['url']}")
    tmp = path.with_suffix(path.suffix + ".part")
    try:
        request = urllib.request.Request(
            entry["url"], headers={"User-Agent": "gongguan-vision-fetch/1.0"})
        with urllib.request.urlopen(request, timeout=300) as response, open(tmp, "wb") as out:
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                out.write(block)
    except (urllib.error.URLError, OSError) as error:
        tmp.unlink(missing_ok=True)
        print(f"  {name:12s} 下載失敗:{error}")
        return False
    got = sha256_of(tmp)
    if got != entry["sha256"]:
        tmp.unlink(missing_ok=True)
        print(f"  {name:12s} SHA256 不符,已刪除\n      預期 {entry['sha256']}\n      實際 {got}")
        return False
    tmp.replace(path)
    return check(name)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default=None, choices=sorted(REGISTRY))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--check", action="store_true", help="只驗證,不下載")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    names = sorted(REGISTRY) if args.all else [args.model or DEFAULT_MODEL]
    print(f"模型目錄:{MODELS_DIR}")
    ok = True
    for name in names:
        ok = (check(name) if args.check else download(name, args.force)) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
