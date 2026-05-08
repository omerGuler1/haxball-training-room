"""
Custom HaxballGym components for our pipeline.
Observation/action shapes deliberately match HaxAI SP_V16 so the same JS
inference (`nnDecision.js`, `joinExternal.js`) consumes our exported weights.

obs   : 13-dim float, all clipped to [-1, 1]
action: MultiDiscrete([3, 3, 2]) — ax, ay, kick
"""
from __future__ import annotations

import numpy as np
import gym.spaces

from ursinaxball.modules import PlayerHandler
from ursinaxball.common_values import TeamID
from haxballgym.utils.gamestates import GameState
from haxballgym.utils.obs_builders import ObsBuilder
from haxballgym.utils.action_parsers import ActionParser
from haxballgym.utils.reward_functions import RewardFunction
from haxballgym.utils.state_setters import StateSetter
from haxballgym.utils.state_setters.default_state import DefaultState
from haxballgym.utils.terminal_conditions import TerminalCondition
from ursinaxball import Game


# ── Custom stadium loader ─────────────────────────────
# ursinaxball.Game.load_map() only accepts BaseMap enums (bundled stadiums).
# This helper converts a Haxball-format .hbs file (with `ballPhysics: "disc0"`
# string refs and missing `traits`) to ursinaxball's expected schema, then
# attaches it to a Game instance.
def load_custom_stadium(game: "Game", hbs_path: str) -> None:
    import copy
    import json
    import json5
    from ursinaxball.objects.stadium_object import Stadium
    import ursinaxball
    from pathlib import Path

    pkg_dir = Path(ursinaxball.__file__).parent
    classic_path = pkg_dir / "stadiums" / "classic.json5"
    classic = json5.load(open(classic_path))

    with open(hbs_path) as f:
        data = json.load(f)

    # Convert ballPhysics string ref ("disc0") into inline dict, drop that disc.
    if isinstance(data.get("ballPhysics"), str):
        ref = data["ballPhysics"]
        if ref.startswith("disc"):
            idx = int(ref[4:])
            data["ballPhysics"] = copy.deepcopy(data["discs"][idx])
            data["discs"] = data["discs"][:idx] + data["discs"][idx + 1:]

    # Same for playerPhysics.
    if isinstance(data.get("playerPhysics"), str):
        data["playerPhysics"] = copy.deepcopy(classic.get("playerPhysics", {}))

    # Borrow traits if missing (Luxora references standard trait names).
    if "traits" not in data:
        data["traits"] = copy.deepcopy(classic.get("traits", {}))

    # ursinaxball renderer expects 6-char hex colors. Some Haxball stadiums use
    # short codes like "0" (meaning transparent/black). Pad to 6 chars.
    def _fix_color(c):
        if not isinstance(c, str):
            return "FFFFFF"
        c = c.strip()
        if len(c) == 0:
            return "FFFFFF"
        if len(c) < 6:
            return c.rjust(6, "0")
        if len(c) > 6:
            return c[:6]
        return c

    for d in data.get("discs", []):
        if "color" in d:
            d["color"] = _fix_color(d["color"])
    for s in data.get("segments", []):
        if "color" in s:
            s["color"] = _fix_color(s["color"])
    if isinstance(data.get("ballPhysics"), dict) and "color" in data["ballPhysics"]:
        data["ballPhysics"]["color"] = _fix_color(data["ballPhysics"]["color"])

    stadium = Stadium(data)
    game.stadium_file = hbs_path
    game.stadium_store = stadium
    game.stadium_game = copy.deepcopy(stadium)

# ── Constants matching HaxAI SP_V16 normalization ───────────────────
# classic.hbs goal x = 370 → use as FIELD_W (HaxAI used 368, near-identical).
FIELD_W = 370.0
FIELD_H = 170.0
MAX_VEL = 15.0
FW2 = FIELD_W * 2.0
FH2 = FIELD_H * 2.0
KICK_RANGE_APPROX = 35.0


