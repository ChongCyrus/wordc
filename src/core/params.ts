/**
 * 算法参数（SPEC §3.2）—— **全部集中在这里**，便于校准 / A-B / 单测注入。
 *
 * 公式与系数来源：MaiMemo（MaiMemo）KDD'22 论文 DHP 模型官方代码（MIT）。
 * 论文公式（2)(3)(5) 与官方 `maimemo-memory-research` 训练代码逐行核对，
 * 系数**禁止随意修改**；改动会导致与基准序列（见下）不一致。
 *
 * 基准序列（d0=5、一直点「认识」、R_target=0.9，SPEC §3.3 数值基准 / research 附录 B）：
 *
 *   次序  1     2     3     4     5      6      7      8       9       10
 *   p    1    0.675 0.893 0.897 0.903  0.902  0.901  0.900   0.900   0.900
 *   h    1.76 12.31 31.80 75.10 161.01 330.90 653.55 1239.39 2264.93 4002.94
 *   间隔   1     2     5     11    24     50     99     188     344     365(封顶)
 *
 *   （h0 = -1/log2(0.925-0.05*5) = 1.7637；SPEC §1.3/§3.2 里「≈1.74」是排版笔误，
 *     以公式 5 的计算结果为准，见 docs/CORE-API.md「与 SPEC 的偏差」一节。）
 *
 *   忘记分支（第 5 次序点「不认识」）：h 161.01 → 7.78，d 5 → 7，间隔强制 1 天。
 *
 * 说明：每个 core 调度/会话函数最后都允许传 `Partial<AlgoParams>`，默认 DEFAULT_PARAMS。
 */

/**
 * v2 档位表的一行（research 04 §15.4/§15.6 + Lead 2026-11-11 实机 5 档状态机）。
 * - `vague`/`forget`：该档位下「模糊/忘记」按钮显示的百分比；
 * - `familiar`：number = 「认识」显示百分比；'days' = 显示已固定的长期间隔（完成当日）。
 */
export interface ProgressLevel {
  /** 档位名（文档/调试用）：'L1a' | 'L1b' | 'L2' | 'L3' | 'L4' */
  name: string
  vague: number
  forget: number
  familiar: number | 'days'
}

/** 档位转移：目标档位（1 起）或 'complete'（认识完成当日）；`inferred=true` 表示未实测、保守外推 */
export interface LevelTransition {
  to: number | 'complete'
  inferred?: boolean
}

