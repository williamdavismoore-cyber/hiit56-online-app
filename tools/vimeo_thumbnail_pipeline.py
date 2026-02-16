#!/usr/bin/env python3
"""HIIT56 Vimeo Thumbnail Pipeline (CP16)

This script generates a *static* thumbnail override map so the HIIT56 site can
show better thumbnails without you having to hand-pick hundreds.

What it does
- Reads video IDs from a JSON list (preferred) or a CSV export.
- Uses the Vimeo API to list available thumbnails ("pictures") for each video.
- Picks the best candidate using simple scoring:
    - If OpenCV face detection is available: prefers thumbnails with faces.
    - If Pillow is available: prefers sharper, well-exposed images.
    - Otherwise: falls back to the active thumbnail, then the largest one.
- Writes `site/assets/data/thumbnail_overrides.json` as:
    { "821754541": "https://i.vimeocdn.com/video/..._960x540.jpg", ... }

Why a static map?
- Fast (no runtime API calls / rate limits)
- Scales to huge traffic
- Keeps secrets out of the frontend

IMPORTANT
- Do NOT commit your Vimeo token into any repo.
- Provide the token via environment variable VIMEO_TOKEN when you run this.

Example
  # from the kit root
  export VIMEO_TOKEN="..."
  python tools/vimeo_thumbnail_pipeline.py \
    --input site/assets/data/videos_all.json \
    --output site/assets/data/thumbnail_overrides.json \
    --only-missing

Then redeploy the site.

"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Optional dependencies (script works without them)
try:
    from PIL import Image, ImageFilter, ImageStat  # type: ignore
except Exception:
    Image = None  # type: ignore
    ImageFilter = None  # type: ignore
    ImageStat = None  # type: ignore

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None  # type: ignore

try:
    import requests  # type: ignore
except Exception:
    requests = None  # type: ignore

import urllib.request

VIMEO_API_BASE = "https://api.vimeo.com"


@dataclass
class Candidate:
    url: str
    width: int
    height: int
    active: bool
    picture_id: str


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def http_json(url: str, token: str, *, timeout: int = 30) -> Dict[str, Any]:
    """GET JSON with bearer token. Uses requests if available, else urllib."""
    headers = {
        "Authorization": f"bearer {token}",
        "Accept": "application/vnd.vimeo.*+json;version=3.4",
    }
    if requests is not None:
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()

    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


def http_bytes(url: str, *, timeout: int = 30) -> bytes:
    if requests is not None:
        r = requests.get(url, timeout=timeout)
        r.raise_for_status()
        return r.content
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def parse_video_ids_from_json(path: Path) -> List[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    ids: List[str] = []
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            vid = item.get("video_id") or item.get("vimeo_id") or item.get("id")
            if vid is None:
                # sometimes only embed_url is present
                embed = item.get("embed_url") or item.get("embed") or ""
                m = re.search(r"vimeo\.com/video/(\d+)", str(embed))
                if m:
                    vid = m.group(1)
            if vid is None:
                continue
            ids.append(str(vid))
    else:
        raise ValueError("JSON input must be a list of objects.")

    # unique while preserving order
    seen = set()
    out: List[str] = []
    for v in ids:
        if v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def parse_video_ids_from_csv(path: Path) -> List[str]:
    # We try a few common columns.
    candidates = {"video_id", "vimeo_id", "Vimeo ID", "vimeo", "id", "ID"}
    ids: List[str] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row.")

        for row in reader:
            vid: Optional[str] = None
            for key in reader.fieldnames:
                if key in candidates and row.get(key):
                    vid = str(row[key]).strip()
                    break
            if not vid:
                # try to pull from any URL-like field
                for k, v in row.items():
                    if not v:
                        continue
                    m = re.search(r"vimeo\.com/(?:video/)?(\d{6,})", str(v))
                    if m:
                        vid = m.group(1)
                        break
            if not vid:
                continue
            ids.append(str(vid))

    seen = set()
    out: List[str] = []
    for v in ids:
        if v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def list_vimeo_pictures(video_id: str, token: str, cache_dir: Path, *, use_cache: bool = True) -> List[Candidate]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{video_id}.json"

    if use_cache and cache_file.exists():
        try:
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            payload = None
    else:
        payload = None

    if payload is None:
        url = f"{VIMEO_API_BASE}/videos/{video_id}/pictures?per_page=100"
        payload = http_json(url, token)
        cache_file.write_text(json.dumps(payload), encoding="utf-8")
        # be kind to rate limits
        time.sleep(0.12)

    data = payload.get("data") or []
    out: List[Candidate] = []
    for pic in data:
        if not isinstance(pic, dict):
            continue
        sizes = pic.get("sizes") or []
        if not isinstance(sizes, list) or not sizes:
            continue
        best = None
        for s in sizes:
            if not isinstance(s, dict):
                continue
            w = int(s.get("width") or 0)
            h = int(s.get("height") or 0)
            link = s.get("link")
            if not link:
                continue
            if best is None or w > best[0]:
                best = (w, h, str(link))
        if best is None:
            continue
        w, h, link = best
        out.append(
            Candidate(
                url=link,
                width=w,
                height=h,
                active=bool(pic.get("active")),
                picture_id=str(pic.get("uri") or pic.get("resource_key") or ""),
            )
        )

    # If Vimeo returns nothing, return empty list.
    return out


def score_candidate(c: Candidate) -> Tuple[float, Dict[str, Any]]:
    """Higher score is better. Returns (score, debug_meta)."""
    meta: Dict[str, Any] = {
        "active": c.active,
        "w": c.width,
        "h": c.height,
        "face_count": 0,
        "sharp": None,
        "brightness": None,
    }

    score = 0.0

    if c.active:
        score += 5.0

    # Prefer large thumbs (but don't let size dominate)
    score += min(c.width / 500.0, 3.0)

    if Image is None:
        return score, meta

    try:
        raw = http_bytes(c.url)
        img = Image.open(io.BytesIO(raw)).convert("RGB")  # type: ignore
    except Exception:
        return score, meta

    # brightness
    try:
        stat = ImageStat.Stat(img.convert("L"))  # type: ignore
        bright = float(stat.mean[0])
        meta["brightness"] = bright
        # prefer middle exposure
        score += max(0.0, 2.0 - (abs(bright - 128.0) / 128.0) * 2.0)
    except Exception:
        pass

    # sharpness heuristic: mean abs diff from a blurred version
    try:
        gray = img.convert("L")
        blur = gray.filter(ImageFilter.GaussianBlur(radius=2))  # type: ignore
        # compute avg absolute pixel difference using histogram (fast, no numpy)
        diff = ImageChops.difference(gray, blur)  # type: ignore
        hist = diff.histogram()
        total = sum(hist)
        if total > 0:
            mean_diff = sum(i * h for i, h in enumerate(hist)) / total
            meta["sharp"] = float(mean_diff)
            score += min(mean_diff / 12.0, 3.0)
    except Exception:
        pass

    # face detection (optional)
    if cv2 is not None:
        try:
            import numpy as np  # type: ignore

            arr = np.array(img)
            gray_cv = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
            cascade_path = getattr(cv2.data, "haarcascades", "") + "haarcascade_frontalface_default.xml"
            if cascade_path and os.path.exists(cascade_path):
                face = cv2.CascadeClassifier(cascade_path)
                faces = face.detectMultiScale(gray_cv, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
                face_count = 0 if faces is None else len(faces)
                meta["face_count"] = int(face_count)
                if face_count > 0:
                    score += 10.0 + float(face_count) * 3.0
        except Exception:
            pass

    return score, meta


# Pillow helpers only imported when Pillow is available
if Image is not None:
    import io
    from PIL import ImageChops  # type: ignore


def pick_best(cands: List[Candidate], *, fast: bool = False) -> Tuple[Optional[Candidate], Dict[str, Any]]:
    """Pick best candidate. fast=True avoids downloading/scoring images."""
    if not cands:
        return None, {"reason": "no_candidates"}

    # Basic fallback: prefer active, else largest
    def fallback() -> Candidate:
        active = [c for c in cands if c.active]
        pool = active or cands
        return sorted(pool, key=lambda c: (c.width, c.height), reverse=True)[0]

    if fast or Image is None:
        c = fallback()
        return c, {"reason": "fast_or_no_pillow", "picked": {"w": c.width, "h": c.height, "active": c.active}}

    best: Optional[Candidate] = None
    best_score = -1e9
    best_meta: Dict[str, Any] = {}

    for c in sorted(cands, key=lambda c: (c.width, c.height), reverse=True)[:8]:
        score, meta = score_candidate(c)
        if score > best_score:
            best_score = score
            best = c
            best_meta = meta

    if best is None:
        c = fallback()
        return c, {"reason": "fallback", "picked": {"w": c.width, "h": c.height, "active": c.active}}

    best_meta["score"] = best_score
    return best, {"reason": "scored", "picked": best_meta}


def load_existing_overrides(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        # remove meta block if present
        out: Dict[str, str] = {}
        for k, v in data.items():
            if k == "_meta":
                continue
            if isinstance(v, str):
                out[str(k)] = v
        return out
    except Exception:
        return {}


def write_overrides(path: Path, mapping: Dict[str, str]) -> None:
    payload = {
        "_meta": {
            "schema": "hiit56.thumbnail_overrides.v1",
            "generated_at": time.strftime("%Y-%m-%d"),
            "count": len(mapping),
            "notes": "Map of Vimeo video_id (string) -> preferred thumbnail URL. Generated by tools/vimeo_thumbnail_pipeline.py.",
        },
        **{k: mapping[k] for k in sorted(mapping, key=lambda s: int(s) if s.isdigit() else s)},
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate HIIT56 thumbnail_overrides.json from Vimeo API")
    ap.add_argument("--input", required=True, help="Input JSON list or CSV containing Vimeo IDs")
    ap.add_argument("--output", required=True, help="Path to write thumbnail_overrides.json")
    ap.add_argument("--token", default="", help="Vimeo token (prefer env var VIMEO_TOKEN)")
    ap.add_argument("--limit", type=int, default=0, help="Only process first N videos (0 = all)")
    ap.add_argument("--only-missing", action="store_true", help="Only create overrides for IDs not already in output")
    ap.add_argument("--no-cache", action="store_true", help="Disable local API response caching")
    ap.add_argument("--fast", action="store_true", help="Skip image downloads; prefer active/largest")
    ap.add_argument("--cache-dir", default=".cache/vimeo_pictures", help="Cache directory for API responses")
    args = ap.parse_args(list(argv))

    token = (args.token or os.environ.get("VIMEO_TOKEN") or os.environ.get("VIMEO_ACCESS_TOKEN") or "").strip()
    if not token:
        eprint("ERROR: Missing Vimeo token. Set VIMEO_TOKEN env var or pass --token.")
        return 2

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        eprint(f"ERROR: Input not found: {input_path}")
        return 2

    if input_path.suffix.lower() == ".json":
        video_ids = parse_video_ids_from_json(input_path)
    elif input_path.suffix.lower() == ".csv":
        video_ids = parse_video_ids_from_csv(input_path)
    else:
        eprint("ERROR: Input must be .json or .csv")
        return 2

    if args.limit and args.limit > 0:
        video_ids = video_ids[: args.limit]

    existing = load_existing_overrides(output_path)
    out_map: Dict[str, str] = dict(existing)

    cache_dir = Path(args.cache_dir)
    processed = 0
    picked = 0

    for vid in video_ids:
        processed += 1
        if args.only_missing and vid in existing:
            continue

        try:
            cands = list_vimeo_pictures(vid, token, cache_dir, use_cache=not args.no_cache)
            best, meta = pick_best(cands, fast=args.fast)
            if best is None:
                eprint(f"[{processed}/{len(video_ids)}] {vid}: no candidates")
                continue
            out_map[vid] = best.url
            picked += 1
            eprint(f"[{processed}/{len(video_ids)}] {vid}: picked {best.width}x{best.height} active={best.active} ({meta.get('reason')})")
        except Exception as ex:
            eprint(f"[{processed}/{len(video_ids)}] {vid}: ERROR {ex}")

    write_overrides(output_path, out_map)
    eprint(f"Done. Processed={processed}, picked/updated={picked}, total_overrides={len(out_map)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