# ── Observation: 13 floats, POV-corrected (Blue mirrors x) ──────────
class HaxAI13Obs(ObsBuilder):
    """Mirror of HaxAI selfplay_env._get_obs() — 13 normalized floats."""

    def reset(self, initial_state: GameState):
        pass

    def build_obs(
        self, player: PlayerHandler, state: GameState, previous_action: np.ndarray
    ) -> np.ndarray:
        # dir_mult: blue agent observes the world flipped on x (POV symmetry trick)
        dm = -1.0 if player.team == TeamID.BLUE else 1.0
        goal_x = FIELD_W * dm

        ball_pos = state.ball.position
        ball_vel = state.ball.velocity
        bot_pos = player.disc.position
        bot_vel = player.disc.velocity

        # Find opponent (1v1 only — first non-self player)
        opp = next(
            (p for p in state.players if p.id != player.id and p.team != player.team),
            None,
        )
        if opp is not None:
            opp_pos = opp.disc.position
            opp_vel = opp.disc.velocity
        else:
            opp_pos = np.zeros(2)
            opp_vel = np.zeros(2)

        dx = ball_pos[0] - bot_pos[0]
        dy = ball_pos[1] - bot_pos[1]
        dist_to_ball = float(np.hypot(dx, dy))
        can_kick = 1.0 if dist_to_ball < KICK_RANGE_APPROX else -1.0

        def nc(v: float, m: float) -> float:
            return float(np.clip(v / m, -1.0, 1.0))

        return np.array([
            nc(bot_vel[0] * dm,             MAX_VEL),
            nc(bot_vel[1],                  MAX_VEL),
            nc(dx * dm,                     FW2),
            nc(dy,                          FH2),
            nc(ball_vel[0] * dm,            MAX_VEL),
            nc(ball_vel[1],                 MAX_VEL),
            nc((goal_x - bot_pos[0]) * dm,  FW2),
            nc(0.0 - bot_pos[1],            FH2),
            can_kick,
            nc((opp_pos[0] - bot_pos[0]) * dm, FW2),
            nc(opp_pos[1] - bot_pos[1],        FH2),
            nc(opp_vel[0] * dm,                MAX_VEL),
            nc(opp_vel[1],                     MAX_VEL),
        ], dtype=np.float32)


# ── Action: MultiDiscrete[3, 3, 2] → ursinaxball [right, up, kick] ───
# Policy outputs per player: [ax_idx, ay_idx, kk_idx] ∈ [3, 3, 2].
# ursinaxball expects [right_value, up_value, kick] where
#   right_value > 0 → +x acceleration (right)
#   up_value    > 0 → +y acceleration (down in screen convention; "up" name is misleading)
#   kick: 0/1
# Match.parse_actions auto-flips action[0] for blue (POV symmetry).
class MD332ActionParser(ActionParser):
    NUM_ACTIONS = 3  # right, up, kick — ursinaxball's per-player vector size

    def get_action_space(self):
        return gym.spaces.MultiDiscrete([3, 3, 2])

    def parse_actions(self, actions, state):
        # Agents emit POV-corrected actions (ax=2 = forward in agent's POV).
        # NOTE: HaxballGym Match.parse_actions internally negates action[0] for
        # Blue players (envs/match.py:~123 — `action[0] = action[0] * -1`), so
        # we MUST NOT add a second flip here. Just convert MultiDiscrete bins
        # to ursinaxball's per-axis [-1, 0, +1] / [0, 1] floats.
        actions = np.asarray(actions).reshape(-1, self.NUM_ACTIONS).astype(np.float32)
        out = np.zeros_like(actions, dtype=np.float32)
        out[..., 0] = actions[..., 0] - 1.0                        # ax: 0/1/2 → -1/0/+1
        out[..., 1] = actions[..., 1] - 1.0                        # ay: 0/1/2 → -1/0/+1
        out[..., 2] = (actions[..., 2] == 1).astype(np.float32)    # kick boolean
        return out