export interface AlgoParams {
  // —— DHP 更新（KDD'22 官方代码参数，禁止随意改）——
  recallExp: number
  recallDExp: number
  recallHExp: number
  recallFiExp: number
  forgetExp: number
  forgetDExp: number
  forgetHExp: number
  forgetFiExp: number
  // —— 难度 ——
  d0: number
  dMin: number
  dMax: number
  /** 仅 forgot 加难度 */
  dFailStep: number
  /** 模糊不加难度；可 A/B 设 1 */
  dVagueStep: number
  /** 新词初始难度上限（新词 clamp 1–10） */
  dInitialMax: number
  // —— 初始半衰期（公式 5）——
  startPBase: number
  startPStep: number
  startPFloor: number
  // —— 调度 ——
  retentionTarget: number
  intervalMin: number
  intervalMax: number
  forceNextDayOnForgot: boolean
  // —— 新词首评间隔（research 04 §11.4 候选 A；K 为拟合经验常数，非官方值）——
  /** 首评认识 = 该词已有约 K 倍初始半衰期的记忆（K=80，6 样本拟合：d=1→63、d=2→44） */
  firstIntervalK: number
  /**
   * 首评「模糊」独立常数（与认识的 K 解耦）：官方 d=1 实测 4/5 样本为 3 天，
   * 共用 K=80 会算成 2 天（明显偏短），故模糊保持 K_v=100（d=1→3、d=2→2、d=3→2）。
   */
  firstVagueIntervalK: number
  firstFamiliarMin: number
  firstFamiliarMax: number
  firstVagueMin: number
  firstVagueMax: number
  /** 首评忘记固定 1 天（官方截图 2026-11-11 锚点） */
  firstForgetDays: number
  // —— 三键「今日进度%」模型（research 04 §5.3 / §15.6，推断值，可 A/B）——
  /**
   * 进度模型模式：
   * - 'v1-20pp'（默认，保持现状）：单标量 + 20pp 线性步进（已知与实机 L2/L3/L4 不符）；
   * - 'v2-levels'：5 档 level（L1a/L1b/L2/L3/L4）+ canFinish 标志（research 04 §15.4/§15.6/§15.7，D 级推算）。
   */
  progressModelMode: 'v1-20pp' | 'v2-levels'
  /** 当日首评失败后的基准进度（截图 01 的 20%） */
  progressBase: number
  /** 认识 +40pp（可完成当日复习） */
  progressFamiliarStep: number
  /** 模糊 +20pp */
  progressVagueStep: number
  /** 忘记 +0pp */
  progressForgetStep: number
  /** 模糊/忘记的进度上限（只有认识能到 100%） */
  progressFailCap: number
  // —— v2 档位模型参数（research 04 §15.6；默认值与 v1 行为无关，切 mode 才生效）——
  /**
   * 5 档 V/W/F 表（下标 0..4 = level 1..5，即 L1a/L1b/L2/L3/L4）。
   * V/W 由实机观测唯一确定（B 级）；F 的 canFinish 由档位判定（实测 L2/L3+认识完成，L4 为 inferred）。
   * `familiar`: number = canFinish=false 时「认识」显示的百分比；'days' = 显示长期间隔（完成当日）。
   */
  progressLevels: ReadonlyArray<ProgressLevel>
  /** 同日「模糊」后的档位转移（key=当前档位 1 起；`inferred` 标未实测的外推） */
  progressOnVague: Readonly<Record<number, LevelTransition>>
  /** 同日「忘记」后的档位转移（key=当前档位 1 起） */
  progressOnForget: Readonly<Record<number, LevelTransition>>
  /** 同日「认识」后的档位转移（`to:'complete'` = 完成当日；key=当前档位 1 起） */
  progressOnFamiliar: Readonly<Record<number, LevelTransition>>
  /** 当日首评「不确定/模糊」后的初始档位（实测 → L1a） */
  progressInitialLevelVague: number
  /** 当日首评「不认识/忘记」后的初始档位（实测 → L1b） */
  progressInitialLevelForget: number
  /** 「认识」是否完成当日复习：'table' = 按档位表 familiar 列（默认）；其余为 A/B 覆盖开关 */
  canFinishMode: 'table' | 'always' | 'never' | 'level>=3' | 'afterFirstFail'
  // —— 官方设置项（SPEC-v2 §1.1/§1.3）——
  /** 允许「模糊」完成当日复习（默认 false：模糊持续回炉到认识） */
  allowVagueComplete: boolean
  /** 标签切换键：firstEver=新词首次显示（默认）；firstToday=当日首显（残余风险，可配置） */
  labelSwitch: 'firstEver' | 'firstToday'
  // —— 同日回炉（D10，推测值，可 A/B）——
  /** 不认识的词往后第 4 个词再出现 */
  requeueGapForgot: number
  /** 模糊的词往后第 8 个词再出现 */
  requeueGapVague: number
  /** 当天至少出现 2 次 */
  sameDayMinAppearForgot: number
  sameDayMinAppearVague: number
  // —— 防御 ——
  stabilityMin: number
  stabilityMax: number
  dayMs: number
}

