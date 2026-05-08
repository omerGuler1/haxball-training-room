# hb_train — NN bot training pipeline

Self-play / RL training for the Haxball NN bot.

Architecture is locked to the **HaxAI SP_V16 layout** (13-dim obs, 128×128
tanh MLP, MultiDiscrete[3,3,2] action) so the existing JS inference
(`src/haxball/injected/nnDecision.js`, `src/external-bot/joinExternal.js`)
can drop-in load any weights file we export.

## Setup (one-time)

```bash
cd hb_train
python3.10 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Phase A — quick training (PPO vs random opponent on classic.hbs)

```bash
.venv/bin/python -m src.train --total-timesteps 1000000 --n-envs 4
```

Sane M-series defaults; ~30-45 min on M1/M2 Mac.

Watch progress:
```bash
.venv/bin/tensorboard --logdir runs/
```

## Export trained weights to JSON (HaxAI format)

```bash
.venv/bin/python -m src.export_weights checkpoints/<run>/final.zip ../models/v1_phaseA.json
```

## Deploy

Edit `.env.1v1nn` (or `.env.1v1pro` etc.):
```
NN_WEIGHTS_PATH=./models/v1_phaseA.json
```

Restart the host:
```bash
node src/index.js --env .env.1v1nn
```

## Layout

```
hb_train/
├── requirements.txt
├── README.md
└── src/
    ├── env/
    │   ├── components.py   # ObsBuilder, ActionParser, RewardFn, StateSetter
    │   └── wrapper.py      # HaxballGym → Gymnasium single-agent adapter
    ├── train.py            # PPO training entry point (Phase A: vs random)
    └── export_weights.py   # SB3 .zip → HaxAI-format weights.json
```

## Notes

* Stadium: trained on bundled `classic.hbs` (goals at x=±370). Deploy stadium
  `haxv1-v2.hbs` is essentially identical (goals at x=±373.8). Negligible
  domain gap.
* For Phase B (league self-play), swap `make_random_opponent_env` to one that
  loads a frozen policy snapshot for the opponent. The wrapper already accepts
  an `opponent_predict` callable.
* All weight files saved to `../models/` are treated as deployable artefacts.
