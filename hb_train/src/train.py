"""
Phase A training: PPO vs random opponent on classic.hbs.

Run from hb_train/:
    .venv/bin/python -m src.train

Outputs:
    runs/ppo_phaseA_<ts>/                 ← TensorBoard logs
    checkpoints/ppo_phaseA_<ts>/          ← .zip checkpoints

After training, export weights with:
    .venv/bin/python -m src.export_weights checkpoints/ppo_phaseA_<ts>/final.zip ../models/v1_phaseA.json
"""
from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import torch

# Silence ursinaxball's noisy DEBUG logging.
logging.getLogger("ursinaxball").setLevel(logging.WARNING)
logging.getLogger().setLevel(logging.WARNING)
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

from src.env.wrapper import (
    make_random_opponent_env,
    make_haxai_opponent_env,
    make_batbot_opponent_env,
    make_probot_opponent_env,
    make_mixed_opponent_env,
    make_league_opponent_env,
)


def make_env_factory(
    max_steps: int = 1500,
    seed: int = 0,
    opponent: str = "random",
    opponent_weights: str | None = None,
    reward: str | None = None,
    stadium: str = "classic",
    kickoff_script_ticks: int = 0,
    enable_renderer: bool = False,
):
    from src.env.wrapper import _STADIUM_NAMES
    stadium_enum = _STADIUM_NAMES.get(stadium, _STADIUM_NAMES["classic"])
    extra = {
        "stadium": stadium_enum,
        "kickoff_script_ticks": kickoff_script_ticks,
        "enable_renderer": enable_renderer,
    }

    def _f():
        if opponent == "batbot":
            return make_batbot_opponent_env(max_steps=max_steps, seed=seed, reward=reward, **extra)
        if opponent == "probot":
            return make_probot_opponent_env(seed=seed, max_steps=max_steps, reward=reward, **extra)
        if opponent == "mixed":
            return make_mixed_opponent_env(seed=seed, max_steps=max_steps, reward=reward, **extra)
        if opponent == "league":
            return make_league_opponent_env(seed=seed, max_steps=max_steps, reward=reward, **extra)
        if opponent == "haxai":
            assert opponent_weights, "--opponent haxai requires --opponent-weights"
            return make_haxai_opponent_env(opponent_weights, max_steps=max_steps, seed=seed, reward=reward, **extra)
        return make_random_opponent_env(max_steps=max_steps, seed=seed, reward=reward, **extra)
    return _f


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-envs", type=int, default=4, help="Parallel envs")
    ap.add_argument("--vec-mode", choices=["subproc", "dummy"], default="subproc",
                    help="dummy = single-process (less overhead with HaxaiOpponent)")
    ap.add_argument("--total-timesteps", type=int, default=1_000_000)
    ap.add_argument("--max-steps", type=int, default=600, help="Max ticks per episode")
    ap.add_argument("--save-every", type=int, default=100_000)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--name", type=str, default=None, help="Run name override")
    ap.add_argument(
        "--init-from-weights",
        type=str,
        default=None,
        help="Path to HaxAI-format weights JSON to warm-start policy network",
    )
    ap.add_argument(
        "--opponent",
        choices=["random", "batbot", "probot", "mixed", "league", "haxai"],
        default="random",
        help="Opponent type: random | batbot | probot (decision tree) | haxai (NN)",
    )
    ap.add_argument(
        "--opponent-weights",
        type=str,
        default=None,
        help="Path to HaxAI-format weights JSON when --opponent haxai",
    )
    ap.add_argument(
        "--reward",
        choices=["baseline", "bugfix", "tactical", "tree"],
        default="baseline",
        help="Reward fn: baseline | bugfix | tactical | tree (full)",
    )
    ap.add_argument(
        "--stadium",
        choices=["classic", "futsal-classic", "futsal-big", "big", "luxora"],
        default="classic",
        help="Training stadium. 'luxora' uses the converted Luxora futsal map.",
    )
    ap.add_argument(
        "--kickoff-script",
        type=int,
        default=0,
        help="Run N scripted env-ticks at episode start (wall-pass attempt). 0 = off. Try 30.",
    )
    ap.add_argument(
        "--live-render",
        action="store_true",
        help="Open ursinaxball window for env 0 — watch training matches live (~30%% slower).",
    )
    args = ap.parse_args()

    run_name = args.name or f"ppo_phaseA_{int(time.time())}"
    runs_dir = Path("runs") / run_name
    ckpt_dir = Path("checkpoints") / run_name
    runs_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    # Vectorized env
    env_fns = [
        make_env_factory(
            max_steps=args.max_steps,
            seed=i,
            opponent=args.opponent,
            opponent_weights=args.opponent_weights,
            reward=args.reward,
            stadium=args.stadium,
            kickoff_script_ticks=args.kickoff_script,
            enable_renderer=(args.live_render and i == 0),  # only env 0 renders
        )
        for i in range(args.n_envs)
    ]
    if args.vec_mode == "dummy" or args.n_envs == 1:
        from stable_baselines3.common.vec_env import DummyVecEnv
        vec_env = DummyVecEnv(env_fns)
    else:
        vec_env = SubprocVecEnv(env_fns)
    vec_env = VecMonitor(vec_env, filename=str(runs_dir / "monitor.csv"))

    # PPO with HaxAI-compatible architecture: 13 → 128 → 128 (tanh) → 8 (3+3+2)
    # SB3 MlpPolicy default is tanh; net_arch=[128, 128] produces shared body.
    policy_kwargs = dict(
        net_arch=dict(pi=[128, 128], vf=[128, 128]),
        activation_fn=torch.nn.Tanh,
    )

    model = PPO(
        "MlpPolicy",
        vec_env,
        verbose=1,
        learning_rate=args.lr,
        n_steps=2048,
        batch_size=256,
        n_epochs=10,
        gamma=0.99,
        gae_lambda=0.95,
        ent_coef=0.03,
        clip_range=0.2,
        policy_kwargs=policy_kwargs,
        tensorboard_log=str(runs_dir),
    )

    if args.init_from_weights:
        from src.init_from_weights import load_haxai_weights_into
        load_haxai_weights_into(model, args.init_from_weights)

    print(f"[train] Run: {run_name}")
    print(f"[train] n_envs={args.n_envs}, target_timesteps={args.total_timesteps}")
    print(f"[train] Init: {args.init_from_weights or 'random'}")
    if args.opponent == "haxai":
        print(f"[train] Opponent: haxai({args.opponent_weights})")
    else:
        print(f"[train] Opponent: {args.opponent}")
    print(f"[train] Logs:      {runs_dir}")
    print(f"[train] Checkpoints: {ckpt_dir}")

    ckpt_cb = CheckpointCallback(
        save_freq=max(args.save_every // args.n_envs, 1),
        save_path=str(ckpt_dir),
        name_prefix="ppo",
    )

    callbacks = [ckpt_cb]

    # League self-play: hook callback to export weights JSON every N steps so
    # the env's LeagueOpponent pool grows during training.
    if args.opponent == "league":
        from src.league import LeagueCheckpointCallback
        # Find the LeagueOpponent instance in the first env (DummyVecEnv shares state)
        league_dir = "models/league_" + run_name
        # Override the league_dir of all sub-envs so they share the same pool
        for sub_env in vec_env.envs if hasattr(vec_env, "envs") else []:
            if hasattr(sub_env, "_opponent_predict") and hasattr(sub_env._opponent_predict, "_league_dir"):
                from pathlib import Path as _P
                sub_env._opponent_predict._league_dir = _P(league_dir)
                _P(league_dir).mkdir(parents=True, exist_ok=True)
        # Use first env's LeagueOpponent for the callback
        first_env = vec_env.envs[0] if hasattr(vec_env, "envs") else None
        if first_env is not None and hasattr(first_env, "_opponent_predict"):
            league_cb = LeagueCheckpointCallback(
                league=first_env._opponent_predict,
                league_dir=league_dir,
                export_freq=100_000,
                verbose=1,
            )
            callbacks.append(league_cb)
            # Sub-envs share the same league instance? With DummyVecEnv each env
            # has its own — but Python passes by reference. They're separate
            # LeagueOpponent objects. Add the callback's pool-grow to ALL of them.
            for sub_env in vec_env.envs:
                if hasattr(sub_env, "_opponent_predict") and isinstance(sub_env._opponent_predict, type(first_env._opponent_predict)):
                    # Wrap add_checkpoint so all envs see new ckpts
                    original_add = first_env._opponent_predict.add_checkpoint
                    def _broadcast_add(p, env=sub_env):
                        env._opponent_predict.add_checkpoint(p)
                    if sub_env is not first_env:
                        # Will be called manually — link via callback's add chain
                        pass
            # Simpler: monkey-patch the callback so it adds to all envs
            envs_for_pool = [e._opponent_predict for e in vec_env.envs if hasattr(e, "_opponent_predict")]
            orig = league_cb._on_step
            def _on_step_with_broadcast():
                # Original adds to first env's league, but we want all
                if league_cb.num_timesteps >= league_cb._next_export:
                    tag = f"league_{league_cb.num_timesteps:09d}.json"
                    from pathlib import Path as _P
                    path = _P(league_dir) / tag
                    league_cb._export(path)
                    for lo in envs_for_pool:
                        lo.add_checkpoint(str(path))
                    league_cb._next_export = league_cb.num_timesteps + league_cb._export_freq
                    if league_cb.verbose:
                        print(f"[league] +1 ckpt → pool size={len(envs_for_pool[0]._pool)}")
                return True
            league_cb._on_step = _on_step_with_broadcast
            print(f"[league] Self-play active: anchors={len(envs_for_pool[0]._anchors)}, export_freq=100K")

    t0 = time.time()
    model.learn(
        total_timesteps=args.total_timesteps,
        callback=callbacks,
        progress_bar=False,
        log_interval=1,
    )
    print(f"[train] Done in {time.time()-t0:.0f}s")

    final_path = ckpt_dir / "final.zip"
    model.save(final_path)
    print(f"[train] Saved final: {final_path}")


if __name__ == "__main__":
    main()