# ── Reward: Phase A baseline — dense shaping for sparse-goal bootstrapping ──
# Dense terms get the bot to FIND and CHASE the ball; goal terms shape strategy.
class BaselineReward(RewardFunction):
    """
    Per-tick (dense):
      -0.005 × dist(bot, ball)/FIELD_W       ← chase the ball
      +0.05  × normalized ball_vx_toward_opp ← reward pushing ball toward opp goal
      -0.05  × normalized ball_vx_toward_own ← penalize letting ball roll to our goal
    Terminal:
      +10 on goal scored, -10 on goal conceded
    """

    def __init__(self, opponent_goal_x: float = FIELD_W):
        super().__init__()
        self.opponent_goal_x = opponent_goal_x
        self._last_score = (0, 0)  # (red_score, blue_score)

    def reset(self, initial_state: GameState):
        self._last_score = (0, 0)

    def get_reward(
        self, player: PlayerHandler, state: GameState, previous_action: np.ndarray
    ) -> float:
        opp_goal_x = self.opponent_goal_x if player.team == TeamID.RED else -self.opponent_goal_x

        bot_pos = player.disc.position
        ball_pos = state.ball.position
        ball_vel = state.ball.velocity

        dx = ball_pos[0] - bot_pos[0]
        dy = ball_pos[1] - bot_pos[1]
        dist_to_ball = float(np.hypot(dx, dy))
        chase = -0.005 * (dist_to_ball / FIELD_W)

        bvx = float(ball_vel[0])
        toward_opp_speed = (bvx if opp_goal_x > 0 else -bvx) / MAX_VEL
        ball_progress = 0.05 * toward_opp_speed

        return chase + ball_progress

    def get_final_reward(
        self, player: PlayerHandler, state: GameState, previous_action: np.ndarray
    ) -> float:
        # Terminal reward — large goal/conceded signal.
        red, blue = int(state.red_score), int(state.blue_score)
        if player.team == TeamID.RED:
            my, opp = red, blue
            prev_my, prev_opp = self._last_score
        else:
            my, opp = blue, red
            prev_opp, prev_my = self._last_score
        self._last_score = (red, blue)
        scored = max(0, my - prev_my)
        conceded = max(0, opp - prev_opp)
        return 10.0 * scored - 10.0 * conceded


