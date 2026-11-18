#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QA 独立算法复算（task-26 新基准 / task-21 前置）—— **不 import、不参考 src/core 的任何代码**。

唯一依据（2026-11-11 新 SPEC）：
  - docs/SPEC.md §3.2 参数（task-26 新增 firstIntervalK/firstFamiliar* / firstVague* / progress*）
  - docs/SPEC.md §3.3 公式（DHP 公式 1/2/3/5 + 阈值法）
  - docs/SPEC.md §3.4 rating 更新规则与 predictAll / 今日进度模型
  - docs/SPEC.md §3.5 scheduleNext 伪代码
  - docs/research/04-official-scheduling.md（官方截图锚点 dog 78/3/1 等）

用途：按公式独立重算新基准，写入 tests/e2e/fixtures/algo-reference.json 作为「期望值」；
      再由 tests/e2e/algo-independent.test.ts 与 src/core 实测输出逐项比对。
      => 期望值来源与实现完全独立（Python 从公式重新算）。

变更（相对旧基准，task-26）：
  - 新词首评不再一律 1 天：认识 7–90 天（K=80：d=1→63/d=2→44/d=3→33/d=5→21/d=10→10，±1），
    模糊 1–7 天（2/2/2/1/1），忘记固定 1 天；
  - d0=5 连续认识 = 21→44→88→169→311→365…（K=80）；首评模糊独立 K_v=100 → 3/2/2/2/1；
  - 非首评「忘记」不再强制次日：按答错公式算 h' 后走阈值法（可能 1/2/7 天）；
  - predictAll v2 五档（5 档状态机，默认生效）：dog(d=1) 首显 63 天后 / 今日 / 3 天后 / 今日 / 1 天后；
    同日忘记→60/40/20 → 同日模糊→80/60/20 → 同日认识→1 天后/80/60；
    同日回炉 P=20% → 60/40/20%；P=40% → 80/60/40%；P=80% → 1 天后 / 80% / 80%。

用法：
  python3 tests/e2e/algo-reference.py            # 生成 fixture
  python3 tests/e2e/algo-reference.py --print    # 只打印
