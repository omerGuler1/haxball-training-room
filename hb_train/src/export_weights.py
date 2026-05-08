"""
Export an SB3 PPO checkpoint to JSON in HaxAI's weight format,
so the existing JS inference (nnDecision.js, joinExternal.js) can use it.

Network expected: MLP 13 → 128 → 128 → 8 with tanh activations.

Output JSON keys:
    w0: [128, 13], b0: [128]
    w1: [128, 128], b1: [128]
    w2: [8, 128], b2: [8]

Usage:
    .venv/bin/python -m src.export_weights checkpoints/ppo_phaseA_xxx/final.zip ../models/v1.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO


def _to_list(t: torch.Tensor) -> list:
    return t.detach().cpu().numpy().tolist()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint", help="Path to .zip SB3 checkpoint")
    ap.add_argument("output", help="Path to output .json (HaxAI format)")
    args = ap.parse_args()

    ckpt = Path(args.checkpoint)
    if not ckpt.exists():
        print(f"[export] Checkpoint not found: {ckpt}")
        sys.exit(1)

    print(f"[export] Loading {ckpt} ...")
    model = PPO.load(ckpt, device="cpu")

    pol = model.policy
    # SB3 MlpPolicy with shared net_arch=[128, 128] structure:
    #   policy.mlp_extractor.policy_net = Sequential(Linear(13,128), Tanh, Linear(128,128), Tanh)
    #   policy.action_net               = Linear(128, sum(MultiDiscrete.nvec)) = Linear(128, 8)
    layers = list(pol.mlp_extractor.policy_net.children())
    linears = [l for l in layers if isinstance(l, torch.nn.Linear)]
    if len(linears) != 2:
        print(f"[export] Unexpected linear count in mlp_extractor: {len(linears)}")
        print("Layers:", layers)
        sys.exit(2)
    fc1, fc2 = linears
    fc3 = pol.action_net

    expected_shapes = [(128, 13), (128, 128), (8, 128)]
    for i, (lyr, exp) in enumerate(zip([fc1, fc2, fc3], expected_shapes)):
        got = tuple(lyr.weight.shape)
        if got != exp:
            print(f"[export] Layer {i} shape mismatch: got {got}, expected {exp}")
            sys.exit(3)

    weights = {
        "w0": _to_list(fc1.weight), "b0": _to_list(fc1.bias),
        "w1": _to_list(fc2.weight), "b1": _to_list(fc2.bias),
        "w2": _to_list(fc3.weight), "b2": _to_list(fc3.bias),
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(weights, f)
    sz_kb = out.stat().st_size / 1024
    print(f"[export] Wrote {out} ({sz_kb:.1f} KB)")
    print(f"[export] Drop-in: set NN_WEIGHTS_PATH={out} in .env.1v1nn")


if __name__ == "__main__":
    main()