# ── Tree-aware reward: soft guidance toward ProBot-style behaviour. ──
# Designed to fix observed BatNN bugs (own goals, ignoring loose ball,
# spam-kick while running) without making the bot a deterministic clone.
class TreeAwareReward(RewardFunction):
    """
    Per-tick (dense), additive:
      base:              -0.005 × dist(bot, ball)/FIELD_W           ← chase ball
                         +0.05  × ball_vx_toward_opp_goal           ← progress

    Bug fixes (observed BatNN issues):
      anti-spam-kick:    -0.10 if kick && dist(bot, ball) > 50
      loose-ball urgency: +0.02 × (1 - dist/FIELD_W) when loose ball + we closer
      anti-own-goal:     -0.50 if kick + ball moving toward own goal

    Tree-aligned shaping (from user's decision tree):
      defensive line:    +0.05/tick if opp has ball + bot near (ball, own_goal) line
      open shot:         +0.30 if we have ball + opp half + opp >100 + kick
      forward push:      +0.05 × fwd_speed when we have ball in own half
      wall-pass hint:    +0.05/tick when ball near side wall + moving forward
      angled approach:   +0.01/tick when opp has ball + bot offset y from ball

    Terminal:
      +10 on goal scored, -10 on goal conceded
    """

    POSSESSION_DIST = 35.0

    # Term groups gated by `level`:
    #   0 = baseline only (chase + progress + goal)
    #   1 = + bug fixes (anti-spam-kick, anti-own-goal, loose-ball urgency)
    #   2 = + tactical shaping (defensive line, open shot, forward push, anti-stall)
    #   3 = + advanced (wall-pass-to-self, angled approach)
    LEVEL_BUG_FIXES = 1
    LEVEL_TACTICAL  = 2
    LEVEL_ADVANCED  = 3

    def __init__(self, level: int = 3):
        super().__init__()
        self.level = int(level)
        self._last_score = (0, 0)
        # Touch tracking (for quick-goal penalty / multi-touch bonus, LEVEL_BUG_FIXES+)
        self._our_touches = 0
        self._prev_ball_speed = 0.0
        # Anti-hover: counts consecutive ticks the ball is stationary
        self._stationary_ticks = 0
        # Temporal tracking for wall-bounce detection (updated once per tick)
        self._prev_bvx = 0.0
        self._prev_bvy = 0.0
        self._prev_bx = 0.0
        self._prev_by = 0.0
        self._wall_bounce_tick = -100
        self._kick_by_us_tick = -100
        self._tick = 0

    def reset(self, initial_state: GameState):
        self._last_score = (0, 0)
        self._prev_bvx = float(initial_state.ball.velocity[0])
        self._prev_bvy = float(initial_state.ball.velocity[1])
        self._prev_bx = float(initial_state.ball.position[0])
        self._prev_by = float(initial_state.ball.position[1])
        self._wall_bounce_tick = -100
        self._kick_by_us_tick = -100
        self._tick = 0
        self._our_touches = 0
        self._prev_ball_speed = 0.0
        self._stationary_ticks = 0

    def get_reward(
        self, player: PlayerHandler, state: GameState, previous_action: np.ndarray
    ) -> float:
        is_red = player.team == TeamID.RED
        dir_sign = 1.0 if is_red else -1.0
        own_goal_x = -FIELD_W if is_red else FIELD_W
        opp_goal_x = FIELD_W if is_red else -FIELD_W

        bot_pos = player.disc.position
        ball_pos = state.ball.position
        ball_vel = state.ball.velocity

        opp = next(
            (p for p in state.players if p.id != player.id and p.team != player.team),
            None,
        )
        opp_pos = opp.disc.position if opp is not None else np.array([0.0, 0.0])

        # Distances + state predicates
        bot_to_ball = float(np.hypot(ball_pos[0] - bot_pos[0], ball_pos[1] - bot_pos[1]))
        opp_to_ball = float(np.hypot(opp_pos[0] - ball_pos[0], opp_pos[1] - ball_pos[1]))
        we_have = bot_to_ball < self.POSSESSION_DIST
        opp_has = opp_to_ball < self.POSSESSION_DIST
        we_closer = bot_to_ball < opp_to_ball
        ball_in_opp_half = (ball_pos[0] * dir_sign) > 0
        bot_in_own_half = (bot_pos[0] * dir_sign) < 0
        ball_in_own_half = (ball_pos[0] * dir_sign) < 0

        # Action info — previous_action is [right_value, up_value, kick] from parser
        kick_pressed = False
        if previous_action is not None and len(previous_action) >= 3:
            kick_pressed = bool(previous_action[2] > 0.5)

        # ── Base shaping ────────────────────────────────
        # Proximity: positive when close, negative when far.
        # GATED on ball motion: hovering near a stationary ball gets NO reward
        # (prevents "stand near ball forever" collapse).
        ball_speed = float(np.hypot(ball_vel[0], ball_vel[1]))
        ball_moving = ball_speed > 0.5
        if ball_moving:
            proximity = 0.005 * (1.0 - 2.0 * min(1.0, bot_to_ball / FIELD_W))
        else:
            # When ball is stationary, only penalize being far (no positive cap).
            proximity = -0.005 * min(1.0, bot_to_ball / FIELD_W)
        bvx_toward_opp = (ball_vel[0] if opp_goal_x > 0 else -ball_vel[0]) / MAX_VEL
        ball_progress = 0.05 * float(np.clip(bvx_toward_opp, -1.0, 1.0))
        r = proximity + ball_progress

        # Anti-stall (LEVEL_TACTICAL+) — penalize "do nothing" policy collapse
        if self.level >= self.LEVEL_TACTICAL and previous_action is not None and len(previous_action) >= 2:
            moving = (abs(float(previous_action[0])) + abs(float(previous_action[1]))) > 0.5
            if not moving:
                r -= 0.05

        # Anti-hover (LEVEL_BUG_FIXES+) — track ball stationary streak
        # If ball has been still for 30+ ticks AND bot is hovering close to it,
        # bot is just farming proximity. Penalize.
        if self.level >= self.LEVEL_BUG_FIXES and player.id == 0:
            if ball_speed < 0.5:
                self._stationary_ticks += 1
            else:
                self._stationary_ticks = 0
        if self.level >= self.LEVEL_BUG_FIXES and self._stationary_ticks > 30 and bot_to_ball < 60:
            r -= 0.05

        # ── Bug fix #1: anti-spam-kick (LEVEL_BUG_FIXES+) ──
        if self.level >= self.LEVEL_BUG_FIXES and kick_pressed and bot_to_ball > 50.0:
            r -= 0.10

        # ── Bug fix #1b: anti-phantom-kick (LEVEL_BUG_FIXES+) ──
        # Bot pressed kick close to ball but ball didn't accelerate = "fake kick"
        # exploit. Penalize so bot can't farm proximity reward by hovering+pressing.
        if self.level >= self.LEVEL_BUG_FIXES and kick_pressed and bot_to_ball < 50.0:
            if ball_speed - self._prev_ball_speed < 1.0:
                r -= 0.05

        # ── Bug fix #2: loose-ball urgency (LEVEL_BUG_FIXES+) ──
        if self.level >= self.LEVEL_BUG_FIXES and (not we_have) and (not opp_has) and we_closer:
            r += 0.02 * (1.0 - min(1.0, bot_to_ball / FIELD_W))

        # ── Bug fix #3: anti-own-goal kick (LEVEL_BUG_FIXES+) ──
        if self.level >= self.LEVEL_BUG_FIXES and kick_pressed and bot_to_ball < 50.0:
            ball_to_own = (ball_vel[0] * dir_sign) < 0
            if ball_to_own and abs(ball_vel[0]) > 2.0:
                r -= 0.50

        # ── Tree term: defensive 75% line (LEVEL_TACTICAL+) ─
        if self.level >= self.LEVEL_TACTICAL and opp_has and (bot_in_own_half or ball_in_own_half):
            # Project bot onto the (ball → own_goal) line; reward if near it AND
            # at 50–90 % of the way (so we're not glued to the goal nor to the ball).
            line_dx = own_goal_x - ball_pos[0]
            line_dy = 0.0 - ball_pos[1]
            line_len_sq = line_dx * line_dx + line_dy * line_dy
            if line_len_sq > 1e-6:
                rel_x = bot_pos[0] - ball_pos[0]
                rel_y = bot_pos[1] - ball_pos[1]
                t = (rel_x * line_dx + rel_y * line_dy) / line_len_sq
                t_c = max(0.0, min(1.0, t))
                proj_x = ball_pos[0] + t_c * line_dx
                proj_y = ball_pos[1] + t_c * line_dy
                perp = float(np.hypot(bot_pos[0] - proj_x, bot_pos[1] - proj_y))
                if perp < 50.0 and 0.5 < t_c < 0.9:
                    r += 0.05

        # ── Tree term: open shot (LEVEL_TACTICAL+) ───────
        if self.level >= self.LEVEL_TACTICAL and we_have and ball_in_opp_half and opp_to_ball > 100.0 and kick_pressed:
            r += 0.30

        # ── Tree term: forward push (LEVEL_TACTICAL+) ────
        if self.level >= self.LEVEL_TACTICAL and we_have and ball_in_own_half:
            fwd_speed = (ball_vel[0] if opp_goal_x > 0 else -ball_vel[0]) / MAX_VEL
            if fwd_speed > 0:
                r += 0.05 * float(np.clip(fwd_speed, 0.0, 1.0))

        # ── Tree term: wall-pass hint (LEVEL_ADVANCED+) ──
        ball_y = float(ball_pos[1])
        ball_vx = float(ball_vel[0])
        if self.level >= self.LEVEL_ADVANCED:
            near_side_wall = abs(ball_y) > 140.0
            forward_speed = (ball_vx if opp_goal_x > 0 else -ball_vx)
            if near_side_wall and forward_speed > 2.0:
                r += 0.05

        # ── Tree term: angled approach (LEVEL_ADVANCED+) ─
        in_chase_range = 30.0 < bot_to_ball < 150.0
        if self.level >= self.LEVEL_ADVANCED and opp_has and not we_have and in_chase_range:
            y_offset = abs(float(bot_pos[1]) - ball_y)
            if y_offset > 20.0:
                r += 0.01

        # ── Touch detection + per-touch bonus (LEVEL_BUG_FIXES+) ──
        # Count our touches: bot very close to ball + ball just gained speed.
        # Each touch awards +0.20 — incentivizes long rallies / dribbling.
        if self.level >= self.LEVEL_BUG_FIXES and player.id == 0:
            cur_speed = float(np.hypot(ball_vel[0], ball_vel[1]))
            if bot_to_ball < 25.0 and cur_speed > self._prev_ball_speed + 1.0:
                self._our_touches += 1
                r += 0.20   # per-touch bonus — reward extended play, not 1-shot exploits
            self._prev_ball_speed = cur_speed

        # ── Wall-pass-to-self (LEVEL_ADVANCED+) ──────────
        if self.level >= self.LEVEL_ADVANCED:
            cur_bvx = float(ball_vel[0]); cur_bvy = float(ball_vel[1])
            cur_bx  = float(ball_pos[0]); cur_by  = float(ball_pos[1])
            if player.id == 0:
                vy_flip = self._prev_bvy * cur_bvy < -0.5 and abs(self._prev_by) > 145.0
                vx_flip = self._prev_bvx * cur_bvx < -0.5 and abs(self._prev_bx) > 350.0
                if vy_flip or vx_flip:
                    self._wall_bounce_tick = self._tick
                self._prev_bvx, self._prev_bvy = cur_bvx, cur_bvy
                self._prev_bx, self._prev_by = cur_bx, cur_by
                self._tick += 1
            ticks_since_bounce = self._tick - self._wall_bounce_tick
            if 0 < ticks_since_bounce < 25 and bot_to_ball < 60.0:
                r += 0.20

        return float(r)

    def get_final_reward(
        self, player: PlayerHandler, state: GameState, previous_action: np.ndarray
    ) -> float:
        red, blue = int(state.red_score), int(state.blue_score)
        if player.team == TeamID.RED:
            my, opp = red, blue
            prev_my, prev_opp = self._last_score
        else:
            my, opp = blue, red
            prev_opp, prev_my = self._last_score
        self._last_score = (red, blue)
        scored = max(0, my - prev_my)
        conceded = max(0, opp - prev_opp)

        goal_reward = 10.0 * scored

        # LEVEL_BUG_FIXES+: penalize 1-touch goals AND too-quick goals.
        # The user wants multi-touch sequences (e.g. wall-pass-then-shoot),
        # not "score on kickoff in a single touch".
        if self.level >= self.LEVEL_BUG_FIXES and scored > 0:
            if self._our_touches < 2:
                goal_reward *= 0.5      # half reward for single-touch goal
            if self._tick < 30:          # ~5 game-seconds since kickoff
                goal_reward *= 0.5      # extra cut for kickoff-quick goals

        return goal_reward - 10.0 * conceded