"""

import json
import math
import os
import sys

# ---------------------------------------------------------------- 参数（SPEC §3.2）
RECALL_EXP = 3.81
RECALL_D_EXP = -0.534
RECALL_H_EXP = -0.127
RECALL_FI_EXP = 0.970
FORGET_EXP = -0.041
FORGET_D_EXP = -0.041
FORGET_H_EXP = 0.377
FORGET_FI_EXP = -0.227

D0 = 5.0
D_MIN = 1.0
D_MAX = 18.0
D_FAIL_STEP = 2.0
D_INITIAL_MAX = 10.0

START_P_BASE = 0.925
START_P_STEP = 0.05
START_P_FLOOR = 0.025

RETENTION_TARGET = 0.9
INTERVAL_MIN = 1
INTERVAL_MAX = 365
STABILITY_MIN = 0.1
STABILITY_MAX = 4096.0

# task-26 新词首评（候选 A；认识 K=80，Lead 2026-11-11 定稿；模糊独立 K_v=100）
FIRST_INTERVAL_K = 80.0
# 首评「模糊」独立常数（与认识解耦：官方 d=1 实测 4/5 为 3 天 → K_v=100）
FIRST_VAGUE_INTERVAL_K = 100.0
FIRST_FAMILIAR_MIN = 7
FIRST_FAMILIAR_MAX = 90
FIRST_VAGUE_MIN = 1
FIRST_VAGUE_MAX = 7
FIRST_FORGET_DAYS = 1

# 今日进度模型（research 04 §5.3）
PROGRESS_BASE = 0.2
PROGRESS_FAMILIAR_STEP = 0.4
PROGRESS_VAGUE_STEP = 0.2
PROGRESS_FORGET_STEP = 0.0
PROGRESS_FAIL_CAP = 0.8


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def clamp01(v):
    return clamp(v, 0.0, 1.0)


def initial_stability(d):
    """公式 5：h0 = -1/log2(max(0.925 - 0.05*d, 0.025))，d 先 clamp 到 [1,10]"""
    d = clamp(d, D_MIN, D_INITIAL_MAX)
    p0 = max(START_P_BASE - START_P_STEP * d, START_P_FLOOR)
    return -1.0 / math.log2(p0)


def retrievability(h, elapsed_days):
    """公式 1：p = 2^(-Δt/h)"""
    if not (h == h) or h <= 0:  # NaN/<=0
        return 0.0
    return clamp01(math.pow(2.0, -max(0.0, elapsed_days) / h))


def stability_after_recall(d, h, p):
    """公式 2（答对）"""
    gain = (
        math.exp(RECALL_EXP)
        * math.pow(d, RECALL_D_EXP)
        * math.pow(h, RECALL_H_EXP)
        * math.pow(1.0 - p, RECALL_FI_EXP)
    )
    return h * (1.0 + gain)


def stability_after_forget(d, h, p):
    """公式 3（答错；重新赋值）"""
    fi = max(1e-4, 1.0 - clamp01(p))
    return (
        math.exp(FORGET_EXP)
        * math.pow(d, FORGET_D_EXP)
        * math.pow(h, FORGET_H_EXP)
        * math.pow(fi, FORGET_FI_EXP)
    )


def interval_from_retention(h, r_target=RETENTION_TARGET):
    """阈值法：clamp(round(-h*log2(R)), 1, 365)"""
    raw = -h * math.log2(r_target)
    rounded = int(math.floor(raw + 0.5))
    return int(clamp(rounded, INTERVAL_MIN, INTERVAL_MAX))


# ---------------------------------------------------------------- task-26 首评间隔
def first_familiar_half_life(d):
    """K · h0(d)"""
    return FIRST_INTERVAL_K * initial_stability(clamp(d, D_MIN, D_INITIAL_MAX))


def first_familiar_days(d):
    raw = -first_familiar_half_life(d) * math.log2(RETENTION_TARGET)
    return int(clamp(int(math.floor(raw + 0.5)), FIRST_FAMILIAR_MIN, FIRST_FAMILIAR_MAX))


def first_vague_half_life(d):
    # 模糊独立 K_v=100（与认识 K=80 解耦，Lead 2026-11-11 最终版）
    hv = stability_after_forget(
        clamp(d, D_MIN, D_INITIAL_MAX),
        FIRST_VAGUE_INTERVAL_K * initial_stability(d),
        RETENTION_TARGET,
    )
    return clamp(hv, STABILITY_MIN, STABILITY_MAX)


def first_vague_days(d):
    raw = -first_vague_half_life(d) * math.log2(RETENTION_TARGET)
    return int(clamp(int(math.floor(raw + 0.5)), FIRST_VAGUE_MIN, FIRST_VAGUE_MAX))


def first_forget_days():
    return FIRST_FORGET_DAYS


# ---------------------------------------------------------------- predictAll / 今日进度
# 进度模型 v2（5 档状态机，Lead 2026-11-11 最终表）——独立实现在此，不 import src/core。
# 档位 = (V 模糊%, W 忘记%, F 认识显示)：
#   L1a(1) = (60%,20%,80%)   ← 当日首评「不确定」
#   L1b(2) = (40%,20%,60%)   ← 当日首评「不认识」
#   L2(3)  = (60%,40%,N天后) ← 可完成当日
#   L3(4)  = (80%,60%,N天后)
#   L4(5)  = (80%,80%,N天后)
PROGRESS_LEVELS = [
    {"name": "L1a", "vague": 0.6, "forget": 0.2, "familiar": 0.8},
    {"name": "L1b", "vague": 0.4, "forget": 0.2, "familiar": 0.6},
    {"name": "L2", "vague": 0.6, "forget": 0.4, "familiar": "days"},
    {"name": "L3", "vague": 0.8, "forget": 0.6, "familiar": "days"},
    {"name": "L4", "vague": 0.8, "forget": 0.8, "familiar": "days"},
]
PROGRESS_ON_VAGUE = {1: 3, 2: 1, 3: 4, 4: 4, 5: 4}  # 2→1 为 inferred
PROGRESS_ON_FORGET = {1: 2, 2: 2, 3: 1, 4: 3, 5: 3}  # 1/2/5 为 inferred
PROGRESS_ON_FAMILIAR = {1: 4, 2: 3, 3: "complete", 4: "complete", 5: "complete"}
PROGRESS_INITIAL_VAGUE = 1
PROGRESS_INITIAL_FORGET = 2


def level_row(level):
    return PROGRESS_LEVELS[clamp(int(level), 1, 5) - 1]


def can_finish(level):
    return level_row(level)["familiar"] == "days"


def transition(rating, level):
    table = (
        PROGRESS_ON_FAMILIAR
        if rating == "familiar"
        else PROGRESS_ON_VAGUE
        if rating == "vague"
        else PROGRESS_ON_FORGET
    )
    return table.get(int(level), level)


def format_progress(progress, days):
    if progress >= 1:
        return f"{days} 天后"
    return f"今日进度{int(round(progress * 100))}%"


def predict_v2(level, days, first=False, first_days=None, first_progress=None):
    """同日回炉预测：V/W 由档位表唯一确定；F 由 canFinish（≥L2）决定 days 还是 %。"""
    if first:
        return {
            "familiar": {"first": True, "days": first_days["familiar"], "progress": 1.0},
            "vague": {"first": True, "days": first_days["vague"], "progress": PROGRESS_BASE},
            "forgot": {"first": True, "days": first_days["forgot"], "progress": PROGRESS_BASE},
        }
    row = level_row(level)
    fam = 1.0 if can_finish(level) else row["familiar"]
    return {
        "familiar": {"first": False, "days": days, "progress": fam},
        "vague": {"first": False, "days": days, "progress": row["vague"]},
        "forgot": {"first": False, "days": days, "progress": row["forget"]},
    }


def texts_of(preds):
    return {
        rating: {**pred, "text": format_progress(pred["progress"], pred["days"])} if pred["progress"] < 1 else {**pred, "text": f'{pred["days"]} 天后'}
        for rating, pred in preds.items()
    }


def first_predicts(difficulty):
    return {
        "familiar": {"first": True, "days": first_familiar_days(difficulty), "progress": 1.0},
        "vague": {"first": True, "days": first_vague_days(difficulty), "progress": PROGRESS_BASE},
        "forgot": {"first": True, "days": first_forget_days(), "progress": PROGRESS_BASE},
    }


def first_texts(difficulty):
    p = first_predicts(difficulty)
    return {
        "familiar": f'{p["familiar"]["days"]} 天后',
        "vague": f'今日 / {p["vague"]["days"]} 天后',
        "forgot": f'今日 / {p["forgot"]["days"]} 天后',
    }


def same_day_sequence(ratings, difficulty=1):
    """同日序列：首评 + 后续同日反馈（v2 档位状态机）。返回每一步评分后的预测与是否完成。"""
    level = PROGRESS_INITIAL_VAGUE if ratings[0] == "vague" else PROGRESS_INITIAL_FORGET
    if ratings[0] == "familiar":
        level = 1  # 首评认识 → 当日完成，不进入回炉序列
    days = (
        first_forget_days()
        if ratings[0] == "forgot"
        else first_vague_days(difficulty)
        if ratings[0] == "vague"
        else first_familiar_days(difficulty)
    )
    steps = []
    for index, rating in enumerate(ratings):
        if index == 0:
            steps.append(
                {
                    "after": f"首评 {rating}",
                    "level": level,
                    "completes": rating == "familiar",
                    "predicts": texts_of(predict_v2(level, days)),
                }
            )
            continue
        to = transition(rating, level)
        completes = rating == "familiar" and to == "complete" and can_finish(level)
        next_level = level if to == "complete" else to
        steps.append(
            {
                "after": f"同日 {rating}",
                "level": next_level,
                "completes": completes,
                "predicts": texts_of(predict_v2(next_level, days)),
            }
        )
        level = next_level
    return {"ratings": ratings, "difficulty": difficulty, "days": days, "steps": steps}


# ---------------------------------------------------------------- 模拟
def schedule_step(state, rating, now):
    """按 SPEC §3.5 伪代码独立实现一步（state 为 dict）。"""
    is_first_ever = state["lastReviewedAt"] is None
    d = clamp(state["difficulty"], D_MIN, D_MAX)
    if is_first_ever:
        d = clamp(state["difficulty"], D_MIN, D_INITIAL_MAX)
        p = 1.0
        if rating == "familiar":
            h = first_familiar_half_life(d)
            interval = first_familiar_days(d)
        elif rating == "vague":
            h = first_vague_half_life(d)
            interval = first_vague_days(d)
        else:
            h = initial_stability(d)
            interval = first_forget_days()
    else:
        elapsed = max(0.0, (now - state["lastReviewedAt"]) / 86_400_000.0)
        p = retrievability(state["stability"], elapsed)
        h = (
            stability_after_recall(d, state["stability"], p)
            if rating == "familiar"
            else stability_after_forget(d, state["stability"], p)
        )
        interval = interval_from_retention(h)  # 忘记不再强制次日
    if rating == "forgot":
        d = clamp(d + D_FAIL_STEP, D_MIN, D_MAX)
    h = clamp(h, STABILITY_MIN, STABILITY_MAX)
    interval = int(clamp(interval, INTERVAL_MIN, INTERVAL_MAX))
    today_progress = 1.0 if rating == "familiar" else PROGRESS_BASE
    next_state = {
        **state,
        "difficulty": d,
        "stability": h,
        "retrievability": p,
        "nextIntervalDays": interval,
        "lastReviewedAt": now,
        "firstSeenAt": now if state["firstSeenAt"] is None else state["firstSeenAt"],
        "todayProgress": today_progress,
        "lastRating": rating,
        "sameDayCount": 1,
    }
    return next_state, {"p": p, "h": h, "d": d, "interval": interval}


def simulate(ratings, d0=D0):
    """第 1 步=新词首评；之后按「恰好间隔 n 天后同一钟点复习」推进。"""
    state = {
        "difficulty": d0,
        "stability": initial_stability(d0),
        "nextIntervalDays": 0,
        "lastReviewedAt": None,
        "firstSeenAt": None,
        "todayProgress": PROGRESS_BASE,
        "lastRating": None,
        "sameDayCount": 0,
    }
    now = 0
    out = []
    for i, rating in enumerate(ratings, start=1):
        state, step = schedule_step(state, rating, now)
        out.append({"step": i, "rating": rating, **step})
        now += step["interval"] * 86_400_000
    return out


def predict_all(state, now):
    """仅实现首显/同日回炉两分支（本 fixture 用到的场景）。"""
    is_first_ever = state["firstSeenAt"] is None
    is_first_today = is_first_ever or state["lastReviewedAt"] is None
    if is_first_today:
        d = clamp(state["difficulty"], D_MIN, D_INITIAL_MAX)
        return {
            "familiar": {"first": True, "days": first_familiar_days(d), "progress": 1.0},
            "vague": {"first": True, "days": first_vague_days(d), "progress": PROGRESS_BASE},
            "forgot": {"first": True, "days": first_forget_days(), "progress": PROGRESS_BASE},
        }
    p = clamp01(state.get("todayProgress", PROGRESS_BASE))
    days = state["nextIntervalDays"]
    return {
        "familiar": {"first": False, "days": days, "progress": progress_after("familiar", p)},
        "vague": {"first": False, "days": days, "progress": progress_after("vague", p)},
        "forgot": {"first": False, "days": days, "progress": progress_after("forgot", p)},
    }


def simulate_same_day(ratings, d0=D0):
    """同一时刻连续评分（首评 + 同日回炉），返回每次预测快照。"""
    state = {
        "difficulty": d0,
        "stability": initial_stability(d0),
        "nextIntervalDays": 0,
        "lastReviewedAt": None,
        "firstSeenAt": None,
        "todayProgress": PROGRESS_BASE,
        "lastRating": None,
        "sameDayCount": 0,
    }
    now = 1_762_790_000_000  # 固定时刻，仅用于同日判断
    out = {"start": snapshot(predict_all(state, now))}
    for rating in ratings:
        state, _ = schedule_step(state, rating, now)
        # 同日分支：不改长期 h/d/dueAt，仅更新 todayProgress（SPEC §3.5 分支 1）
        prev = out.get("start")
        if state["lastReviewedAt"] is not None and rating == "forgot":
            pass
        out[rating] = snapshot(predict_all(state, now + 1000))
        now += 1000
    return out


def same_day_progression(d0=D0):
    """官方截图链：新词首显 → 首评忘记(P=20%) → 同日模糊(P=40%) → 同日认识(P=80%→100%)。"""
    state = {
        "difficulty": d0,
        "stability": initial_stability(d0),
        "nextIntervalDays": 0,
        "lastReviewedAt": None,
        "firstSeenAt": None,
        "todayProgress": PROGRESS_BASE,
        "lastRating": None,
        "sameDayCount": 0,
    }
    now = 1_762_790_000_000
    steps = [{"after": "新词首显", "predicts": snapshot(predict_all(state, now))}]
    # 首评「忘记」：走长期分支（固定 1 天、d+2、h=h0）
    state, _ = schedule_step(state, "forgot", now)
    steps.append(
        {
            "after": "首评 forgot（P=20%）",
            "state": {k: state[k] for k in ("difficulty", "stability", "nextIntervalDays", "todayProgress")},
            "predicts": snapshot(predict_all(state, now + 1000)),
        }
    )
    now += 1000
    for rating in ["vague", "familiar"]:
        # 同日非首次：不改长期状态，只累计 todayProgress
        state = {
            **state,
            "todayProgress": progress_after(rating, state["todayProgress"]),
            "lastRating": rating,
            "sameDayCount": state["sameDayCount"] + 1,
        }
        now += 1000
        steps.append(
            {
                "after": f"同日 {rating}（P={int(round(state['todayProgress'] * 100))}%）",
                "state": {k: state[k] for k in ("difficulty", "stability", "nextIntervalDays", "todayProgress")},
                "predicts": snapshot(predict_all(state, now)),
            }
        )
    return steps


def main():
    result = {"meta": {"spec": "SPEC.md §3.2/§3.3/§3.4/§3.5 (task-26)", "independent": True}}

    # 1) 初始半衰期
    result["initialStability"] = {f"d{d}": initial_stability(d) for d in (1, 2, 5, 10)}

    # 2) 新词首评间隔（认识/模糊/忘记，天）—— 官方截图锚点 ±1
    result["firstIntervals"] = {
        f"d{d}": {
            "familiar": first_familiar_days(d),
            "vague": first_vague_days(d),
            "forgot": first_forget_days(),
        }
        for d in (1, 2, 3, 5, 10)
    }
    # 首评 h 值（h=K·h0 / 模糊 h / 忘记 h=h0）
    result["firstHalfLives"] = {
        f"d{d}": {
            "familiar": first_familiar_half_life(d),
            "vague": first_vague_half_life(d),
            "forgot": initial_stability(d),
        }
        for d in (1, 2, 3, 5, 10)
    }

    # 3) d0=5 连续「认识」序列（K=80 新基准：21→44→88→169→311→365→365…）
    result["familiarSequence_d0_5"] = simulate(["familiar"] * 8)
    result["familiarSequence_d0_1"] = simulate(["familiar"] * 6, d0=1)
    result["familiarSequence_d0_10"] = simulate(["familiar"] * 6, d0=10)

    # 4) 非首评忘记：不再强制次日
    result["forgetAfterHighH"] = simulate(
        ["familiar", "familiar", "familiar", "familiar", "familiar", "forgot", "familiar", "familiar"]
    )
    result["forgetAfterLowH"] = simulate(["vague", "forgot", "familiar"])

    # 5) 新词首评三分支明细
    result["newWordFamiliar_d5"] = simulate(["familiar"])
    result["newWordVague_d5"] = simulate(["vague"])
    result["newWordForgot_d5"] = simulate(["forgot"])

    # 6) predictAll 三键数值快照（dog d=1，v2 五档：首评→忘记→同日模糊→同日认识）
    result["predictDog"] = same_day_sequence(["forgot", "vague", "familiar"], difficulty=1)
    result["predictDog"]["first"] = first_texts(1)

    # 6b) v2 真机序列 face / cat / yellow（期望值由本脚本按 5 档表独立推导）
    result["sequences"] = {
        "face": same_day_sequence(["forgot", "familiar", "familiar"], difficulty=1),
        "cat": same_day_sequence(
            ["vague", "vague", "vague", "forgot", "forgot", "familiar", "familiar"], difficulty=1
        ),
        "yellow": same_day_sequence(["vague", "vague", "vague", "forgot", "familiar"], difficulty=1),
    }

    # 7) 不熟悉度（AC2 回归，仍适用）
    def fam(c, e):
        if e <= 0:
            return None
        return clamp01(c / e)

    result["familiarity"] = {
        "0/0": fam(0, 0),
        "1/1": fam(1, 1),
        "1/3": fam(1, 3),
        "3/7": fam(3, 7),
        "7/5": fam(7, 5),
        "0/5": fam(0, 5),
        "5/0": fam(5, 0),
        "0/-3": fam(0, -3),
    }

    # 8) 阈值法边界（公式未变）
    result["intervalFromRetention"] = {
        "h_0.1": interval_from_retention(0.1),
        "h_1.7635": interval_from_retention(1.7635),
        "h_176.35": interval_from_retention(176.35),
        "h_4002.94": interval_from_retention(4002.94),
        "h_100000": interval_from_retention(100000),
        "h_50_r0.85": interval_from_retention(50, 0.85),
        "h_50_r0.92": interval_from_retention(50, 0.92),
    }

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if "--print" in sys.argv:
        print(text)
        return
    here = os.path.dirname(os.path.abspath(__file__))
    fixture = os.path.join(here, "fixtures", "algo-reference.json")
    os.makedirs(os.path.dirname(fixture), exist_ok=True)
    with open(fixture, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print("wrote", fixture)

    print("\n首评间隔（认识/模糊/忘记，天，K=80）:")
    for d, v in result["firstIntervals"].items():
        print(f"  {d}: {v['familiar']} / {v['vague']} / {v['forgot']}")
    print("\nd0=5 连续认识（h / 间隔）:")
    for s in result["familiarSequence_d0_5"]:
        print(f"  step {s['step']}: p={s['p']:.6f} h={s['h']:.4f} interval={s['interval']}")
    print("\n非首评忘记（高 h）:")
    for s in result["forgetAfterHighH"]:
        print(f"  step {s['step']} {s['rating']:9s} h={s['h']:.4f} d={s['d']} interval={s['interval']}")
    print("\npredictAll dog(d=1) v2 同日链:")
    print("  首显 →", result["predictDog"]["first"])
    for step in result["predictDog"]["steps"]:
        print(" ", step["after"], "→", {k: v["text"] for k, v in step["predicts"].items()})
    print("\nv2 真机序列（首评/同日预测）:")
    for name, seq in result["sequences"].items():
        print(f"  {name} ratings={seq['ratings']} N={seq['days']}天")
        for step in seq["steps"]:
            print("   ", step["after"], "等级", step["level"], "完成" if step["completes"] else "", "→", {k: v["text"] for k, v in step["predicts"].items()})


if __name__ == "__main__":
    main()
