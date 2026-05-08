"""
Head-to-head evaluation: play model A vs model B for N games on classic.hbs,
report win-rate, goal differential, average game length.

Usage:
    .venv/bin/python -m src.eval ../models/v1_spv16ft.json ../models/sp_v16_haxai.json --games 100

Both models must be in HaxAI weights JSON format.
"""
from __future__ import annotations

import argparse
import logging
import time

import numpy as np

logging.getLogger("ursinaxball").setLevel(logging.WARNING)
logging.getLogger().setLevel(logging.WARNING)

from src.env.opponents import HaxaiOpponent, BatBotOpponent, ProBotOpponent
from src.env.wrapper import HaxballSelfPlayEnv


def load_agent(spec: str):
    """spec: 'batbot' | 'probot' | path/to/weights.json"""
    if spec == "batbot":
        return BatBotOpponent(), spec
    if spec == "probot":
        return ProBotOpponent(), spec
    return HaxaiOpponent(spec), spec


def play_one(env: HaxballSelfPlayEnv, agent_a) -> tuple[float, int]:
    """Run one episode; agent_a controls P0, env's opponent_predict controls P1.
    Returns (cumulative_reward_for_a, episode_length)."""
    obs, _ = env.reset()
    total = 0.0
    steps = 0
    while True:
        action = agent_a(obs)
        obs, r, term, trunc, _ = env.step(action)
        total += r
        steps += 1
        if term or trunc:
            break
    return total, steps


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("a", help="weights.json path OR 'batbot' OR 'probot' (red / P0)")
    ap.add_argument("b", help="weights.json path OR 'batbot' OR 'probot' (blue / P1)")
    ap.add_argument("--games", type=int, default=50)
    ap.add_argument("--max-steps", type=int, default=600)
    args = ap.parse_args()

    agent_a, _ = load_agent(args.a)
    agent_b, _ = load_agent(args.b)
    env = HaxballSelfPlayEnv(opponent_predict=agent_b, max_steps=args.max_steps)

    print(f"[eval] A = {args.a}")
    print(f"[eval] B = {args.b}")
    print(f"[eval] {args.games} games on classic.hbs (max {args.max_steps} ticks)")
    print()

    a_wins, b_wins, draws = 0, 0, 0
    a_rew_sum, lens_sum = 0.0, 0
    t0 = time.time()

    for i in range(args.games):
        rew, length = play_one(env, agent_a)
        a_rew_sum += rew
        lens_sum += length
        # Goal-based outcome: terminal reward is ±10 (goal) or ~0 (timeout)
        if rew > 5.0:
            a_wins += 1
            outcome = "A"
        elif rew < -5.0:
            b_wins += 1
            outcome = "B"
        else:
            draws += 1
            outcome = "-"
        if (i + 1) % max(1, args.games // 10) == 0:
            print(f"  [{i+1}/{args.games}] rew={rew:+.2f} len={length:4d} → {outcome}  "
                  f"running A:{a_wins} B:{b_wins} D:{draws}")

    elapsed = time.time() - t0
    a_pct = 100 * a_wins / args.games
    b_pct = 100 * b_wins / args.games
    d_pct = 100 * draws / args.games

    print()
    print(f"[eval] Done in {elapsed:.0f}s")
    print(f"[eval] Wins:   A={a_wins} ({a_pct:.1f}%)  B={b_wins} ({b_pct:.1f}%)  Draws={draws} ({d_pct:.1f}%)")
    print(f"[eval] A avg reward / game: {a_rew_sum/args.games:+.3f}")
    print(f"[eval] Avg episode length:  {lens_sum/args.games:.0f} ticks")


if __name__ == "__main__":
    main()
