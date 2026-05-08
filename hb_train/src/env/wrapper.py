"""
HaxballGym → Gymnasium single-agent adapter so Stable-Baselines3 can train PPO.

Phase A: Player 0 (red) is the trained agent; Player 1 (blue) is either
random (default) or a frozen snapshot of the policy (self-play).
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import gymnasium
from gymnasium import spaces
from ursinaxball import Game
from ursinaxball.common_values import BaseMap

from haxballgym import make as haxballgym_make
from haxballgym.utils.terminal_conditions.common_conditions import TimeoutCondition

from .components import (
    HaxAI13Obs, MD332ActionParser, BaselineReward, TreeAwareReward,
    ClassicKickoffSetter, RandomKickoffSetter, GoalScored, load_custom_stadium,
)


class HaxballSelfPlayEnv(gymnasium.Env):
    """
    Wraps HaxballGym 1v1 into a single-agent Gymnasium env.
    The agent controls Player 0 (red); Player 1 (blue) is the opponent.

    opponent_predict: callable(obs_blue) -> action_blue
                     (None → random from action space)
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        opponent_predict=None,
        max_steps: int = 1500,
        tick_skip: int = 4,
        stadium=BaseMap.CLASSIC,
        seed: Optional[int] = None,
        reward_fn=None,
        randomize_state: bool = True,
        kickoff_script_ticks: int = 0,
        enable_renderer: bool = False,    # only one env should render (Panda3D)
    ):
        super().__init__()
        self._opponent_predict = opponent_predict
        self._kickoff_script_ticks = int(kickoff_script_ticks)

        game = Game(
            folder_rec=None,
            enable_renderer=enable_renderer,
            enable_recorder=False,
            enable_vsync=enable_renderer,   # vsync only meaningful with renderer
        )
        # `stadium` may be a BaseMap enum (bundled) or a path to a custom .hbs file
        if isinstance(stadium, str) and stadium.endswith(".hbs"):
            load_custom_stadium(game, stadium)
        else:
            game.load_map(stadium)

        state_setter = (
            RandomKickoffSetter(seed=seed or 0) if randomize_state else ClassicKickoffSetter()
        )

        self._gym = haxballgym_make(
            game=game,
            tick_skip=tick_skip,
            team_size=1,
            terminal_conditions=[
                TimeoutCondition(max_steps),
                GoalScored(),
            ],
            reward_fn=reward_fn if reward_fn is not None else BaselineReward(),
            obs_builder=HaxAI13Obs(),
            action_parser=MD332ActionParser(),
            state_setter=state_setter,
        )

        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(13,), dtype=np.float32,
        )
        self.action_space = spaces.MultiDiscrete([3, 3, 2])

        self._last_obs = None
        self._rng = np.random.default_rng(seed)

    # ── Gymnasium API ────────────────────────────────────
    def reset(self, *, seed=None, options=None):
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        if self._opponent_predict is not None and hasattr(self._opponent_predict, "new_episode"):
            self._opponent_predict.new_episode()
        obs_list = self._gym.reset()

        # Optional scripted kickoff: bot moves toward ball at angle, kicks it
        # at upper wall, then sets up to receive bounce. RL takes over after.
        if self._kickoff_script_ticks > 0:
            for t in range(self._kickoff_script_ticks):
                scripted = self._kickoff_action(t)
                opp_idle = np.array([1, 1, 0])
                obs_list, _, done, _ = self._gym.step([scripted, opp_idle])
                if done:
                    break

        self._last_obs = obs_list
        return np.asarray(obs_list[0], dtype=np.float32), {}

    @staticmethod
    def _kickoff_action(t: int) -> np.ndarray:
        # POV-corrected scripted opening (works for both red and blue via
        # MD332ActionParser's auto-flip for blue).
        # Phase 1 (0-15 env-ticks): chase ball at upper-forward angle
        # Phase 2 (15-25): kick while still moving up-forward → ball goes upper-forward
        # Phase 3 (25-35): drop down + forward to receive wall rebound
        if t < 15:
            return np.array([2, 0, 0])      # forward + up
        elif t < 25:
            return np.array([2, 0, 1])      # forward + up + kick
        elif t < 35:
            return np.array([2, 2, 0])      # forward + down (toward rebound landing)
        return np.array([1, 1, 0])

    def step(self, action):
        # Opponent action
        if self._opponent_predict is None:
            opp_action = self.action_space.sample()
        else:
            opp_action = self._opponent_predict(np.asarray(self._last_obs[1], dtype=np.float32))

        obs_list, reward_list, done, info = self._gym.step([action, opp_action])
        self._last_obs = obs_list

        obs = np.asarray(obs_list[0], dtype=np.float32)
        reward = float(reward_list[0])
        terminated = bool(done)
        truncated = False  # TimeoutCondition triggers terminated, not truncated, in this setup
        return obs, reward, terminated, truncated, info

    def close(self):
        # ursinaxball owns its resources; nothing to clean up explicitly here
        pass


