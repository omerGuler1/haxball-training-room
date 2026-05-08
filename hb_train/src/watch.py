"""
Watch a model play live, OR record .hbr2 replays you can review later.

Live render (opens an ursinaxball window):
    .venv/bin/python -m src.watch ../models/v2.json --vs ../models/sp_v16_haxai.json --games 5

Record replays only (no window — fast, results land in recordings/):
    .venv/bin/python -m src.watch ../models/v2.json --vs ../models/sp_v16_haxai.json --games 20 --record --no-render

Replay viewer for .hbr2 files: https://wazarr94.github.io/
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

logging.getLogger("ursinaxball").setLevel(logging.WARNING)
logging.getLogger().setLevel(logging.WARNING)

from ursinaxball import Game
from ursinaxball.common_values import BaseMap

from haxballgym import make as haxballgym_make
from haxballgym.utils.terminal_conditions.common_conditions import TimeoutCondition

from src.env.components import (
    HaxAI13Obs, MD332ActionParser, BaselineReward, ClassicKickoffSetter, GoalScored,
)
from src.env.opponents import HaxaiOpponent, BatBotOpponent, ProBotOpponent


def load_agent(spec: str):
    """spec: 'batbot' | 'probot' | path/to/weights.json"""
    if spec == "batbot":
        return BatBotOpponent()
    if spec == "probot":
        return ProBotOpponent()
    return HaxaiOpponent(spec)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("a", help="weights.json path OR 'batbot' OR 'probot' (red / P0)")
    ap.add_argument("--vs", required=True, dest="b",
                    help="weights.json path OR 'batbot' OR 'probot' (blue / P1)")
    ap.add_argument("--games", type=int, default=3)
    ap.add_argument("--max-steps", type=int, default=600)
    ap.add_argument("--no-render", action="store_true", help="Disable on-screen rendering")
    ap.add_argument("--record", action="store_true", help="Save .hbr2 replays to recordings/")
    ap.add_argument("--rec-dir", type=str, default="recordings")
    # Default ON for watching: cap to monitor refresh so games play at real Haxball speed.
    ap.add_argument("--no-vsync", action="store_true",
                    help="Disable vsync (runs at max CPU speed — useful for fast eval)")
    args = ap.parse_args()

    rec_dir = None
    if args.record:
        rec_dir = Path(args.rec_dir)
        rec_dir.mkdir(parents=True, exist_ok=True)
        print(f"[watch] Replays → {rec_dir.resolve()}")

    game = Game(
        folder_rec=str(rec_dir) if rec_dir else None,
        enable_renderer=not args.no_render,
        enable_recorder=bool(rec_dir),
        enable_vsync=not args.no_vsync,
    )
    game.load_map(BaseMap.CLASSIC)

    env = haxballgym_make(
        game=game,
        tick_skip=4,
        team_size=1,
        terminal_conditions=[TimeoutCondition(args.max_steps), GoalScored()],
        reward_fn=BaselineReward(),
        obs_builder=HaxAI13Obs(),
        action_parser=MD332ActionParser(),
        state_setter=ClassicKickoffSetter(),
    )

    agent_a = load_agent(args.a)
    agent_b = load_agent(args.b)

    print(f"[watch] A (red)  = {args.a}")
    print(f"[watch] B (blue) = {args.b}")
    print(f"[watch] {args.games} games, max {args.max_steps} ticks, render={not args.no_render}, record={bool(rec_dir)}")
    if not args.no_render:
        print("[watch] Renderer window will open. Close it or Ctrl+C to stop.")

    a_wins = b_wins = draws = 0
    for g in range(args.games):
        obs = env.reset(save_recording=bool(rec_dir))
        steps = 0
        rew_sum_a = 0.0
        while True:
            action_a = agent_a(obs[0])
            action_b = agent_b(obs[1])
            obs, rew, done, info = env.step([action_a, action_b])
            rew_sum_a += float(rew[0])
            steps += 1
            if done:
                break

        # Outcome by terminal reward sign (±10 = goal, ~0 = timeout)
        if rew_sum_a > 5.0:
            a_wins += 1; outcome = "A wins"
        elif rew_sum_a < -5.0:
            b_wins += 1; outcome = "B wins"
        else:
            draws += 1; outcome = "draw"
        print(f"[watch] Game {g+1}/{args.games}: {outcome}  len={steps} env-steps  rew_A={rew_sum_a:+.2f}")

    print()
    print(f"[watch] A: {a_wins}  B: {b_wins}  Draws: {draws}")


if __name__ == "__main__":
    main()
