"""Generate timer demo timelines for the static preview.

Why:
- Provides deterministic demo timelines for the new timer pages:
  - /app/timer/ (online demos)
  - /biz/gym-timer/ (gym demo)

Output:
- site/assets/data/timer_demos.json

Run:
  python tools/gen_timer_demos.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "assets" / "data"


def cycle_embed_urls(moves: List[Dict[str, Any]]):
    i = 0
    while True:
        yield moves[i % len(moves)]["embed_url"]
        i += 1


def main() -> int:
    moves = json.loads((DATA / "videos_moves.json").read_text(encoding="utf-8"))
    embed_iter = cycle_embed_urls(moves)

    # Example #2 (owner doc): 8 stages, 3 moves, 2 rounds, 20s rest between rounds, 50s between stages, 60s per move.
    stage_moves = [
        ["Jumping Jacks","Bodybuilder","Push-up"],
        ["Shoulder Taps","Seal Jacks","Jump Squats"],
        ["Burpees","Straddle Jump","Toe Taps"],
        ["TRX In Outs","High Knees","Db Walking Lunge"],
        ["Bear Crawl","Death Frogs","Broad Jump"],
        ["Full Range Sit-up","Rocking Plank","Bicycle Abs"],
        ["Plank Jump","Plank Hold","Wall Sit"],
        ["Skaters","Split Jump","Toy Soldier"],
    ]

    online_segments: List[Dict[str, Any]] = []
    for stage_idx, moves3 in enumerate(stage_moves, start=1):
        for round_idx in [1, 2]:
            for slot_idx, move_name in enumerate(moves3, start=1):
                online_segments.append({
                    "kind": "WORK",
                    "duration_sec": 60,
                    "meta": {
                        "mode": "online",
                        "stage_index": stage_idx,
                        "stage_count": len(stage_moves),
                        "round_index": round_idx,
                        "rounds_per_stage": 2,
                        "move_slot_index": slot_idx,
                        "move_slots_per_stage": 3,
                        "move_name": move_name,
                        "video_embed_url": next(embed_iter),
                    }
                })
            if round_idx < 2:
                online_segments.append({
                    "kind": "REST",
                    "duration_sec": 20,
                    "meta": {
                        "mode": "online",
                        "stage_index": stage_idx,
                        "round_index": round_idx,
                        "rest_type": "between_rounds",
                    }
                })
        if stage_idx < len(stage_moves):
            online_segments.append({
                "kind": "STATION_STAGE_TRANSITION",
                "duration_sec": 50,
                "meta": {"mode": "online", "from_stage": stage_idx, "to_stage": stage_idx + 1}
            })

    # Example #1 (owner doc): 6 stations, 2 moves per station, 40/12, 4 rounds per move, 20s between moves, 60s between stations.
    gym_stations = [
        {"station": 1, "people": 6, "moves": ["Db Curl", "Db Hammer Curl"]},
        {"station": 2, "people": 6, "moves": ["Bench Press", "Db Skull Crusher"]},
        {"station": 3, "people": 6, "moves": ["Kb Row – R", "Kb Row - L"]},
        {"station": 4, "people": 6, "moves": ["Leg Raise", "Butterfly Crunch"]},
        {"station": 5, "people": 6, "moves": ["Db Arnold Press", "Db Lateral Raise"]},
        {"station": 6, "people": 6, "moves": ["Pull-ups", "Push-ups"]},
    ]
    station_count = len(gym_stations)
    gym_segments: List[Dict[str, Any]] = []
    for rotation in range(1, station_count + 1):
        for slot in [1, 2]:
            for rnd in range(1, 5):
                gym_segments.append({
                    "kind": "WORK",
                    "duration_sec": 40,
                    "meta": {"mode": "gym", "rotation_index": rotation, "rotation_count": station_count, "move_slot_index": slot, "round_index": rnd, "rounds_per_move": 4}
                })
                gym_segments.append({
                    "kind": "REST",
                    "duration_sec": 12,
                    "meta": {"mode": "gym", "rotation_index": rotation, "rotation_count": station_count, "move_slot_index": slot, "round_index": rnd, "rest_type": "between_rounds"}
                })
            if slot == 1:
                gym_segments.append({
                    "kind": "MOVE_TRANSITION_A",
                    "duration_sec": 20,
                    "meta": {"mode": "gym", "rotation_index": rotation, "from_move_slot": 1, "to_move_slot": 2}
                })
        if rotation < station_count:
            gym_segments.append({
                "kind": "STATION_STAGE_TRANSITION",
                "duration_sec": 60,
                "meta": {"mode": "gym", "from_rotation": rotation, "to_rotation": rotation + 1}
            })

    # Quick demo: 10s work / 5s rest
    quick_segments: List[Dict[str, Any]] = []
    for round_idx in [1, 2]:
        for slot_idx, move_name in enumerate(["Demo Move 1", "Demo Move 2"], start=1):
            quick_segments.append({
                "kind": "WORK",
                "duration_sec": 10,
                "meta": {"mode": "online", "stage_index": 1, "stage_count": 1, "round_index": round_idx, "rounds_per_stage": 2, "move_slot_index": slot_idx, "move_slots_per_stage": 2, "move_name": move_name, "video_embed_url": next(embed_iter)}
            })
        if round_idx < 2:
            quick_segments.append({"kind": "REST", "duration_sec": 5, "meta": {"mode": "online", "stage_index": 1, "rest_type": "between_rounds"}})

    out = {
        "generated_at": "2026-02-07",
        "demos": [
            {
                "id": "online_example2",
                "mode": "online",
                "title": "Online Demo — Example #2 (8 stages, 3 moves, 2 rounds)",
                "description": "Based on the owner’s Example #2. Uses move demo videos as placeholders for the move clips.",
                "cap_suggestion_min": 42,
                "segments": online_segments,
                "stage_moves": stage_moves,
            },
            {
                "id": "gym_example1",
                "mode": "gym",
                "title": "Gym Demo — Example #1 (6 stations, 2 moves, 4 rounds per move)",
                "description": "Based on the owner’s Example #1. Station board shows assigned station moves; timer drives rounds, move slot A/B, and rotation transitions.",
                "cap_suggestion_min": 42,
                "stations": gym_stations,
                "segments": gym_segments,
            },
            {
                "id": "online_quick",
                "mode": "online",
                "title": "Online Quick Demo (10s work / 5s rest)",
                "description": "Short demo to quickly verify beeps, volume, and segment transitions.",
                "cap_suggestion_min": 1,
                "segments": quick_segments,
            },
        ]
    }

    (DATA / "timer_demos.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("Wrote:", DATA / "timer_demos.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