export const DEFAULT_PARAMS: AlgoParams = {
  // —— DHP 更新（KDD'22 公式 2/3）——
  recallExp: 3.81,
  recallDExp: -0.534,
  recallHExp: -0.127,
  recallFiExp: 0.97,
  forgetExp: -0.041,
  forgetDExp: -0.041,
  forgetHExp: 0.377,
  forgetFiExp: -0.227,
  // —— 难度 ——
  d0: 5,
  dMin: 1,
  dMax: 18,
  dFailStep: 2,
  dVagueStep: 0,
  dInitialMax: 10,
  // —— 初始半衰期 ——
  startPBase: 0.925,
  startPStep: 0.05,
  startPFloor: 0.025,
  // —— 调度（MM-3.2+ 生产口径：保留率阈值法）——
  retentionTarget: 0.9,
  intervalMin: 1,
  intervalMax: 365,
  // task-26：忘记不再强制次日（官方语义：按难度/记忆等级重算，可能 1/2/7 天）；
  // 首评忘记仍固定 1 天（firstForgetDays）。置 true 可恢复旧行为（A/B 用）。
  forceNextDayOnForgot: false,
  // —— 新词首评间隔（research 04 §11.4 候选 A）——
  // 基准：d=1→79/3/1；d=2→55/2/1；d=5→27/2/1；d=10→12/1/1（认识/模糊/忘记，天）
  // K 从 100 调到 80（research-algo 用 6 个官方首现样本拟合：MAE 10.5→9.5；
  // d=1 落在官方实测 56–78 区间中部；d=2→44 与官方 this=43 几乎一致）。
  // 注意：官方同难度实测也有 56/62/78 分散，**逐词复刻在原理上不可达**（缺 per-word/记忆等级数据）。
  firstIntervalK: 80,
  // 首评「模糊」独立常数（与认识 K 解耦）：官方 d=1 实测 4/5 为 3 天 → K_v=100
  firstVagueIntervalK: 100,
  firstFamiliarMin: 7,
  firstFamiliarMax: 90,
  firstVagueMin: 1,
  firstVagueMax: 7,
  firstForgetDays: 1,
  // —— 三键「今日进度%」（research 04 §5.3；能逐值复现 01/05/04 截图）——
  // Lead 2026-11-11 拍板：默认切 v2-levels（v1-20pp 保留做 A/B/回滚）
  progressModelMode: 'v2-levels',
  progressBase: 0.2,
  progressFamiliarStep: 0.4,
  progressVagueStep: 0.2,
  progressForgetStep: 0,
  progressFailCap: 0.8,
  // v2 档位表（Lead 实机 face/cat/yellow 三词交叉验证的 5 档状态机；D 级推算）
  progressLevels: [
    { name: 'L1a', vague: 0.6, forget: 0.2, familiar: 0.8 }, // 当日首评「不确定」
    { name: 'L1b', vague: 0.4, forget: 0.2, familiar: 0.6 }, // 当日首评「不认识」
    { name: 'L2', vague: 0.6, forget: 0.4, familiar: 'days' },
    { name: 'L3', vague: 0.8, forget: 0.6, familiar: 'days' },
    { name: 'L4', vague: 0.8, forget: 0.8, familiar: 'days' },
  ],
  // 实测转移（Lead 2026-11-11）：模糊 L1a→L2 / L2→L3 / L3→L3 / L4→L3；
  // 未知外推（inferred）：L1b+模糊→L1a（保守：回到首评不确定档）
  progressOnVague: {
    1: { to: 3 },
    2: { to: 1, inferred: true },
    3: { to: 4 },
    4: { to: 4 },
    5: { to: 4 },
  },
  // 实测：忘记 L3→L2、L2→L1a；未知外推：L1a→L1b、L1b→L1b、L4→L2
  progressOnForget: {
    1: { to: 2, inferred: true },
    2: { to: 2, inferred: true },
    3: { to: 1 },
    4: { to: 3 },
    5: { to: 3, inferred: true },
  },
  // 实测：认识 L1b→L2、L1a→L3、L2→完成、L3→完成；
  // 外推（inferred，未实测）：L4→完成（保守按完成）
  progressOnFamiliar: {
    1: { to: 4 },
    2: { to: 3 },
    3: { to: 'complete' },
    4: { to: 'complete' },
    5: { to: 'complete', inferred: true },
  },
  progressInitialLevelVague: 1, // L1a
  progressInitialLevelForget: 2, // L1b
  canFinishMode: 'table',
  allowVagueComplete: false,
  labelSwitch: 'firstEver',
  // —— 同日回炉（D10）——
  requeueGapForgot: 4,
  requeueGapVague: 8,
  sameDayMinAppearForgot: 2,
  sameDayMinAppearVague: 2,
  // —— 防御 ——
  stabilityMin: 0.1,
  stabilityMax: 4096,
  dayMs: 86_400_000,
}

/** 合并覆盖参数：`resolveParams({ retentionTarget: 0.85 })` */
export function resolveParams(overrides?: Partial<AlgoParams>): AlgoParams {
  return overrides ? { ...DEFAULT_PARAMS, ...overrides } : DEFAULT_PARAMS
}

/** 通用数值 clamp（NaN 兜底为 lo） */
export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

/** 0–1 区间 clamp（NaN 兜底 0） */
export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