# ── Randomized kickoff: perturb ball + spawn positions for diversity ──
# Without this, deterministic opponents + argmax agents produce identical
# games. Small per-reset perturbation keeps trajectories varied.
class RandomKickoffSetter(StateSetter):
    def __init__(self, ball_jitter: float = 30.0, player_jitter: float = 25.0, seed: int = 0):
        super().__init__()
        self.ball_jitter = ball_jitter
        self.player_jitter = player_jitter
        self._rng = np.random.default_rng(seed)

    def reset(self, state_wrapper, save_recording=False):
        DefaultState().reset(state_wrapper, save_recording)
        # Perturb ball
        bx = float(self._rng.uniform(-self.ball_jitter, self.ball_jitter))
        by = float(self._rng.uniform(-self.ball_jitter, self.ball_jitter))
        try:
            state_wrapper.ball.position[0] += bx
            state_wrapper.ball.position[1] += by
        except Exception:
            pass
        # Perturb each player
        for p in getattr(state_wrapper, "players", []):
            try:
                p.disc.position[0] += float(self._rng.uniform(-self.player_jitter, self.player_jitter))
                p.disc.position[1] += float(self._rng.uniform(-self.player_jitter, self.player_jitter))
            except Exception:
                pass


# ── State setter: classic kickoff (ball center, players ±180) ────────
# ── Bug-fixed GoalScored: HaxballGym's reset() doesn't clear stored scores,
# ── causing immediate-terminate after the first episode.
class GoalScored(TerminalCondition):
    def __init__(self):
        super().__init__()
        self._red = 0
        self._blue = 0

    def reset(self, initial_state: GameState):
        self._red = int(initial_state.red_score)
        self._blue = int(initial_state.blue_score)

    def is_terminal(self, current_state: GameState) -> bool:
        if (current_state.red_score != self._red) or (current_state.blue_score != self._blue):
            self._red = int(current_state.red_score)
            self._blue = int(current_state.blue_score)
            return True
        return False


class ClassicKickoffSetter(StateSetter):
    """Delegates to DefaultState — game.reset() handles spawn positions."""

    def __init__(self):
        super().__init__()

    def reset(self, game: Game, save_recording: bool):
        game.reset(save_recording)