def _resolve_reward(name: str | None):
    if name == "bugfix":
        return TreeAwareReward(level=1)
    if name == "tactical":
        return TreeAwareReward(level=2)
    if name in ("tree", "tree-aware", "full"):
        return TreeAwareReward(level=3)
    return BaselineReward()


def make_random_opponent_env(reward: str | None = None, **kwargs) -> HaxballSelfPlayEnv:
    """Default Phase A env: opponent does random actions."""
    return HaxballSelfPlayEnv(opponent_predict=None, reward_fn=_resolve_reward(reward), **kwargs)


def make_haxai_opponent_env(weights_path: str, reward: str | None = None, **kwargs) -> HaxballSelfPlayEnv:
    """Phase B env: opponent is a frozen HaxAI-format weights NN."""
    from .opponents import HaxaiOpponent
    opp = HaxaiOpponent(weights_path)
    return HaxballSelfPlayEnv(opponent_predict=opp, reward_fn=_resolve_reward(reward), **kwargs)


def make_batbot_opponent_env(
    reward: str | None = None,
    opp_epsilon: float = 0.05,
    **kwargs,
) -> HaxballSelfPlayEnv:
    """Phase B env: opponent is the JS-style chase+kick rule bot (BatBot).

    opp_epsilon: ε-random per-tick action chance (default 0.05) for variance.
    """
    from .opponents import BatBotOpponent
    return HaxballSelfPlayEnv(
        opponent_predict=BatBotOpponent(epsilon=opp_epsilon, seed=kwargs.get("seed", 0) or 0),
        reward_fn=_resolve_reward(reward),
        **kwargs,
    )


_STADIUM_NAMES = {
    "classic": BaseMap.CLASSIC,
    "futsal-classic": BaseMap.FUTSAL_CLASSIC,
    "futsal-big": BaseMap.FUTSAL_BIG,
    "big": BaseMap.BIG,
    "luxora": "../Luxora Futsal • Training Bot.hbs",   # converted in-memory by load_custom_stadium
}


def make_league_opponent_env(
    reward: str | None = None,
    seed: int = 0,
    league_dir: str = "models/league",
    anchor_paths: list[str] | None = None,
    **kwargs,
) -> "HaxballSelfPlayEnv":
    """Phase B+: opponent is the LeagueOpponent — agent's own past selves
    plus rule-bot anchors. Pool grows during training via callback."""
    from src.league import LeagueOpponent

    if anchor_paths is None:
        anchor_paths = ["../models/sp_v16_haxai.json"]

    league = LeagueOpponent(
        anchor_paths=anchor_paths,
        league_dir=league_dir,
        seed=seed,
    )
    return HaxballSelfPlayEnv(
        opponent_predict=league,
        reward_fn=_resolve_reward(reward),
        seed=seed,
        **kwargs,
    )


def make_mixed_opponent_env(
    reward: str | None = None,
    seed: int = 0,
    sp_v16_path: str | None = "../models/sp_v16_haxai.json",
    **kwargs,
) -> HaxballSelfPlayEnv:
    """Phase B+ env: opponent rotates per episode among BatBot/ProBot/SP_V16/random.
    Forces agent to handle different defensive styles, breaks single-tactic exploits."""
    import os
    from .opponents import BatBotOpponent, ProBotOpponent, HaxaiOpponent, MixedOpponent

    class _RandomActionOpp:
        def __init__(self, seed):
            self._rng = np.random.default_rng(seed)
        def __call__(self, _obs):
            return [int(self._rng.integers(0,3)), int(self._rng.integers(0,3)), int(self._rng.integers(0,2))]

    pool = [
        BatBotOpponent(epsilon=0.05, seed=seed),
        ProBotOpponent(seed=seed + 1),
        _RandomActionOpp(seed=seed + 2),
    ]
    weights = [0.40, 0.30, 0.10]
    if sp_v16_path and os.path.exists(sp_v16_path):
        pool.append(HaxaiOpponent(sp_v16_path))
        weights.append(0.20)   # SP_V16 — different defensive style from rule bots

    mixed = MixedOpponent(pool, weights=weights, seed=seed)
    return HaxballSelfPlayEnv(opponent_predict=mixed, reward_fn=_resolve_reward(reward), seed=seed, **kwargs)


def make_probot_opponent_env(seed: int = 0, reward: str | None = None, **kwargs) -> HaxballSelfPlayEnv:
    """Phase B env: opponent is the user-designed decision-tree rule bot (ProBot)."""
    from .opponents import ProBotOpponent
    return HaxballSelfPlayEnv(
        opponent_predict=ProBotOpponent(seed=seed),
        reward_fn=_resolve_reward(reward),
        **kwargs,
    )
