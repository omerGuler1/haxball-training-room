"""
Load HaxAI-format weights JSON into an SB3 PPO model's policy network.

Architecture must match: 13 → 128 (tanh) → 128 (tanh) → 8 (logits)
Weight keys expected: w0 [128×13], b0 [128], w1 [128×128], b1 [128], w2 [8×128], b2 [8]

The PPO model has a SEPARATE value head (mlp_extractor.value_net + value_net),
which we leave at random init — PPO will train it within ~100K steps.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO


def load_haxai_weights_into(model: PPO, weights_path: str | Path) -> None:
    """
    Mutates the model's policy network in place. Call AFTER constructing PPO,
    BEFORE model.learn().
    """
    p = Path(weights_path)
    with p.open() as f:
        w = json.load(f)

    # Sanity-check shapes
    expected = {
        "w0": (128, 13), "b0": (128,),
        "w1": (128, 128), "b1": (128,),
        "w2": (8, 128), "b2": (8,),
    }
    for k, exp in expected.items():
        arr = np.asarray(w[k])
        if arr.shape != exp:
            raise ValueError(f"weight '{k}' shape {arr.shape} != expected {exp}")

    pol = model.policy
    layers = list(pol.mlp_extractor.policy_net.children())
    linears = [l for l in layers if isinstance(l, torch.nn.Linear)]
    if len(linears) != 2:
        raise RuntimeError(f"Expected 2 Linear layers in policy_net, got {len(linears)}")
    fc1, fc2 = linears
    fc3 = pol.action_net

    with torch.no_grad():
        fc1.weight.copy_(torch.tensor(w["w0"], dtype=fc1.weight.dtype))
        fc1.bias.copy_(torch.tensor(w["b0"], dtype=fc1.bias.dtype))
        fc2.weight.copy_(torch.tensor(w["w1"], dtype=fc2.weight.dtype))
        fc2.bias.copy_(torch.tensor(w["b1"], dtype=fc2.bias.dtype))
        fc3.weight.copy_(torch.tensor(w["w2"], dtype=fc3.weight.dtype))
        fc3.bias.copy_(torch.tensor(w["b2"], dtype=fc3.bias.dtype))

    print(f"[init] Loaded HaxAI weights from {p} into policy network.")
    print(f"[init] Value head left at random init (PPO will learn it).")
