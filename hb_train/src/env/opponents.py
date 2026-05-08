"""
Opponents for self-play training and evaluation.

HaxaiOpponent: loads HaxAI-format weights JSON and provides a
fast pure-numpy `predict(obs) -> action` callable. Picklable for
SubprocVecEnv worker processes.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Callable

import numpy as np


class HaxaiOpponent:
    """Pure-numpy MLP inference matching HaxAI SP_V16 layout."""

    def __init__(self, weights_path: str | Path):
        p = Path(weights_path)
        with p.open() as f:
            w = json.load(f)
        self.W0 = np.asarray(w["w0"], dtype=np.float32)
        self.B0 = np.asarray(w["b0"], dtype=np.float32)
        self.W1 = np.asarray(w["w1"], dtype=np.float32)
        self.B1 = np.asarray(w["b1"], dtype=np.float32)
        self.W2 = np.asarray(w["w2"], dtype=np.float32)
        self.B2 = np.asarray(w["b2"], dtype=np.float32)
        self._path = str(p)

    def __repr__(self) -> str:
        return f"HaxaiOpponent({self._path})"

    def __call__(self, obs: np.ndarray) -> list:
        # Plain list return — avoids np.array allocation on the hot path.
        h1 = np.tanh(self.W0 @ obs + self.B0)
        h2 = np.tanh(self.W1 @ h1 + self.B1)
        lg = self.W2 @ h2 + self.B2
        return [
            int(lg[0:3].argmax()),
            int(lg[3:6].argmax()),
            int(lg[6:8].argmax()),
        ]


class MixedOpponent:
    """Randomly select one opponent per __call__ session.

    To rotate per-episode (not per-tick), the env wrapper resets this
    by calling .new_episode() at the start of each reset.
    """
    def __init__(self, opponents: list, weights: list[float] | None = None, seed: int = 0):
        self._opps = opponents
        self._weights = weights if weights else [1.0] * len(opponents)
        self._rng = random.Random(seed)
        self._current = self._pick()

    def __repr__(self) -> str:
        return f"MixedOpponent({[type(o).__name__ for o in self._opps]})"

    def _pick(self):
        total = sum(self._weights)
        r = self._rng.random() * total
        cum = 0.0
        for o, w in zip(self._opps, self._weights):
            cum += w
            if r <= cum:
                return o
        return self._opps[-1]

    def new_episode(self):
        # Reset internal stateful opponents (BatBot/ProBot have step counters)
        self._current = self._pick()
        for attr in ("_step", "_last_kick_step"):
            if hasattr(self._current, attr):
                setattr(self._current, attr, 0 if attr == "_step" else -100)

    def __call__(self, obs):
        return self._current(obs)


def make_random_predict() -> Callable[[np.ndarray], np.ndarray]:
    """Falls back to random ax/ay/kick."""
    rng = np.random.default_rng()
    def _rand(_obs):
        return np.array([rng.integers(0, 3), rng.integers(0, 3), rng.integers(0, 2)], dtype=np.int64)
    return _rand


class BatBotOpponent:
    """JS-style chase+kick rule bot.

    epsilon: probability of random action each tick (default 0). Use 0.05–0.10
    in training to add trajectory variance against deterministic agents.
    """
    """
    Faithful Python port of the JS rule-based bot at
    src/haxball/injected/decision.js — chase ball with 2.5-tick velocity
    lead, kick when close + off-cooldown, dead-zone snap to cardinal axes.

    Operates on the same 13-dim POV-corrected obs vector our agent sees,
    so it works for either team (Match auto-mirrors action[0] for blue).

    Constants chosen to match the JS bot the user has been deploying:
        KICK_COOLDOWN_TICKS = 18 → ~5 env-steps at tick_skip=4
        CONTROL_DIST        = 28
        DEAD_ZONE           = 0.22
        LEAD_TICKS          = 2.5
    """

    # Match obs normalisation in HaxAI13Obs
    _FW2 = 736.0
    _FH2 = 342.0
    _MAX_VEL = 15.0

    KICK_COOLDOWN_STEPS = 5    # env.steps (each ~5 game ticks)
    CONTROL_DIST = 28.0
    DEAD_ZONE = 0.22
    LEAD_TICKS = 2.5

    def __init__(self, epsilon: float = 0.0, seed: int = 0):
        self._last_kick_step = -100
        self._step = 0
        self._epsilon = float(epsilon)
        self._rng = random.Random(seed) if epsilon > 0 else None

    def __repr__(self) -> str:
        return f"BatBotOpponent(epsilon={self._epsilon})"

    def __call__(self, obs):
        # ε-random: small chance of fully random action for trajectory diversity
        if self._rng is not None and self._rng.random() < self._epsilon:
            self._step += 1
            return [self._rng.randint(0, 2), self._rng.randint(0, 2), self._rng.randint(0, 1)]

        # Denormalize relevant fields back to absolute scale
        rel_ball_dx = obs[2] * self._FW2
        rel_ball_dy = obs[3] * self._FH2
        ball_vel_x  = obs[4] * self._MAX_VEL
        ball_vel_y  = obs[5] * self._MAX_VEL
        can_kick    = obs[8] > 0

        # Aim where the ball WILL be in ~2.5 ticks (lead)
        aim_dx = rel_ball_dx + ball_vel_x * self.LEAD_TICKS
        aim_dy = rel_ball_dy + ball_vel_y * self.LEAD_TICKS

        mag = (aim_dx * aim_dx + aim_dy * aim_dy) ** 0.5
        if mag > 1e-6:
            nx = aim_dx / mag
            ny = aim_dy / mag
        else:
            nx = ny = 0.0

        # Snap to cardinal directions outside the dead zone
        ax = 1 if abs(nx) < self.DEAD_ZONE else (2 if nx > 0 else 0)
        ay = 1 if abs(ny) < self.DEAD_ZONE else (2 if ny > 0 else 0)

        # Kick when in control distance AND cooldown elapsed
        ball_dist = (rel_ball_dx * rel_ball_dx + rel_ball_dy * rel_ball_dy) ** 0.5
        in_control = ball_dist < self.CONTROL_DIST
        off_cd = (self._step - self._last_kick_step) >= self.KICK_COOLDOWN_STEPS
        kk = 1 if (in_control and off_cd and can_kick) else 0
        if kk:
            self._last_kick_step = self._step
        self._step += 1

        return [ax, ay, kk]


class ProBotOpponent:
    """
    Faithful port of the user's intuitive decision tree.
    Operates on POV-corrected obs (forward = +x). Match.parse_actions handles
    the POV→absolute flip for the Blue side.

    Decision tree (verbatim from user):
      A. Top bizdeyse (we have ball):
         A1. Kaleye yol açık mı?
             açık: opp half'tayım → hizala+şut, değilim → top+bot'u opp half'a taşı
             kapalı: opp <100px → duvardan dolaş, değil → kaleye yaklaş + jitter
      B. Top bizde değilse:
         B.a. Rakipte top:
              own half'tayım → 75% hattına git
              opp half'tayım → hafif açılı yaklaş + sapma
         B.b. Loose ball:
              rakip yakın + retreat lazım → kale ortasına git
              rakip yakın + retreat değil → kovala
              biz yakın + opp <200 + retreat → kovala + duvar bouncenı dene
              biz yakın + opp <200 + retreat değil → kovala + spam kick
              biz yakın + opp uzak → topu al, opp half'a yönlendir
    """

    # Field constants (classic.hbs half-extents)
    _FW2 = 736.0
    _FH2 = 342.0
    _MAX_VEL = 15.0
    _FIELD_W = 370.0
    _FIELD_H = 171.0

    # Tree thresholds
    POSSESSION_DIST     = 35.0    # bot/opp considered to "have" ball if within
    OPP_NEAR            = 100.0   # for "rakip 100px içinde"
    OPP_DANGER          = 200.0   # for "rakip 200px içinde"
    PATH_CLEAR_PERP     = 35.0    # opp must be > this from (ball, opp_goal) line for clear shot
    DEFENSIVE_LINE_PCT  = 0.75    # B.a — 75% way from own goal toward opp ball
    APPROACH_ANGLE_OFF  = 25.0    # B.a opp_half — slight-angle approach offset
    DEAD_ZONE           = 0.22
    KICK_COOLDOWN_STEPS = 5

    def __init__(self, seed: int = 0):
        self._last_kick_step = -100
        self._step = 0
        self._rng = random.Random(seed)

    def __repr__(self) -> str:
        return "ProBotOpponent(decision-tree rule bot)"

    # Geometry helper: perpendicular distance from point P to segment A→B
    @staticmethod
    def _perp_to_seg(px, py, ax, ay, bx, by):
        vx, vy = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        L2 = vx * vx + vy * vy
        if L2 < 1e-6:
            return math.hypot(wx, wy), 0.0
        t = max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
        cx, cy = ax + t * vx, ay + t * vy
        return math.hypot(px - cx, py - cy), t

    def __call__(self, obs):
        # Denormalize POV-corrected obs to absolute distances
        ball_dx = obs[2] * self._FW2     # ball−bot, POV (+ = forward)
        ball_dy = obs[3] * self._FH2
        ball_vx = obs[4] * self._MAX_VEL
        ball_vy = obs[5] * self._MAX_VEL
        goal_dx = obs[6] * self._FW2     # opp_goal−bot, POV (always >0 generally)
        bot_y   = -obs[7] * self._FH2
        can_kick = obs[8] > 0
        opp_dx  = obs[9] * self._FW2
        opp_dy  = obs[10] * self._FH2

        # POV-space coordinates: +x = toward opp goal, own goal at -FIELD_W
        bot_pov_x = self._FIELD_W - goal_dx
        ball_pov_x = bot_pov_x + ball_dx
        ball_y = bot_y + ball_dy
        opp_pov_x = bot_pov_x + opp_dx
        opp_y = bot_y + opp_dy

        # Distances + state predicates
        ball_dist = math.hypot(ball_dx, ball_dy)
        opp_dist  = math.hypot(opp_dx, opp_dy)
        opp_to_ball = math.hypot(opp_pov_x - ball_pov_x, opp_y - ball_y)

        we_have    = ball_dist   < self.POSSESSION_DIST
        opp_has    = opp_to_ball < self.POSSESSION_DIST
        bot_in_own = bot_pov_x   < 0.0
        ball_in_own = ball_pov_x < 0.0
        ball_in_opp = ball_pov_x > 0.0

        # Default: stand still
        target_x, target_y = bot_pov_x, bot_y
        kick_intent = False

        # ── DURUM A: Top bizde ─────────────────────────────
        if we_have:
            opp_goal_x, opp_goal_y = self._FIELD_W, 0.0
            perp, _ = self._perp_to_seg(opp_pov_x, opp_y,
                                        ball_pov_x, ball_y,
                                        opp_goal_x, opp_goal_y)
            path_clear = perp > self.PATH_CLEAR_PERP

            if path_clear:
                if ball_in_opp:
                    # A1.evet.opp_half: hizala + şut
                    # Hizalama = bot.y'yi kale yüksekliğinin merkezine yaklaştır
                    target_x = ball_pov_x + 30      # topu it
                    target_y = 0.0                   # kale orta y
                    kick_intent = True
                else:
                    # A1.evet.own_half: top+bot'u opp sahasına taşı
                    target_x = ball_pov_x + 80
                    target_y = ball_y * 0.6          # merkeze çek
            else:
                if opp_dist < self.OPP_NEAR:
                    # A1.hayır.opp<100: duvardan dolaş
                    # En uzak yatay duvarı bul (opp'un karşı tarafı)
                    if opp_dy > 0:                  # opp aşağıda → üst duvarı kullan
                        target_y = -self._FIELD_H * 0.7
                    else:
                        target_y = +self._FIELD_H * 0.7
                    target_x = ball_pov_x + 40
                else:
                    # A1.hayır.opp>=100: kaleye yaklaş + jitter
                    target_x = ball_pov_x + 70
                    jitter = (self._rng.random() - 0.5) * 40
                    target_y = ball_y + jitter

        # ── DURUM B: Top bizde değil ───────────────────────
        elif opp_has:
            # B.a: rakipte top
            if ball_in_own:
                # B.a.own_half: 75% defansif hatta
                own_goal_x = -self._FIELD_W
                target_x = own_goal_x + (ball_pov_x - own_goal_x) * self.DEFENSIVE_LINE_PCT
                target_y = ball_y * self.DEFENSIVE_LINE_PCT
            else:
                # B.a.opp_half: hafif açılı yaklaş + sapma
                offset = self.APPROACH_ANGLE_OFF if ball_y >= 0 else -self.APPROACH_ANGLE_OFF
                target_x = ball_pov_x - 20         # arkadan yaklaş
                target_y = ball_y + offset
        else:
            # B.b: loose ball — kim daha yakın?
            we_closer = ball_dist < opp_to_ball
            need_retreat = ball_pov_x < bot_pov_x  # top bot'un arkasında (own goal yönünde)

            if not we_closer:
                if need_retreat:
                    # B.b.opp_yakın.retreat: kale ortasına git
                    target_x = -self._FIELD_W + 35
                    target_y = 0.0
                else:
                    # B.b.opp_yakın.normal: kovala
                    target_x = ball_pov_x
                    target_y = ball_y
            else:
                if opp_dist < self.OPP_DANGER:
                    if need_retreat:
                        # B.b.biz_yakın.tehlike.retreat: kovala + duvar bouncenı dene
                        # Basit: topu kovala + kick (top kale uzağına gitsin diye yan-üst hedefle)
                        target_x = ball_pov_x
                        target_y = ball_y - math.copysign(15, ball_y or 1)
                        kick_intent = True
                    else:
                        # B.b.biz_yakın.tehlike.normal: kovala + spam kick
                        target_x = ball_pov_x
                        target_y = ball_y
                        kick_intent = True
                else:
                    # B.b.biz_yakın.opp_uzak: topu al, opp half'a yönlendir
                    target_x = ball_pov_x + 40
                    target_y = ball_y * 0.5

        # Clamp targets to field
        target_x = max(-self._FIELD_W, min(self._FIELD_W, target_x))
        target_y = max(-self._FIELD_H, min(self._FIELD_H, target_y))

        # ── Movement: target → POV-direction action ─────────
        dx = target_x - bot_pov_x
        dy = target_y - bot_y
        mag = math.hypot(dx, dy)
        if mag > 1e-6:
            nx, ny = dx / mag, dy / mag
        else:
            nx = ny = 0.0

        ax = 1 if abs(nx) < self.DEAD_ZONE else (2 if nx > 0 else 0)
        ay = 1 if abs(ny) < self.DEAD_ZONE else (2 if ny > 0 else 0)

        # Kick gating: cooldown + can_kick
        off_cd = (self._step - self._last_kick_step) >= self.KICK_COOLDOWN_STEPS
        kk = 1 if (kick_intent and off_cd and can_kick) else 0
        if kk:
            self._last_kick_step = self._step
        self._step += 1

        return [ax, ay, kk]
