"""
League self-play infrastructure.

Two pieces:
  1. LeagueOpponent — maintains a pool of frozen NN opponents (HaxaiOpponent
     instances loaded from JSON) plus optional anchor rule bots; samples one
     per episode via `new_episode()`. Supports dynamic pool growth as new
     checkpoints are exported during training.

  2. LeagueCheckpointCallback — SB3 callback that, every `export_freq` steps,
     dumps the current model to JSON and notifies the league pool.

This is the proven path for competitive multi-agent RL (AlphaStar, OpenAI Five,
HaxAI's SP_V16). Replaces the prescriptive reward-shaping approach.
"""
from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import torch
from stable_baselines3.common.callbacks import BaseCallback

from src.env.opponents import HaxaiOpponent, BatBotOpponent, ProBotOpponent


class LeagueOpponent:
    """
    Per-episode opponent sampler with three buckets:
      - recent NN checkpoints (60% by default)
      - mid-history NN checkpoints (25%)
      - oldest NN checkpoints (10%)
      - external anchors (5%) — BatBot/ProBot/SP_V16 for stability

    Pool grows dynamically as new checkpoints are added via `add_checkpoint()`.
    """

    def __init__(
        self,
        anchor_paths: list[str] | None = None,
        league_dir: str = "models/league",
        weights: tuple[float, float, float, float] = (0.60, 0.25, 0.10, 0.05),
        seed: int = 0,
    ):
        self._league_dir = Path(league_dir)
        self._league_dir.mkdir(parents=True, exist_ok=True)
        self._weights = weights        # recent, mid, old, anchor
        self._rng = random.Random(seed)

        # NN pool: list of (path, HaxaiOpponent instance) — newest at end
        self._pool: list[tuple[str, HaxaiOpponent]] = []

        # Anchor bots — always available, occasional reality check
        self._anchors = []
        if anchor_paths:
            for p in anchor_paths:
                if Path(p).exists():
                    self._anchors.append(HaxaiOpponent(p))
        # Plus rule bots so league always has SOMEONE if NN pool is empty
        self._anchors.append(BatBotOpponent(epsilon=0.05, seed=seed))
        self._anchors.append(ProBotOpponent(seed=seed + 1))

        # Bootstrap: scan existing JSONs in league_dir
        for p in sorted(self._league_dir.glob("*.json")):
            self._pool.append((str(p), HaxaiOpponent(str(p))))

        self._current = self._pick_initial()

    def __repr__(self):
        return f"LeagueOpponent(pool={len(self._pool)}, anchors={len(self._anchors)})"

    def _pick_initial(self):
        if self._anchors:
            return self._rng.choice(self._anchors)
        return None

    def add_checkpoint(self, json_path: str) -> None:
        try:
            self._pool.append((json_path, HaxaiOpponent(json_path)))
        except Exception:
            pass  # malformed JSON — skip silently

    def _sample(self):
        n = len(self._pool)
        if n == 0:
            return self._rng.choice(self._anchors) if self._anchors else None

        r = self._rng.random()
        recent_w, mid_w, old_w, anchor_w = self._weights
        if r < anchor_w and self._anchors:
            return self._rng.choice(self._anchors)
        # NN pool sampling
        r -= anchor_w
        if n == 1:
            return self._pool[-1][1]
        recent_n = max(1, n // 5)
        old_n = max(1, n // 5)
        mid_start = recent_n
        mid_end = n - old_n
        if r < recent_w:
            idx = self._rng.randint(max(0, n - recent_n), n - 1)
        elif r < recent_w + mid_w:
            if mid_end > mid_start:
                idx = self._rng.randint(mid_start, mid_end - 1)
            else:
                idx = n - 1
        else:
            idx = self._rng.randint(0, max(0, old_n - 1))
        return self._pool[idx][1]

    def new_episode(self):
        self._current = self._sample()
        # Reset stateful opponents
        for attr in ("_step", "_last_kick_step"):
            if hasattr(self._current, attr):
                setattr(self._current, attr, 0 if attr == "_step" else -100)

    def __call__(self, obs):
        if self._current is None:
            return [1, 1, 0]
        return self._current(obs)


class LeagueCheckpointCallback(BaseCallback):
    """
    Every `export_freq` env-steps, exports current PPO model to a JSON
    weights file in `league_dir` and registers it with `league` pool.
    """

    def __init__(self, league: LeagueOpponent, league_dir: str, export_freq: int = 50_000, verbose: int = 0):
        super().__init__(verbose)
        self._league = league
        self._league_dir = Path(league_dir)
        self._league_dir.mkdir(parents=True, exist_ok=True)
        self._export_freq = export_freq
        self._next_export = export_freq

    def _on_step(self) -> bool:
        if self.num_timesteps >= self._next_export:
            tag = f"league_{self.num_timesteps:09d}.json"
            path = self._league_dir / tag
            self._export(path)
            self._league.add_checkpoint(str(path))
            self._next_export = self.num_timesteps + self._export_freq
            if self.verbose:
                print(f"[league] +1 checkpoint ({path.name}); pool size={len(self._league._pool)}")
        return True

    def _export(self, path: Path):
        """Mirror of src.export_weights but in-memory (avoids zip→reload)."""
        pol = self.model.policy
        layers = list(pol.mlp_extractor.policy_net.children())
        linears = [l for l in layers if isinstance(l, torch.nn.Linear)]
        fc1, fc2 = linears
        fc3 = pol.action_net
        weights = {
            "w0": fc1.weight.detach().cpu().numpy().tolist(),
            "b0": fc1.bias.detach().cpu().numpy().tolist(),
            "w1": fc2.weight.detach().cpu().numpy().tolist(),
            "b1": fc2.bias.detach().cpu().numpy().tolist(),
            "w2": fc3.weight.detach().cpu().numpy().tolist(),
            "b2": fc3.bias.detach().cpu().numpy().tolist(),
        }
        with open(path, "w") as f:
            json.dump(weights, f)
