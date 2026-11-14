/**
 * 领域模型 v1（SPEC §1.2 逐字落地 · 唯一实现依据）。
 *
 * 约束：本文件只有类型，没有运行时代码；不得依赖 DOM / React / Dexie。
 * 数据层（src/data）负责把这里的类型落到 IndexedDB；算法层（src/core）只接受/返回这些类型。
 */

// ============ 词库 / 单词 ============

export type DeckSource = 'builtin' | 'imported' | 'custom' | 'maimemo'

export interface Deck {
  id: string // 'kaoyan-2027-dagang' | 用户导入生成的 id
  name: string // 展示名，如「2025考研英语词汇受限商业词表（6702 词）」
  description?: string
  source: DeckSource
  /** 内置词库的稳定标识（用于升级/去重；用户词库为 undefined） */
  builtinKey?: 'hongbaoshu-2025' | 'kaoyan-2027-dagang'
  /** 词条总数（导入/种子时写入，避免每次 count） */
  wordCount: number
  /** 词库内容版本，内置词库升级时 +1；用于 ensureBuiltinDecks 幂等判断 */
  version: number
  /** 版权/许可说明，展示在词库详情页（D20/D21 要求） */
  license?: string
  /** 默认词库标记：App 首次启动默认选中的词库（受限商业词表） */
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

export interface Phonetic {
  uk?: string // 英式音标，含方括号，如 '[ˈspɪdə]'
  us?: string // 美式音标
}

export interface Example {
  en: string
  cn?: string // 中文翻译
  source?: string // 词库来源说明（可选）
}

export interface Mnemonic {
  /** 助记类型（对齐MaiMemo：联想/谐音/词根/词源/串记/其他…） */
  type: '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他'
  text: string
  /** task-128：归属含义 id（`${wordId}#M{i}`）；缺省=词级（旧数据兼容） */
  meaningId?: string
}

export interface Phrase {
  en: string // 含目标词的英文词组/搭配
  cn: string // 中文
  /**
   * 归属含义 id（task-42；`${wordId}#M{i}`）。
   * 缺省/undefined = 词级词组（旧数据兼容；w-c 页只在能匹配当前含义时显示）。
   */
  meaningId?: string
}

export interface Meaning {
  /** 稳定 id：`${wordId}#M${序号}`，序号从 1 开始，按数组顺序（见 §1.4） */
  id: string
  /** 词性，如 'n.' 'vt.' 'adj.' 'phr.'；无词性时 undefined */
  pos?: string
  /** 中文释义（单条，不含词性） */
  cn: string
  /** 该含义专属例句（可空；Word.examples 是词级例句） */
  examples?: Example[]
}

/** F8：生成元 → 含义 引申图（每词一条；文字或 Mermaid 二选一/并存） */
export interface DerivationMap {
  /** 统一生成元（最共性本义）标签 */
  rootLabel?: string
  /** 结构化文字版（生成元 → 场景/对象/词性 → 含义） */
  text?: string
  /** Mermaid 图源（mindmap / flowchart LR） */
  mermaid?: string
  /** 来源：人工编辑或 AI 生成 */
  source: 'manual' | 'ai'
  updatedAt: number
}

/** 用户自定义笔记（F6/task-139；meaningId 缺省 = w 级） */
export interface UserNote {
  id: string
  text: string
  /** 缺省 = 词级；指定则为该含义（c 级） */
  meaningId?: string
}

/** 用户自定义助记（F6/task-139；meaningId 缺省 = w 级） */
export interface UserMnemonic {
  id: string
  type: '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他'
  text: string
  /** 缺省 = 词级；指定则为该含义（c 级） */
  meaningId?: string
}

export interface Word {
  /** = `${deckId}:${normalizedHeadword}`，见 §1.4 */
  id: string
  deckId: string
  /** 英文词条（原拼写） */
  headword: string
  /** 小写规范化 headword（存一份进索引，避免每次查询时算） */
  headwordLower: string
  phonetic?: Phonetic
  /** 中文释义列表；至少 1 条（无释义时用 headword 兜底并打 tag 'no-meaning'） */
  meanings: Meaning[]
  /** 词级例句（白板面/注释面各取前 N 条） */
  examples: Example[]
  mnemonics: Mnemonic[]
  /** 词组（w-c 页“显示词组”开关消费；可为空） */
  phrases: Phrase[]
  /** 标签：'考研' / '受限商业词表' / '大纲词汇' / 'no-meaning' … */
  tags: string[]
  /** 词库内顺序（1 起） */
  order: number
  /**
   * 官方词难度 d（1–10，WDR 难度；来自MaiMemo官方数据/前端，见 research 04 §11）。
   * 缺失 = undefined（先用 `DEFAULT_PARAMS.d0 = 5` 兜底，并在数据层标记 estimated）。
   * 用于初始化 `WordState.difficulty`（`createWordState({ difficulty: word.difficulty })`）。
   */
  difficulty?: number
  /** 词频（越大越高频；大纲词表自带，受限商业词表无） */
  frequency?: number
  /** CEFR 等级，如 'A1'/'B2' */
  cefr?: string
  /** 真题出现次数（大纲词表自带） */
  examCount?: number
  /** 章节（受限商业词表 '必考词 Unit 1'；大纲词表为分类名） */
  chapter?: string
  /** MaiMemo voc_id（若从MaiMemo导入过），仅本机参考 */
  maimemoVocId?: string
  /** F6：用户自定义笔记（词级或含义级；不写入内容包，AI 应用不覆盖） */
  userNotes?: UserNote[]
  /** F6：用户自定义助记（词级或含义级；不写入内容包，AI 应用不覆盖） */
  userMnemonics?: UserMnemonic[]
  /**
   * F6：被用户编辑/删除的 AI 助记 key（稳定 key = `${meaningId??''}|${type}|${text}`）。
   * 展示时过滤这些 key；重新应用 AI 内容包不会清除该列表。
   */
  hiddenMnemonicKeys?: string[]
  /** F8：生成元→含义 引申图（人工/AI；导出/导入包含，AI apply 不覆盖） */
  derivationMap?: DerivationMap
  createdAt: number
}

// ============ 记忆状态 ============

/**
 * familiar=认识(按钮1)  vague=模糊(按钮2)  forgot=不认识/忘记(按钮3)
 * 注：MaiMemo的「熟知 wellFamiliar」v1 不实现（用户需求只要三个按钮，D16 语境），类型不预留。
 */
export type Rating = 'familiar' | 'vague' | 'forgot'

export type Phase = 'new' | 'learning' | 'review' | 'lapsed' | 'mastered' | 'suspended'

export interface MeaningStat {
  /** 该含义被点击「标记不熟悉」的累计次数（可 > encounters，原始值保留） */
  clicks: number
  /** 该含义被遇到的累计次数（每次进入注释面 +1，整词同步） */
  encounters: number
}

export interface WordState {
  /** 主键，= Word.id */
  wordId: string
  deckId: string
  phase: Phase
  /** 记忆半衰期 h（天），内部主状态，>0 */
  stability: number
  /** 难度 d，1–18（新词初始 1–10，默认 5） */
  difficulty: number
  /** 连续成功（认识）次数 */
  reps: number
  /** 遗忘（模糊/不认识）累计次数 */
  lapses: number
  /** 首次被学习的时间（第一次提交评分时写入）；未学为 null */
  firstSeenAt: number | null
  /** 上次复习/评分时间；未学为 null */
  lastReviewedAt: number | null
  /** 下次到期时间（本地日期 00:00 的 epoch ms）；new/mastered/suspended 为 null */
  dueAt: number | null
  /** 上次算出的间隔（天），1–365；对外=「记忆持久度」 */
  nextIntervalDays: number
  /** 上次结算时的回忆概率快照（0–1），对外=「熟知度」的近似（实时值用 retrievabilityNow） */
  retrievability: number
  /** 最近一次评分 */
  lastRating: Rating | null
  /** 当天已出现的次数（用于「只有当天第一次反馈影响长期调度」） */
  sameDayCount: number
  /** sameDayCount 所属本地日期 key，跨天自动归零 */
  sameDayDate: string
  /** 各含义的不熟悉度计数（key = Meaning.id） */
  meaningStats: Record<string, MeaningStat>
  /** 当日回炉需要的标记：今天已因模糊/不认识回炉的次数（按词） */
  sameDayRequeued: number
  /**
   * 当日复习进度 0–1（官方 `Predict.progress` 的本地等价模型，research 04 §5.3，**推断值**）。
   * 基准 20%、认识 +40pp、模糊 +20pp、忘记 +0；模糊/忘记封顶 80%，只有认识能到 100%。
   * 只用于「同日回炉」阶段的三键预测文案，不影响长期间隔。缺失按 0 处理。
   */
  todayProgress?: number
  /** todayProgress 所属本地日期 key（跨天归零，与 sameDayDate 同口径） */
  todayProgressDate?: string
  /**
   * v2 档位模型的当前 level（1–5：1=L1a、2=L1b、3=L2、4=L3、5=L4；`progressModelMode='v2-levels'` 时使用；
   * 缺失时按 lastRating 回退：模糊→progressInitialLevelVague、忘记→progressInitialLevelForget）
   */
  todayProgressLevel?: number
  /** v2：当前「认识」是否会完成当日复习（canFinish 标志；缺失按 canFinishMode 派生） */
  canFinishToday?: boolean
  /** 数据来源（导入时用于区分，便于以后重算） */
  importedFrom?: 'maimemo' | 'backup'
  importedAt?: number
  createdAt: number
  updatedAt: number
}

// ============ 复习日志（统计/遗忘曲线/热力图） ============

export interface ReviewLog {
  /** Dexie 自增主键（导出时可不带） */
  id?: number
  wordId: string
  deckId: string
  rating: Rating
  reviewedAt: number
  /** 评分前状态快照 */
  stabilityBefore: number
  difficultyBefore: number
  /** 评分后状态快照 */
  stabilityAfter: number
  difficultyAfter: number
  /** 提交时的复习间隔（天，距上次的天数，首次为 0） */
  elapsedDays: number
  /** 新算出的下次间隔（天） */
  nextIntervalDays: number
  /** 提交时的回忆概率（0–1，null=新词首次） */
  retrievabilityAtReview: number | null
  /** 是否“当天第一次反馈”（false = 只影响当日队列，不改长期状态） */
  longTermUpdate: boolean
  /** 本次学习耗时（ms，可空） */
  durationMs?: number
  // —— v2 撤销/改判（SPEC-v2 §3.3，全部可选；旧日志缺失按「不可撤销/未撤销」处理）——
  /** 评分前的完整 WordState 快照（撤销/改判的唯一依据；首评新词为 null/undefined = 撤销时 delete state） */
  stateBefore?: WordState | null
  /** 该条日志是否已被改判撤销（统计/遗忘曲线必须排除 corrected === true） */
  corrected?: boolean
  /** 撤销后重新评分的新日志 id（可追溯） */
  correctedBy?: number
}

// ============ 学习会话（w-c 状态机，见 §4） ============

export interface SessionSnapshot {
  wordId: string
  deckId: string
  /** 每个含义已记忆次数 */
  wcCounts: Record<string, number>
  wcActiveMeaningId: string | null
  /** 当前阶段：board/annotation/memory */
  stage: 'board' | 'annotation' | 'memory'
  startedAt: number
  updatedAt: number
}

// ============ 设置 / 元数据 ============

export type SettingsMap = {
  // —— 学习 ——
  'study.dailyGoal': number // 每日学习量（复习+新学，单词数）
  /** 新学词顺序（task-47）：'order'=词库顺序（默认）；'random'=按词库稳定随机序（plan 内退出重进/加量前缀稳定） */
  'study.newWordOrder': 'order' | 'random'
  /**
   * 每日复习上限（task-51）：0 = 不限（默认，保持官方语义）；1–9999 = 当日自动入队的到期复习最多 N 个。
   * 超出部分不删除/不改 dueAt（顺延 backlog），次日自然再次到期；手动加学/回炉不受限。
   */
  'study.dailyReviewCap': number
  'study.recallMode': 'en2cn' // v1 固定 en2cn（只做英→中）
  'board.exampleCount': number // 白板面英文例句条数
  'board.showPhonetic': boolean // 白板面是否显示音标+发音
  'board.showMeaningPhrases': boolean // F7：白板面各 c 英文词组（默认关）
  /** F10：引申图文字/Mermaid 轻量 Markdown 渲染（默认开） */
  'derivation.markdown': boolean
  // —— 记忆 w-c ——
  'memory.totalRepeats': number // 总次数
  /** task-137/F2：加权记忆最少/最多次数、强度 k（0–2） */
  'memory.weightedMin': number
  'memory.weightedMax': number
  'memory.weightedK': number
  'memory.mode': 'sequential' | 'random'
  'memory.showPhrases': boolean
  'memory.fontScale': number
  'memory.cardSize': number
  /** 三键标签切换（官方 is_first_show）：true=新词首次显示「认识/不确定/不认识」，之后「认识/模糊/忘记」 */
  'study.labelSwitch': boolean
  /** 三键副标题是否显示预测间隔（「N 天后 / 今日进度%」） */
  'memory.showPredictedInterval': boolean
  /** 是否允许「模糊」完成当日复习（官方默认不允许：模糊持续回炉到认识） */
  'study.allowVagueComplete': boolean
  // —— 外观 ——
  'app.fontScale': number
  'app.theme': 'system' | 'light' | 'dark'
  'app.reduceMotion': boolean
  // —— AI 生成（task-70，见 docs/ARCH-CONTENT-PACKS.md §7）——
  /** AI 总开关（默认 false，避免误调用/误扣费） */
  'ai.enabled': boolean
  'ai.provider': 'deepseek' | 'openai-compatible'
  /** OpenAI 兼容端点 baseURL；deepseek 默认 https://api.deepseek.com */
  'ai.baseUrl': string
  'ai.model': string
  /** ⚠️ 敏感：仅本机，不导出、不进日志/错误摘要（掩码显示） */
  'ai.apiKey': string
  /** Key 存储方式：persistent=存 IndexedDB（默认）；session=仅内存，刷新失效 */
  'ai.keyStorage': 'persistent' | 'session'
  /** 是否发送 response_format:{type:'json_object'}（默认 true）；部分免费模型不支持时关掉，靠 prompt+解析容错 */
  'ai.jsonMode': boolean
  /** 传输：auto=原生桥可用则 native，否则本地代理 */
  'ai.transport': 'auto' | 'proxy' | 'native'
  /** 每批目标数（1–50，默认 20） */
  'ai.batchSize': number
  /** 单次运行成本上限（元；0=不限制，默认 3） */
  'ai.maxCostPerRun': number
  /** 全量预生成（大纲全量分片）另用的预算（元，默认 40） */
  'ai.pregenBudget': number
  // —— 数据 ——
  'data.maimemoToken': string // MaiMemo个人 Token（仅本机，D23）
  'data.proxyUrl': string // 本地代理地址（CORS 绕行）
  'data.selectedDeckId': string // 当前在学词库 id
}
export type SettingKey = keyof SettingsMap

export interface SettingRecord<K extends SettingKey = SettingKey> {
  key: K
  value: SettingsMap[K]
  updatedAt: number
}

/** meta 表：杂项单值（schema 版本、内置词库种子版本、会话快照、导入记录等） */
export interface MetaRecord<T = unknown> {
  key: string
  value: T
  updatedAt: number
}

// ============ 词库文件 / 迁移包 / 导入报告（SPEC §1.5、§6.2、§6.4） ============

/** 词库文件格式 v1（导入/导出的标准 JSON，§1.5） */
export interface DeckFile {
  format: 'momo-deck'
  formatVersion: 1
  /** 导出时间 / 生成时间 */
  exportedAt: number
  generator: string // 'wordc@0.1.0'
  deck: Deck
  words: Word[]
  /** 数据来源与许可（必须原样导出，R-D20/D21） */
  meta: {
    wordCount: number
    license?: string
    sourceUrl?: string
    copyrightNotice?: string
  }
}

/** 可迁移包 v1（§6.2，D22） */
export interface MigrationFile {
  format: 'momo-migration'
  formatVersion: 1
  exportedAt: number
  generator: string // 'wordc@0.1.0'
  appVersion: string
  /** 载荷版本（数据格式版本），当前 1 */
  dataVersion: 1
  counts: { decks: number; words: number; states: number; reviewLogs: number }
  data: {
    decks: Deck[]
    words: Word[]
    states: WordState[]
    reviewLogs: ReviewLog[] // 可选导出；最多保留最近 20000 条
    settings: SettingRecord[] // ⚠️ 不含 data.maimemoToken（隐私，D23）
  }
  /** sha256(stableStringify({format,formatVersion,dataVersion,data})) 的小写 hex */
  checksum: string
}

/** 坏数据结构化错误（§6.4） */
export type ImportIssue = {
  level: 'error' | 'warning'
  code:
    | 'E_FORMAT'
    | 'E_VERSION'
    | 'E_CHECKSUM'
    | 'E_FIELD'
    | 'E_DUP'
    | 'E_IO'
    | 'W_NO_MEANING'
    | 'W_NO_PHONETIC'
    | 'W_SKIPPED'
  message: string // 中文，给用户看
  path?: string // 'words[12].meanings[0].cn'
  row?: number // CSV 行号（1 起）
  field?: string
}

export interface ImportReport {
  ok: boolean
  kind: 'deck' | 'migration' | 'csv' | 'maimemo'
  counts: { decks: number; words: number; states: number; reviewLogs: number; skipped: number }
  issues: ImportIssue[]
  durationMs: number
}
// ============ 今日学习计划 v2（SPEC-v2 §3.4 / ARCH-v2 §3.1） ============

/** 队列来源：goal=按当日目标建队；extra=手动加学；requeue=当日回炉 */
export type PlanWordSource = 'goal' | 'extra' | 'requeue'

/** plan 内的评分记录（撤销标记 corrected，**不删除**） */
export interface PlanRating {
  wordId: string
  rating: Rating
  reviewedAt: number
  /** 该次反馈是否更新了长期状态（与 ReviewLog.longTermUpdate 一致） */
  longTermUpdate: boolean
  /** 是否已被「回退改判」撤销 */
  corrected?: boolean
  /** 撤销后重新评分的 reviewLog id */
  correctedBy?: number
}

/** 一天一词库一份的今日学习计划（主键 = `${date}:${deckId}`） */
export interface DailyPlan {
  id: string
  /** 本地日期 'YYYY-MM-DD'（跨天失效） */
  date: string
  deckId: string
  /** 有序词 id 列表；当日回炉 = 同一 wordId 再次插入到较后位置（**允许重复**） */
  wordIds: string[]
  /** 当前学习到第几个（0 起；= 已处理次数，含回炉重复） */
  index: number
  /** 每个词的来源（调试/统计/续学提示；重复回炉记最后一次） */
  sources: Record<string, PlanWordSource>
  /** 建队时的目标快照（之后改设置不影响今日已建队列，次日生效） */
  goals: {
    dailyGoal: number
    dueCount: number
    newBudget: number
    extraCount: number
  }
  /** 已提交评分（按时间顺序；撤销标记 corrected，**不删除**） */
  ratings: PlanRating[]
  /** 可选：w-c 次数冗余（权威仍是 `meta:session:<wordId>`；导出迁移包需要） */
  wcCounts?: Record<string, Record<string, number>>
  createdAt: number
  updatedAt: number
  /** 完成时间（队列走完且评分全部提交）；未完成 null */
  completedAt: number | null
}

/** 首页学习按钮 6 态（文案由 UI 决定，core 只派生状态；SPEC-v2 §6.2） */
export type HomeStudyState =
  | { kind: 'no-deck' }
  | { kind: 'no-words' }
  | { kind: 'fresh'; pendingReview: number; pendingNew: number }
  | { kind: 'ongoing'; remaining: number; index: number; total: number }
  | { kind: 'done-with-overdue'; overdue: number }
  | { kind: 'done' }
