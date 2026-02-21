"""NDYRA static site QA smoke tests (auto-labeled from build.json).

Run:
  python tools/qa_smoke.py

What it checks:
  - Core pages exist
  - JSON manifests parse
  - Category slugs referenced by videos exist
  - Teaser IDs exist
  - Hero posters exist
  - No obvious broken internal asset references (best-effort)

This is NOT a replacement for manual UX/browser QA on iPhone/Android/Desktop.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple


ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "assets" / "data"


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    # Auto-label from build.json (required for checkpoint integrity).
    build_path = SITE / "assets" / "build.json"
    assert_(build_path.exists(), f"Missing required file: {build_path}")

    try:
        data = json.loads(build_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"FAIL: build.json is not valid JSON: {e}")
        return 1

    label = data.get("label")
    if not label:
        cp = data.get("cp")
        label = f"CP{cp}" if cp is not None else None

    if not label:
        print("FAIL: build.json missing required fields: expected 'label' or 'cp'")
        return 1

    print(f"NDYRA QA SMOKE — {label}")
    print(f"Root: {ROOT}")
    print(f"Site: {SITE}")


    required_pages = [
        SITE / "index.html",
        SITE / "login.html",
        SITE / "pricing.html",
        SITE / "join.html",
        SITE / "for-gyms" / "index.html",
        SITE / "for-gyms" / "pricing.html",
        SITE / "for-gyms" / "start.html",
        SITE / "workouts" / "index.html",
        SITE / "workouts" / "category.html",
        SITE / "workouts" / "workout.html",
        SITE / "app" / "index.html",
        SITE / "app" / "workouts" / "index.html",
        SITE / "app" / "workouts" / "category.html",
        SITE / "app" / "workouts" / "workout.html",
        SITE / "app" / "timer" / "index.html",
        SITE / "app" / "timer" / "builder" / "index.html",
        SITE / "app" / "timer" / "my-workouts" / "index.html",
        # Blueprint v7.3.1 route scaffolds
        SITE / "gym" / "join" / "index.html",
        SITE / "app" / "book" / "class" / "index.html",
        SITE / "biz" / "check-in" / "index.html",
        SITE / "biz" / "migrate" / "index.html",
        SITE / "biz" / "migrate" / "members" / "index.html",
        SITE / "biz" / "migrate" / "schedule" / "index.html",
        SITE / "biz" / "migrate" / "billing" / "index.html",
        SITE / "biz" / "migrate" / "hardware" / "index.html",
        SITE / "biz" / "migrate" / "confirm" / "index.html",
        SITE / "biz" / "index.html",
        SITE / "biz" / "moves" / "index.html",
        SITE / "biz" / "moves" / "move.html",
        SITE / "biz" / "gym-timer" / "index.html",
        SITE / "biz" / "gym-timer" / "builder" / "index.html",
        SITE / "admin" / "index.html",
        SITE / "admin" / "status" / "index.html",
    ]

    print("\n[1] Page presence")
    for p in required_pages:
        assert_(p.exists(), f"Missing page: {p}")
        print(f"  OK: {p.relative_to(ROOT)}")

    print("\n[2] Data manifest presence")
    required_data = [
        DATA / "categories_v1.json",
        DATA / "categories_draft.json",  # kept as an alias/compat file
        DATA / "videos_classes.json",
        DATA / "videos_moves.json",
        DATA / "videos_all.json",
        DATA / "videos_marketing.json",
        DATA / "videos_category_samples.json",
        DATA / "timer_demos.json",
        DATA / "stripe_public_test.json",
    ]
    for p in required_data:
        assert_(p.exists(), f"Missing data: {p}")
        print(f"  OK: {p.relative_to(ROOT)}")

    print("\n[3] JSON parsing")
    cats = _load_json(DATA / "categories_v1.json")
    classes = _load_json(DATA / "videos_classes.json")
    moves = _load_json(DATA / "videos_moves.json")
    assert_("categories" in cats and isinstance(cats["categories"], list), "categories_v1.json missing categories[]")
    assert_(isinstance(classes, list) and len(classes) > 0, "videos_classes.json empty")
    assert_(isinstance(moves, list) and len(moves) > 0, "videos_moves.json empty")
    print(f"  OK: categories={len(cats['categories'])}, classes={len(classes)}, moves={len(moves)}")

    print("\n[3b] Timer demos sanity")
    demos = _load_json(DATA / "timer_demos.json")
    assert_("demos" in demos and isinstance(demos["demos"], list) and len(demos["demos"]) > 0, "timer_demos.json missing demos[]")
    for d in demos["demos"]:
        demo_id = d.get("id") or "(missing id)"
        segs = d.get("segments") or []
        assert_(isinstance(segs, list) and len(segs) > 0, f"Demo {demo_id} has no segments")
        total = sum(int(s.get("duration_sec") or 0) for s in segs)
        assert_(total > 0, f"Demo {demo_id} has zero total duration")
        # ensure all segments have integer-ish positive duration
        for s in segs:
            dur = int(s.get("duration_sec") or 0)
            assert_(dur > 0, f"Demo {demo_id} has non-positive duration segment: {s}")
        if d.get("mode") == "gym":
            st = d.get("stations") or []
            assert_(isinstance(st, list) and len(st) > 0, f"Demo {demo_id} (gym) missing stations[]")
    print(f"  OK: demos={len(demos['demos'])}")

    print("\n[4] Category slugs + posters")
    slug_set: Set[str] = set()
    teaser_set: Set[int] = set()
    for c in cats["categories"]:
        slug = c.get("slug")
        assert_(isinstance(slug, str) and slug, "Category missing slug")
        slug_set.add(slug)
        poster = c.get("hero_poster")
        assert_(isinstance(poster, str) and poster.startswith("/"), f"Category {slug} missing hero_poster")
        poster_path = SITE / poster.lstrip("/")
        assert_(poster_path.exists(), f"Missing hero_poster file for {slug}: {poster_path}")
        for tid in c.get("teaser_video_ids", []) or []:
            try:
                teaser_set.add(int(tid))
            except Exception:
                raise AssertionError(f"Non-numeric teaser id in {slug}: {tid}")
    print(f"  OK: {len(slug_set)} categories, {len(teaser_set)} total teaser IDs")

    print("\n[5] Classes reference known category slugs")
    bad = [v for v in classes if v.get("category_slug") not in slug_set]
    assert_(len(bad) == 0, f"{len(bad)} class videos reference unknown category_slug")
    print("  OK")

    print("\n[6] Teaser IDs exist in class list")
    class_ids: Set[int] = set(int(v.get("video_id")) for v in classes if v.get("video_id") is not None)
    missing_teasers = sorted([tid for tid in teaser_set if tid not in class_ids])
    assert_(len(missing_teasers) == 0, f"Missing teaser IDs not found in class list: {missing_teasers[:20]}")
    print("  OK")

    print("\n[7] Basic internal asset refs")
    css = SITE / "assets" / "css" / "styles.css"
    js = SITE / "assets" / "js" / "site.js"
    assert_(css.exists(), "Missing styles.css")
    assert_(js.exists(), "Missing site.js")
    assert_("--accent:#e40001" in css.read_text(encoding="utf-8"), "Accent color not found in CSS")
    print("  OK")


    print("\n[7b] JS syntax check (node --check)")
    import subprocess
    res = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
    assert_(res.returncode == 0, f"JS syntax error in site.js:\n{res.stderr or res.stdout}")
    print("  OK")

    print("\n[8] CP string consistency")
    site_text = "\n".join(p.read_text(encoding="utf-8", errors="ignore") for p in required_pages)
    assert_("CP05" not in site_text, "Found leftover CP05 strings in site pages")
    assert_("CP06" not in site_text, "Found leftover CP06 strings in site pages")
    print("  OK")

    print("\nPASS ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
