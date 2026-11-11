# SPEC · 全队唯一实现依据（v1.0 · 定稿）

> 状态：**定稿**（task-5 产出，2026-11-10）。优先级：**DECISIONS.md > 本文 > 三份 research**。
> 读者：dev-algo（task-6）、dev-data（task-7/8）、dev-ui（task-9/10）、QA（task-11）、集成（task-12）。
> 本文把「研究结论 + Lead 决策」落成**可直接编码的契约**：数据格式、调度公式、状态机、设置项、
> 导入导出、页面拆分、模块接口、验收标准（AC1–AC8）。
> 与 research 不一致处见 §11，均以 DECISIONS 为准。

---

## 0. 开工前必读（5 条硬约定）

1. **对外表述**：统一「**同源 MM/DHP 记忆模型 + 间隔重复调度**」，**禁止**宣称「每个单词的复习时间与MaiMemo App 一致」（D11）。
2. **数据只存本机**（IndexedDB），无后端；MaiMemo API 走「用户 Token + 本地代理」（D3/D23）。
3. **分层不许越界**（D27）：`src/core` 纯 TS；`src/data` 唯一可碰 IndexedDB / fetch；`src/ui` 只展示；`src/app` 只装配。
   `tests/architecture.test.ts` 已会拦截 core 越界。
4. **脚手架现状**：`src/core/types.ts`、`src/core/scheduling.ts`、`src/data/db.ts` 是 **arch 的占位实现**
   （旧的 ease/SM-2 模型、旧表结构）。task-6/7 直接按本文**替换类型与表结构**；因为还没有真实用户，
   Dexie 允许**重定义 version(1)**，不需要写迁移（开发机若已有旧库，删掉 IndexedDB 或调 `resetDatabase()`）。
5. **本文中的类型/签名是不可随意改的公共契约**。要改：先在团队里说明，并同步改 `src/core/index.ts` /
   `src/data/index.ts` / 本文 §9；改完必须 `pnpm test && pnpm build` 全绿（D26）。

### 0.1 术语表（本文统一用词）

| 术语 | 含义 | 代码名 |
|---|---|---|
| 词库 / 单词书 | 一本词表 | `Deck` |
| 单词/词条 | 英文词 + 释义/例句/助记/词组 | `Word` |
| 含义 | 一条中文释义（可能多义，每条带词性） | `Meaning` |
| 评分 | 认识 / 模糊 / 不认识（对应 familiar / vague / forgot） | `Rating` |
| 学习状态 | 某词在某词库下的记忆状态（DHP） | `WordState` |
| 记忆半衰期 | 回忆概率从 100% 降到 50% 的天数；内部主状态 | `state.stability`（h） |
| 难度 | WDR 难度，1–18（初始 1–10） | `state.difficulty`（d） |
| 记忆持久度 | 对外展示值 = 当前安排的复习间隔（天） | `state.nextIntervalDays` |
| 熟知度 | 对外展示值 = 当前回忆概率 | `state.retrievability`（p） |
| 不熟悉度 | `clamp01(clicks / encounters)` | `familiarity(clicks, encounters)` |
| w-c 流程 | 点「记忆」后「英文词 w → 中文释义 c」重复记忆页 | `MemoryStage` |
| 学习量 | 当日复习词数 + 新学词数（单位=单词数，不是分钟） | `dailyGoal` |

---

## 1. 数据格式 v1（TS 类型即规范）

### 1.1 通用约定

| 项 | 规则 |
|---|---|
| 时间字段 | `epoch ms`（number）。展示时用本地时区；**到期按「本地日期」**，见 §3.6 |
| 本地日期 key | `YYYY-MM-DD`（本地时区），函数 `localDateKey(ts)`（已有 `src/core/time.ts`） |
| 词条大小写 | `headword` 保留原拼写（如 `Internet`）；**匹配/去重一律 `headword.trim().toLowerCase()`** |
| id 生成 | 见 §1.4；**一旦生成永不变**（导入/合并/导出都靠它对齐） |
| 可选字段 | 统一 `?:` 表示可缺省；缺省不等于空串，读取时按默认值兜底 |
| 版本号 | 每种可导出/可持久化结构都带 `formatVersion`（当前 `1`） |
| 序列化 | 导出 JSON 用 `stableStringify`（对象 key 递归排序、无空格）以便 checksum 可复现 |

### 1.2 核心类型（直接写入 `src/core/types.ts`）

```ts
// ============ 词库 / 单词 ============
export type DeckSource = 'builtin' | 'imported' | 'custom' | 'maimemo'

export interface Deck {
  id: string                  // 'kaoyan-hongbaoshu-2025' | 'kaoyan-2027-dagang' | 用户导入生成的 id
  name: string                // 展示名，如「2025考研英语词汇受限商业词表（6702 词）」
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
  uk?: string                // 英式音标，含方括号，如 '[ˈspɪdə]'
  us?: string                // 美式音标
}

export interface Example {
  en: string
  cn?: string                // 中文翻译
  source?: string            // 词库来源说明（可选）
}

export interface Mnemonic {
  /** 助记类型（对齐MaiMemo：联想/谐音/词根/词源/串记/其他…） */
  type: '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他'
  text: string
}

export interface Phrase {
  en: string                 // 含目标词的英文词组/搭配
  cn: string                 // 中文
  /** task-42：归属含义 id（`${wordId}#M{i}`）；缺省 = 词级（旧数据兼容，w-c 不显示） */
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
  /** 官方词难度 d（1–10，WDR 难度；缺失时数据层 fallback 5 并标记 estimated） */
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
  createdAt: number
}

// ============ 记忆状态 ============
export type Rating = 'familiar' | 'vague' | 'forgot'
// familiar=认识(按钮1)  vague=模糊(按钮2)  forgot=不认识/忘记(按钮3)
// 注：MaiMemo的「熟知 wellFamiliar」v1 不实现（用户需求只要三个按钮，D16 语境），类型不预留。

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
  /** 当日复习进度 0–1（官方 Predict.progress 的本地等价模型，推断值） */
  todayProgress?: number
  /** todayProgress 所属本地日期 key（跨天归零） */
  todayProgressDate?: string
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
  'study.dailyGoal': number          // 每日学习量（复习+新学，单词数）
  'study.recallMode': 'en2cn'        // v1 固定 en2cn（只做英→中）
  'board.exampleCount': number       // 白板面英文例句条数
  'board.showPhonetic': boolean      // 白板面是否显示音标+发音
  // —— 记忆 w-c ——
  'memory.totalRepeats': number      // 总次数
  'memory.mode': 'sequential' | 'random'
  'memory.showPhrases': boolean
  'memory.fontScale': number
  'memory.cardSize': number
  'study.labelSwitch': boolean             // 默认 true（官方 is_first_show 标签切换）
  'memory.showPredictedInterval': boolean  // 默认 true（三键副标题显示预测间隔）
  'study.allowVagueComplete': boolean      // 默认 false（模糊不可完成当日复习）
  // —— 外观 ——
  'app.fontScale': number
  'app.theme': 'system' | 'light' | 'dark'
  'app.reduceMotion': boolean
  // —— 数据 ——
  'data.maimemoToken': string        // MaiMemo个人 Token（仅本机，D23）
  'data.proxyUrl': string            // 本地代理地址（CORS 绕行）
  'data.selectedDeckId': string      // 当前在学词库 id
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
```

### 1.3 默认值与校验（读取时兜底）

| 字段 | 默认 | 校验/备注 |
|---|---|---|
| `Deck.wordCount` | 0 | ≥0；展示用 |
| `Deck.version` | 1 | 整数 ≥1 |
| `Word.meanings` | `[{id: wordId+'#M1', cn: headword}]` | 空数组时按此兜底并打 `no-meaning` tag |
| `Word.examples` | `[]` | 最多展示 `board.exampleCount` 条 |
| `Word.phrases` | `[]` | w-c 页最多显示 3 条含当前 c 的词组 |
| `Word.order` | 导入顺序 | 排序与「顺序学习」都依赖它 |
| `WordState.stability` | `initialStability(5)≈1.7635` | 新词状态；>0，clamp 到 [0.1, 4096] 防 NaN |
| `WordState.difficulty` | 5 | 新词 clamp 1–10；更新后 clamp 1–18 |
| `WordState.phase` | 'new' | new/learning/review/lapsed/mastered/suspended |
| `WordState.sameDayDate` | `''` | 每次评分前若与今天不同则重置 `sameDayCount=0` |
| `WordState.retrievability` | 1 | 0–1 |
| `meaningStats[meaningId]` | `{clicks:0, encounters:0}` | 缺失即 0/0，展示 `—` |
| 设置项 | 见 §5 表 | 越界值读时 clamp，不抛错 |

### 1.4 id 生成规则（**必须一致，否则跨端/导入导出对不上**）

```ts
// 1) 规范化：去首尾空白 → 合并连续空白为单空格 → 小写
export function normalizeHeadword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

// 2) 词库 id（用户导入，避免中文/空格进 id）
//    slug = 取名称的 ASCII 部分/拼音不可得时的兜底：'deck-' + fnv1a32(name + ':' + createdAt)
export function newDeckId(name: string, createdAt = Date.now()): string {
  if (/^[a-z0-9-]+$/.test(name)) return name
  return `deck-${fnv1a32(`${name}:${createdAt}`).toString(36)}`
}

// 3) 单词 id：钉死为 `${deckId}:${normalizeHeadword(headword)}`
//    例：'kaoyan-hongbaoshu-2025:embrace'
export function wordIdOf(deckId: string, headword: string): string {
  return `${deckId}:${normalizeHeadword(headword)}`
}

// 4) 含义 id：按数组下标从 1 开始，`${wordId}#M${i+1}`
//    例：'kaoyan-hongbaoshu-2025:embrace#M1'
//    注意：含义数组顺序一旦导入就固定，UI 不得重排（重排会破坏 meaningStats 对齐）
export function meaningIdOf(wordId: string, index1Based: number): string {
  return `${wordId}#M${index1Based}`
}

// 5) 内置词库 id 固定（来自 data/raw/normalized 的 deck.id，不许改）：
//    kaoyan-hongbaoshu-2025（受限商业词表 6702 词，默认）
//    kaoyan-2027-dagang（考研大纲 5528 词，源 5530 条按 normalizeHeadword 去重）
```

`fnv1a32(str): number` 用 32 位 FNV-1a 实现（纯函数放 `src/core/ids.ts`，dev-algo 提供，dev-data 使用）。

### 1.5 词库文件格式 `DeckFile v1`（导入/导出的标准 JSON）

```ts
export interface DeckFile {
  format: 'momo-deck'
  formatVersion: 1
  /** 导出时间 / 生成时间 */
  exportedAt: number
  generator: string              // 'wordc@0.1.0'
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
```

示例（受限商业词表转换后前 1 条）：

```json
{
  "format": "momo-deck",
  "formatVersion": 1,
  "exportedAt": 1762790000000,
  "generator": "wordc@0.1.0",
  "deck": {
    "id": "kaoyan-hongbaoshu-2025",
    "name": "2025考研英语词汇受限商业词表（6702 词）",
    "description": "MaiMemo内置词库导出的 2025 版受限商业词表词表，释义来自 ECDICT。",
    "source": "builtin",
    "builtinKey": "hongbaoshu-2025",
    "wordCount": 6702,
    "version": 1,
    "license": "词表版权归MaiMemo背单词/受限商业词表出版方，仅限个人学习，禁止商用",
    "isDefault": true,
    "createdAt": 1762790000000,
    "updatedAt": 1762790000000
  },
  "words": [
    {
      "id": "kaoyan-hongbaoshu-2025:embrace",
      "deckId": "kaoyan-hongbaoshu-2025",
      "headword": "embrace",
      "headwordLower": "embrace",
      "phonetic": { "uk": "[ɪmˈbreɪs]", "us": "[ɪmˈbreɪs]" },
      "meanings": [
        { "id": "kaoyan-hongbaoshu-2025:embrace#M1", "pos": "n.", "cn": "拥抱" },
        { "id": "kaoyan-hongbaoshu-2025:embrace#M2", "pos": "vt.", "cn": "拥抱；信奉，皈依；包含" }
      ],
      "examples": [],
      "mnemonics": [],
      "phrases": [],
      "tags": ["考研", "受限商业词表"],
      "order": 1,
      "chapter": "必考词 Unit 1",
      "createdAt": 1762790000000
    }
  ],
  "meta": {
    "wordCount": 6702,
    "license": "词表版权归MaiMemo背单词/受限商业词表出版方，仅限个人学习，禁止商用",
    "copyrightNotice": "非官方词表，禁止商用；2027 版尚未公开。"
  }
}
```

### 1.6 内置词库：从 `data/raw/normalized/` 转换进 `src/data/builtin/`（**AC7**）

**源文件（已存在，勿改）**

| 文件 | 结构 | 规模 | 用途 |
|---|---|---|---|
| `data/raw/normalized/kaoyan-2027-dagang.normalized.json` | `{schemaVersion, deck, words[]}` | 源 5530 条 → 去重后 **5528** 个唯一 headword（内置写入 5528） | 内置词库 2「2027考研英语大纲词汇（约5500）」 |
| `data/raw/normalized/hongbaoshu-2025.normalized.json` | `{schemaVersion, deck, words[]}` | 6702 条 / 6702 唯一 | **内置词库 1（默认）「2025考研英语词汇受限商业词表（6702 词）」** |

**必须做的转换（脚本 `scripts/build-builtin-decks.mjs`，由 dev-data 在 task-7 实现）**

```
输入：data/raw/normalized/*.normalized.json
输出：src/data/builtin/kaoyan-hongbaoshu-2025.deck.json
     src/data/builtin/kaoyan-2027-dagang.deck.json
     src/data/builtin/index.ts（含 ensureBuiltinDecks()，见 §9）
```

逐字段映射（源字段 → 目标字段）：

| normalized 源字段 | DeckFile/Word 目标 | 规则 |
|---|---|---|
| `deck.id/name/description/source` | `Deck.*` | `source` 统一改为 `'builtin'`；`version:1`；`license` 取源 `deck.license`；受限商业词表加 `isDefault: true` |
| `words[].term` | `Word.headword` | trim，保留原拼写 |
| （派生） | `Word.headwordLower` | `normalizeHeadword(term)` |
| `words[].id` | **丢弃，重算** | 必须用 `wordIdOf(deckId, term)` 重算（保证 id 规则唯一） |
| `words[].meaning`（字符串，可能含 `\n`） | `Word.meanings[]` | 按 `\n` 拆行；每行用 `/^([a-z]{1,5}\.|phr\.)\s*/i` 提取 `pos`，其余为 `cn`；空行丢弃；编号规则 §1.4。若无换行则单条、`pos` 可空 |
| `words[].example` + `exampleTranslation` | `Word.examples[0]` | `{en, cn}`；`cn` 可为空 |
| `words[].phonetic` | `Word.phonetic` | 源为 `null` → 留空；若为字符串 → `{uk: s, us: s}` |
| `words[].tags` | `Word.tags` | 直接复制；无释义的条目追加 `'no-meaning'`（受限商业词表 18 条） |
| `words[].order` | `Word.order` | 直接复制；缺失时用数组下标+1 |
| `words[].chapter` | `Word.chapter` | 受限商业词表有；大纲词表没有 → 用 `words[].category` 兜底 |
| `words[].frequency / cefr / examCount / category` | `Word.frequency / cefr / examCount / chapter` | 有则复制 |
| — | `Word.mnemonics/phrases` | 均为 `[]`；`Word.createdAt = 构建时间戳常量`（固定值，保证构建可复现） |

**验收断言（AC7）**：`ensureBuiltinDecks()` 后
`decks.length === 2`、`decks.find(isDefault).id === 'kaoyan-hongbaoshu-2025'`、
`words.filter(deckId==='kaoyan-hongbaoshu-2025').length === 6702`、
`words.filter(deckId==='kaoyan-2027-dagang').length === 5528`（源 5530 条按 `normalizeHeadword` 去重，`may/May`、`march/March` 两对大小写变体各保留首次出现）、
受限商业词表所有 word 的 `id` 均以 `'kaoyan-hongbaoshu-2025:'` 开头且 `meanings.length ≥ 1`。

**打包方式**：`src/data/builtin/*.deck.json` 由 Vite 动态 `import()` 拆成独立 chunk（每个约 2.5 MB，
gzip 后 ~700 KB），首启时后台调用 `ensureBuiltinDecks()` 写入 Dexie，之后读库不读文件；
**不要**把 JSON 直接静态 import 进主 bundle（会让首屏 +5 MB）。

---

## 2. 存储 schema（Dexie v1，写入 `src/data/db.ts`）

### 2.1 表与索引（**按此重写 version(1)**）

```ts
export class AppDatabase extends Dexie {
  decks!: EntityTable<Deck, 'id'>
  words!: EntityTable<Word, 'id'>
  states!: EntityTable<WordState, 'wordId'>
  reviewLogs!: EntityTable<ReviewLog, 'id'>
  settings!: EntityTable<SettingRecord, 'key'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor() {
    super('momo-reword')
    this.version(1).stores({
      // 词库：按来源、更新时间查
      decks: 'id, name, source, builtinKey, updatedAt',
      // 单词：词库内按 order 取；按 headwordLower 查重/搜索；按标签过滤
      words: 'id, deckId, [deckId+order], headwordLower, *tags, updatedAt',
      // 状态：查“今天到期”/“某词库的新词”/“某阶段”
      states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
      // 日志：统计按时间范围；某词的复习历史
      reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
      settings: 'key',
      meta: 'key',
    })
  }
}
```

- 表名必须是 `decks/words/states/reviewLogs/settings/meta`（dev-data、dev-algo、dev-ui 都按这个名）。
- `words` 的 `*tags` 是 multiEntry 索引（Dexie 语法：`*tags` → 数组索引），用于「按标签筛选」。
- 旧库（arch 占位版 `reviewStates/dailyStats` 等）不迁移：开发期直接 `await db.delete()` 重建。

### 2.2 写入规则（并发/一致性）

1. **所有写操作走 `db.transaction('rw', ...)`**：一次 `submitRating` 要在同一事务里写
   `states + reviewLogs + meta(上次学习日期)`，避免中途退出造成状态与日志不一致。
2. `WordState` 每次写必须更新 `updatedAt`；`reviewLogs` 只追加、不改不删（统计口径依赖它）。
3. `settings` 单行写（`put({key, value, updatedAt})`），读时合并 §5 默认值。
4. `meta` 约定 key：
   | key | value | 用途 |
   |---|---|---|
   | `schemaVersion` | `1` | 结构版本 |
   | `builtin.seeded` | `{ hongbaoshu: number, dagang: number }`（词库 version） | `ensureBuiltinDecks` 幂等判断 |
   | `session:<wordId>` | `SessionSnapshot` | D15：w-c 中途退出保留次数 |
   | `lastStudyDate` | `'YYYY-MM-DD'` | 首页「今日已学」判断 |
   | `import:last` | `{ at:number; kind:'deck'|'migration'|'maimemo'; report:ImportReport }` | 设置页展示上次导入结果 |
5. **UI 禁止直接 `db.put/delete`**：一律走 `src/data` 导出的函数（§9.2）。

### 2.3 查询约定（性能）

- 今日队列：`db.states.where('dueAt').belowOrEqual(now).and(s => s.phase==='review' || s.phase==='lapsed')`
  （`now` 取当前时刻；`dueAt` 是到期日 00:00，见 §3.6）＋ 该词库过滤 `deckId`。
- 新词：`db.states.where('[deckId+phase]').equals([deckId, 'new'])`，按 `words.order` 排序。
- 词库列表进度：`db.states.where('deckId').equals(deckId).count()` 与按 phase 分组计数。
- 搜索：`db.words.where('headwordLower').startsWith(qLower)`（≥1 字符才查，debounce 200ms）。
- 5000+ 词列表用虚拟滚动（dev-ui），数据层提供分页 `getWordsPage(deckId, {offset, limit, filter, search})`。

---

## 3. 调度规格（**AC1/AC2 的核心**，dev-algo 照此实现 `src/core`）

### 3.1 模型与策略（DECISIONS D5–D11）

| 项 | 定稿 |
|---|---|
| 状态模型 | **DHP**：难度 `d` + 记忆半衰期 `h` + 回忆概率 `p = 2^(-Δt/h)`（KDD'22 官方公式，MIT 代码核对） |
| 默认调度策略 | **保留率阈值法**（MM-3.2+ 生产口径）：`nextInterval = clamp(round(-h·log2(R_target)), 1, 365)`，`R_target = 0.9` |
| 备选策略 | SSP-MMC 策略表（`vendor/research-algo/ssp-mmc-policy/policy.json`）与 FSRS-6 **不默认启用**，只作为 dev-algo 可选 A/B（D8）；v1 不实现 A/B UI |
| 初始难度 | `d0 = 5`（固定，D7）；预留 `difficultyPrior(word)` 钩子（词频代理：`frequency` 越大 d0 越小，v1 可不启用） |
| 初始半衰期 | `h0 = -1 / log2(max(0.925 - 0.05·d0, 0.025))` → d0=5 时 `h0≈1.7635`（`-1/log2(0.675)=1.7635`） |
| 间隔边界 | `[1, 365]` 天，**到 365 后继续复习**（官方无「完全记住」概念，help30 §5） |
| 评分语义 | 认识=familiar（成功）；模糊=vague（回忆失败，难度不变）；不认识=forgot（回忆失败，难度+2，强制次日复习）（D9） |
| 长期状态写入 | **只有「当天第一次反馈」影响长期调度**（h/d/dueAt）；同一天后续评分的反馈只影响当日队列顺序（help30 §2） |
| 当日回炉 | 不认识的词当天再出现 1 次、模糊的词当天再出现 1 次；队列位置见 §3.9（D10 参数 4/8 个词位） |
| 不熟悉度 | `f = clamp01(clicks / encounters)`；0/0 展示 `—`；原始计数不截断（D14/§4.6） |
| 对外表述 | 「同源 MM/DHP 调度模型」，不承诺逐词与官方一致（D11） |

### 3.2 `src/core/params.ts` 默认参数（全部集中，便于校准/测试）

```ts
export interface AlgoParams {
  // —— DHP 更新（KDD'22 官方代码参数，禁止随意改）——
  recallExp: 3.81; recallDExp: -0.534; recallHExp: -0.127; recallFiExp: 0.970;
  forgetExp: -0.041; forgetDExp: -0.041; forgetHExp: 0.377; forgetFiExp: -0.227;
  // —— 难度 ——
  d0: number;              // 5
  dMin: number;            // 1
  dMax: number;            // 18
  dFailStep: number;       // 2（仅 forgot 加）
  dVagueStep: number;      // 0（模糊不加难度；可 A/B 设 1）
  dInitialMax: number;     // 10（新词初始难度上限）
  // —— 初始半衰期 ——
  startPBase: number;      // 0.925
  startPStep: number;      // 0.05
  startPFloor: number;     // 0.025
  // —— 调度 ——
  retentionTarget: number; // 0.9（区间 0.85–0.92，MRL 概念预留）
  intervalMin: number;     // 1
  intervalMax: number;     // 365
  forceNextDayOnForgot: boolean; // false（task-26：忘记不再强制次日）
  // —— 新词首评间隔（research 04 §11.4 候选 A）——
  firstIntervalK: number;       // 80（research-algo 6 样本拟合；拟合经验常数，非官方值；
                                //   官方同难度实测 56/62/78 天 → 逐词复刻不可达，仅保证落在区间）
  firstFamiliarMin: number;     // 7
  firstFamiliarMax: number;     // 90
  firstVagueIntervalK: number;  // 100（首评模糊独立常数，与认识 K=80 解耦）
  firstVagueMin: number;        // 1
  firstVagueMax: number;        // 7
  firstForgetDays: number;      // 1
  // —— 三键「今日进度%」（research 04 §5.3，推断值）——
  progressBase: number;         // 0.2
  progressFamiliarStep: number; // 0.4
  progressVagueStep: number;    // 0.2
  progressForgetStep: number;   // 0
  progressFailCap: number;      // 0.8
  // —— v2 档位模型（Lead 2026-11-11 实机 face/cat/yellow 交叉验证；D 级推算）——
  progressModelMode: 'v1-20pp' | 'v2-levels'; // 默认 'v2-levels'（Lead 拍板；v1 保留回滚/A-B）
  progressLevels: ReadonlyArray<ProgressLevel>; // 5 档（见下表）
  progressOnVague: Readonly<Record<number, LevelTransition>>;
  progressOnForget: Readonly<Record<number, LevelTransition>>;
  progressOnFamiliar: Readonly<Record<number, LevelTransition>>; // to:'complete' = 完成当日
  progressInitialLevelVague: number;   // 1 = L1a（首评「不确定」）
  progressInitialLevelForget: number;  // 2 = L1b（首评「不认识」）
  canFinishMode: 'table' | 'always' | 'never' | 'level>=3' | 'afterFirstFail'; // 默认 'table'

  interface ProgressLevel { name: string; vague: number; forget: number; familiar: number | 'days' }
  interface LevelTransition { to: number | 'complete'; inferred?: boolean }
  // —— 同日回炉（D10，推测值，可 A/B）——
  requeueGapForgot: number; // 4（往后第 4 个词再出现）
  requeueGapVague: number;  // 8
  sameDayMinAppearForgot: number; // 2（当天至少出现 2 次）
  sameDayMinAppearVague: number;  // 2
  // —— 防御 ——
  stabilityMin: number;     // 0.1
  stabilityMax: number;     // 4096
  dayMs: number;            // 86_400_000
}
export const DEFAULT_PARAMS: AlgoParams = { /* 上列默认值 */ }
```

> 所有 `src/core` 函数最后一个参数都允许传 `params?: Partial<AlgoParams>`，默认 `DEFAULT_PARAMS`；
> 这样 QA/单测能注入边界值，不污染全局。

### 3.3 公式（**逐字实现，系数不可改**）

```ts
/** 回忆概率 p = 2^(-Δt/h)，Δt 单位天（可为小数） */
export function retrievability(h: number, elapsedDays: number): number {
  if (!Number.isFinite(h) || h <= 0) return 0
  const p = Math.pow(2, -Math.max(0, elapsedDays) / h)
  return clamp01(p)
}

/** 初始半衰期（公式 5） */
export function initialStability(difficulty: number): number {
  const p0 = Math.max(0.925 - 0.05 * clamp(difficulty, 1, 10), 0.025)
  return -1 / Math.log2(p0)
}

/** 答对后 h'（公式 2，r=1） */
export function stabilityAfterRecall(d: number, h: number, p: number): number {
  const gain = Math.exp(3.81) * Math.pow(d, -0.534) * Math.pow(h, -0.127)
    * Math.pow(1 - p, 0.970)
  return h * (1 + gain)
}

/** 答错后 h'（公式 3，r=0；注意是重新赋值，不是乘系数） */
export function stabilityAfterForget(d: number, h: number, p: number): number {
  const fi = Math.max(1e-4, 1 - p)          // 防 0^负数
  return Math.exp(-0.041) * Math.pow(d, -0.041) * Math.pow(h, 0.377) * Math.pow(fi, -0.227)
}

/** 保留率阈值策略（默认调度） */
export function intervalFromRetention(h: number, rTarget = 0.9): number {
  const raw = -h * Math.log2(rTarget)
  return clamp(Math.round(raw), 1, 365)
}

// ===== task-26 新增：新词首评间隔（research 04 §11.4 候选 A；K=80 / K_v=100 为拟合经验常数，非官方值）=====
export function firstFamiliarHalfLife(d: number): number {   // h = K·h0(d)
  return FIRST_INTERVAL_K * initialStability(clamp(d, 1, 10))
}
export function firstFamiliarDays(d: number): number {       // 认识：7–90 天
  return clamp(Math.round(-firstFamiliarHalfLife(d) * Math.log2(0.9)), 7, 90)
}
export function firstVagueDays(d: number): number {          // 模糊：1–7 天（独立 K_v，与认识 K 解耦）
  const hv = stabilityAfterForget(clamp(d, 1, 10), FIRST_VAGUE_INTERVAL_K * initialStability(clamp(d, 1, 10)), 0.9)
  return clamp(Math.round(-hv * Math.log2(0.9)), 1, 7)
}
export function firstForgetDays(): number { return 1 }       // 忘记：固定 1 天
```

**首评间隔基准**（候选 A；认识 **K=80**、模糊 **K_v=100**（二者解耦），单测锁定，容差 ±1 天）：
> ⚠️ 官方实机同难度样本并不唯一：d=1 的「认识」实测 **56 / 62 / 78** 天、「模糊」**2 / 3** 天
>（`docs/research/assets/official-app/MEASUREMENTS-2026-11-11.md`）→ **逐词复刻在原理上不可达**，
> 我们只保证落在官方实测区间内；认识 K=80 让 d=1→63（区间中部，MAE≈9.5）、d=2→44（官方 this=43）；
> 模糊 K_v=100 让 d=1→3（官方 4/5 样本为 3 天）。

| 官方难度 d | 认识 | 模糊 | 忘记 |
|---|---|---|---|
| 1 | 63 | 3 | 1 |
| 2 | 44 | 2 | 1 |
| 3 | 33 | 2 | 1 |
| 5 | 21 | 2 | 1 |
| 10 | 10 | 1 | 1 |

**连续「认识」基准**（d0=5；首评 21 天，之后沿用 DHP 更新+阈值法；h 相对误差 ≤1%，间隔取整 `Math.round`）：

| 次序 | 复习时 p | 更新后 h | 下次间隔（天） |
|---|---|---|---|
| 1（新学/认识） | 1（新词，候选 A K=80） | 141.08 | 21 |
| 2 | 0.902 | 292.27 | 44 |
| 3 | 0.9009 | 580.80 | 88 |
| 4 | 0.9003 | 1109.40 | 169 |
| 5 | 0.8998 | 2044.04 | 311 |
| 6 | 0.8999 | 3635.71 | 365（封顶，之后保持 365） |

> 说明：旧基准（首评 1 天 → 1,2,5,11,24…）是 task-26 前「新词全部次日复习」bug 的产物，已废弃。
> **忘记不再强制次日**：非首评忘记按答错公式算出 h' 后再走阈值法（通常 1 天，高 h 时可能 2/7 天）；首评忘记固定 1 天。

### 3.4 rating → 状态更新规则

**新词首评（`isFirstEver`，task-26 候选 A）**：

| rating | 按钮 | 二元结果 r | h 更新 | d 更新 | 下次长期间隔 |
|---|---|---|---|---|---|
| `familiar` | 认识 | 1 | `h = K·h0(d)`（K=80） | 不变 | `firstFamiliarDays(d)` = clamp(round(−K·h0·log2 R), **7, 90**)（d=1→63、d=2→44、d=3→33、d=5→21、d=10→10） |
| `vague` | 模糊 | 0 | `h = forgetHalfLife(d, K_v·h0, R)`（K_v=100，独立于 K） | 不变（`dVagueStep=0`） | `firstVagueDays(d)` = clamp(round(−h'·log2 R), **1, 7**)（d=1→3、d=2→2、d=3→2、d=5→2、d=10→1） |
| `forgot` | 不认识 | 0 | `h = h0(d)`（回到初始） | `min(d+2, 18)` | **固定 1 天**（`firstForgetDays`） |

**非首评（复习日首评 / 之后每次）**：

| rating | 按钮 | 二元结果 r | h 更新 | d 更新 | 下次长期间隔 |
|---|---|---|---|---|---|
| `familiar` | 认识 | 1 | 公式 2 | 不变 | `intervalFromRetention(h')` |
| `vague` | 模糊 | 0 | 公式 3 | 不变（`dVagueStep=0`） | `intervalFromRetention(h')`，通常 1–5 天 |
| `forgot` | 不认识 | 0 | 公式 3 | `min(d+2, 18)` | `intervalFromRetention(h')`（**不再强制次日**；通常 1 天，高 h 可能 2/7 天） |

> 依据：官方训练代码 `responses_dict = {'1':1,'2':0,'3':0}`（模糊与忘记都算回忆失败），
> 「模糊不升难度 / 忘记升难度」是策略侧工程选择（证据 D，见 research §3.4）。
> task-26：忘记不再强制次日（官方语义「结合难度与记忆等级重算」，research 04 §6）；`forceNextDayOnForgot` 默认 false，仅作 A/B 开关。

**三键预测 `predictAll(state, now)`（task-26 A，官方 Web 协议 Predict 结构）**：

```ts
interface Predict { first: boolean; days: number; progress: number }
type WordPredicts = Record<Rating, Predict>   // { familiar, vague, forgot }

// 今日首评：first=true；新词走首评间隔，已学词走 DHP；认识 progress=1，模糊/忘记 progress=0.2
// 同日回炉：first=false；days=当前 nextIntervalDays（长期不变）；progress 按 20pp 模型投影：
//   认识 +40pp（可达 100%＝完成当日复习）、模糊 +20pp、忘记 +0pp；模糊/忘记封顶 80%
predictAll(state, now): WordPredicts
isFirstShow(state): boolean    // 官方 is_first_show = state.firstSeenAt == null（决定按钮标签）
```
> UI 格式化（research 04 §3.2，逐字）：`progress>=1 → "{days} 天后"`；`first → "今日 / {days} 天后"`；否则 `"今日进度{round(progress*100)}%"`。
>
> **进度模型 v2（Lead 2026-11-11 拍板：默认启用，D 级推算）**——5 档状态机（实机 face/cat/yellow 三词交叉验证）：
>
> | 档位 | V（模糊） | W（忘记） | F（认识） | 说明 |
> |---|---|---|---|---|
> | L1a (level 1) | 60% | 20% | 80% | 当日首评「不确定」后的初始档 |
> | L1b (level 2) | 40% | 20% | 60% | 当日首评「不认识」后的初始档 |
> | L2 (level 3) | 60% | 40% | N天后（可完成） | |
> | L3 (level 4) | 80% | 60% | N天后（可完成） | |
> | L4 (level 5) | 80% | 80% | N天后（可完成） | |
>
> 转移（实测；`inferred=true` 为未实测外推，参数里标注）：
> - **模糊**：L1a→L2、L2→L3、L3→**L3（停住）**、L4→L3；`L1b+模糊→L1a`（inferred）
> - **忘记**：L3→L2、L2→**L1a**（回到 80/60/20）；`L1a+忘记→L1b`、`L1b+忘记→L1b`、`L4+忘记→L2`（inferred）
> - **认识**：L1b→L2、L1a→L3（**实测**）；L2、L3→**完成当日**（**实测**）；`L4+认识→完成`（**inferred，未实测**，保守按完成）
> - 首评：不确定→L1a、不认识→L1b、认识→当日完成
> - `N` 用首次反馈算出的长期间隔（不另算）：`dueAt` 与同日反馈均复用 `nextIntervalDays`。
>
> 端到端基准（`tests/core/progress-v2.test.ts` 锁定）：
> face：60/40/20 → 认识 → (N天后/60/40) → 认识 → 完成；
> cat：80/60/20 → 模糊 → 60/40 → 模糊 → 80/60 → 模糊 → 80/60 → 忘记 → 60/40 → 忘记 → 80/60/20 → 认识 → 80/60（N天后）→ 认识 → 完成；
> yellow：80/60/20 → 模糊 → 60/40 → 模糊 → 80/60 → 模糊 → 80/60 → 忘记 → 60/40 → 认识 → 完成。
> 旧 20pp 单标量模型已被实机反例证伪，仅保留 `progressModelMode='v1-20pp'` 做回滚/A-B。
> ⚠️ 截图 05（认识 80% / 模糊 60% / 忘记 40%）**不在 5 档表中**；cat 实测验证的是 `L2+忘记→L1a`
> 得到 80/60/**20**，两者不等 → 截图 05 仍为**未解释观测（U15，可能为 L1a+忘记 的低档位状态）**，
> 文档/测试不得写「截图 05 已验证」。

### 3.5 `scheduleNext(state, rating, now)` 精确伪代码

```ts
export interface ScheduleResult {
  state: WordState          // 新状态（不可变更新，不修改入参）
  log: ReviewLog            // 待写入日志（id 由 Dexie 生成）
  longTermUpdate: boolean   // 是否更新了长期状态
}

export function scheduleNext(
  prev: WordState,
  rating: Rating,
  now: number,
  params: AlgoParams = DEFAULT_PARAMS,
): ScheduleResult {
  const today = localDateKey(now)
  const isFirstEver = prev.lastReviewedAt == null
  const isFirstToday = isFirstEver || localDateKey(prev.lastReviewedAt!) !== today
  const sameDayCount = isFirstToday ? 1 : prev.sameDayCount + 1

  // 1) 当天非首次反馈：不改 h/d/dueAt/phase，只累计计数、今日进度与日志
  if (!isFirstToday) {
    const log = makeLog(prev, prev, rating, now, { longTermUpdate: false })
    const todayProgress = progressAfter(rating, todayProgressOf(prev, today), params)
    return {
      state: { ...prev, sameDayCount, todayProgress, todayProgressDate: today, lastRating: rating, updatedAt: now },
      log,
      longTermUpdate: false,
      requeue: requeueKindOf(rating),      // 模糊/不认识可反复回炉，直到认识
    }
  }

  // 2) 当天第一次反馈：更新长期状态
  let d = clamp(prev.difficulty, params.dMin, params.dMax)
  let h: number
  let p: number
  let intervalDays: number
  if (isFirstEver) {
    // 新词首评（task-26 候选 A）：认识/模糊不再一律 1 天；忘记固定 1 天
    d = clamp(prev.difficulty, params.dMin, params.dInitialMax)  // 默认 5（官方难度优先）
    p = 1
    if (rating === 'familiar') {
      h = params.firstIntervalK * initialStability(d)
      intervalDays = firstFamiliarDays(d)
    } else if (rating === 'vague') {
      h = stabilityAfterForget(d, params.firstIntervalK * initialStability(d), params.retentionTarget)
      intervalDays = firstVagueDays(d)
    } else {
      h = initialStability(d)                    // 忘记：回到初始半衰期
      intervalDays = params.firstForgetDays      // 固定 1 天
    }
  } else {
    const elapsedDays = Math.max(0, (now - prev.lastReviewedAt!) / params.dayMs)
    p = retrievability(prev.stability, elapsedDays)
    h = rating === 'familiar'
      ? stabilityAfterRecall(d, prev.stability, p)
      : stabilityAfterForget(d, prev.stability, p)
    // task-26：忘记不再强制次日（按公式重算）；forceNextDayOnForgot 仅 A/B
    intervalDays = rating === 'forgot' && params.forceNextDayOnForgot
      ? 1
      : intervalFromRetention(h, params.retentionTarget)
  }
  if (rating === 'forgot') d = clamp(d + params.dFailStep, params.dMin, params.dMax)
  h = clamp(h, params.stabilityMin, params.stabilityMax)

  // 3) 下次间隔与到期日
  intervalDays = clamp(intervalDays, params.intervalMin, params.intervalMax)
  const dueAt = startOfLocalDay(addDays(now, intervalDays))   // 到期日 00:00（本地）

  // 4) 计数与字段
  const next: WordState = {
    ...prev,
    phase: rating === 'familiar' ? 'review' : (prev.phase === 'new' || prev.phase === 'learning' ? 'learning' : 'lapsed'),
    stability: h,
    difficulty: d,
    reps: prev.reps + (rating === 'familiar' ? 1 : 0),
    lapses: prev.lapses + (rating === 'familiar' ? 0 : 1),
    firstSeenAt: prev.firstSeenAt ?? now,
    lastReviewedAt: now,
    dueAt,
    nextIntervalDays: intervalDays,
    retrievability: p,                 // 结算时刻的快照
    lastRating: rating,
    sameDayCount,
    sameDayDate: today,
    sameDayRequeued: 0,
    todayProgress: rating === 'familiar' ? 1 : params.progressBase,  // 首评：认识=完成当日；失败=基准20%
    todayProgressDate: today,
    updatedAt: now,
  }
  return { state: next, log: makeLog(prev, next, rating, now, { longTermUpdate: true, p, intervalDays }), longTermUpdate: true }
}
```

实现注意（dev-algo 必读）：
1. **`isFirstEver` 路径禁止套公式 3**（`p=1` 时 `(1-p)^-0.227 = Infinity`）。
2. **`dueAt` 用本地日期 00:00**，不是 `now + n*86400000`（深夜学习否则次日不到期）。
3. `phase` 定义：新词首次学完 → `review`（认识）/ `learning`（模糊/不认识）；之后认识 → `review`，不认识 → `lapsed`；`mastered` 仅在 v2「熟知」功能出现，v1 不会产生。
4. 所有函数必须**纯函数**（不改入参、不读时钟），`now` 一律显式传入（单测可固定时间）。
5. 计算 `elapsedDays` 用毫秒差 / `dayMs`（允许小数）；不要用 `localDateKey` 相减得到天数差以外的方式。
6. **新词首评不能一律 1 天**（task-26 用户 P0）：认识用 `firstFamiliarDays(d)`（7–90 天）、模糊用 `firstVagueDays(d)`（1–7 天）、忘记 1 天。
7. **忘记不再强制次日**：非首评忘记走 `intervalFromRetention(h')`；`forceNextDayOnForgot` 默认 false。
8. **今日进度** `todayProgress`：首评认识=1、首评失败=0.2；同日反馈认识+0.4 / 模糊+0.2 / 忘记+0，失败封顶 0.8；仅影响三键文案（`predictAll`），不影响长期间隔。

### 3.6 「到期」判定口径

```ts
/** dueAt 是到期日 00:00（本地）。当天任何时刻均视为到期。 */
export function isDue(state: WordState, now: number): boolean {
  return state.phase !== 'new' && state.phase !== 'mastered' && state.phase !== 'suspended'
    && state.dueAt != null && state.dueAt <= now
}

/** 新词是否可进入学习队列（受 dailyGoal 配额控制） */
export function isNew(state: WordState): boolean { return state.phase === 'new' }
```

### 3.7 展示派生值

```ts
/** 记忆持久度（对外展示，天）= 当前安排的复习间隔 */
export function memoryDurabilityDays(state: WordState): number { return state.nextIntervalDays }

/** 熟知度（对外展示，0–1）= 当前回忆概率（实时计算） */
export function retrievabilityNow(state: WordState, now: number): number {
  if (state.lastReviewedAt == null) return 1
  return retrievability(state.stability, Math.max(0, (now - state.lastReviewedAt) / 86_400_000))
}

/** 不熟悉度 f（0–1），encounters=0 → 返回 null（UI 展示 “—”） */
export function familiarity(clicks: number, encounters: number): number | null {
  if (encounters <= 0) return null
  return clamp01(clicks / encounters)
}
```

### 3.8 每日队列 `pickQueue`（AC4/AC6 依赖）

> **task-51**：`QueueOptions.reviewCap?: number` 由设置 `study.dailyReviewCap` 驱动（默认 0=不限）。
> cap>0 时 `reviewQueue = 按遗忘度排序的到期词.slice(0,cap)`，`dueCount=reviewQueue.length`、
> `dueTotal=全部到期数`、`newBudget=max(0,dailyGoal-reviewQueue.length)`；超出部分 dueAt 不变（顺延 backlog）。
>
> **task-47**：`QueueOptions.newOrder: 'order' | 'random'` 由设置 `study.newWordOrder` 驱动
> （默认 `random`）。plan 驱动的建队不使用裸随机，而是用 plan 稳定种子对每个词算排序键
> （`newWordOrderKey(planId,wordId)`，`planId=date:deckId`）→ 退出重进/改学习量后顺序稳定、前缀一致，
> 详见 `docs/DATA-API.md` §15。

**规则（官方语义，research §7.6 + task-26 用户 P0）**：每日学习量 = 复习 + 新学**目标**（单位=单词数）；
**先复习后新学**；复习按遗忘程度从高到低（`retrievabilityNow` 升序）。
**复习量不硬截断**：所有到期词都进 `reviewQueue`；`newBudget = max(0, dailyGoal - dueCount)`（复习超目标 → 新学 0）。

```ts
export interface QueueOptions {
  now: number
  dailyGoal: number            // 设置 study.dailyGoal，默认 30
  /** 指定词库（null = 所有词库） */
  deckId?: string | null
  /** 新词排序：'order'（词库顺序，默认）| 'random' */
  newOrder?: 'order' | 'random'
  /** 用户手动「加学」的词：立即入新学队列且不计入 dailyGoal（官方口径） */
  extraNewWordIds?: string[]
  /** 测试注入随机源（0..1） */
  random?: () => number
  /** 新词排序所需 order 映射（wordId → order），由 data 层提供，缺省按 wordId 字典序 */
  orderOf?: Record<string, number>
}

export interface DailyQueue {
  reviewQueue: WordState[]     // 已排序：遗忘程度高→低
  newQueue: WordState[]
  dueCount: number             // 到期复习总数 = reviewQueue.length（不受 dailyGoal 截断）
  newBudget: number            // = max(0, dailyGoal - dueCount)
  totalPlanned: number         // reviewQueue.length + newQueue.length（含手动加学词）
  extraCount: number
}

export function pickQueue(states: WordState[], opts: QueueOptions): DailyQueue
```

伪代码：

```
due = states.filter(s => isDue(s, now) && (deckId==null || s.deckId===deckId))
reviewQueue = due.sort((a,b) => retrievabilityNow(a,now) - retrievabilityNow(b,now))   // 稳定排序，同值按 dueAt 升序
// task-26：不再 slice 截断！全部到期词都要复习（每日学习量只是目标，不限制复习总量）
newBudget = max(0, dailyGoal - due.length)
news = states.filter(s => s.phase==='new' && deckId 匹配)
         .sort(按 orderOf 升序；newOrder==='random' 时用 Fisher-Yates(random))
newQueue = news.slice(0, newBudget)
extra = extraNewWordIds 里未见过的 new 词（不计 budget，追加到 newQueue 末尾）
```

**注意**：`pickQueue` 是纯函数，**不查 DB**；`dueCount` 用于首页「待复习 N」显示。

### 3.9 当日回炉（学习会话内队列，见 §4.8）

- 不认识：提交后**当天还要再出现 1 次**（`sameDayMinAppearForgot=2`），插入位置 = 当前会话队列的
  `currentIndex + requeueGapForgot (4)`；同时 `dueAt` 已被 `scheduleNext` 置为明天。
- 模糊：同上，`gap = requeueGapVague (8)`，`sameDayMinAppearVague=2`。
- 认识：当天不再出现。
- 回炉词再次出现并再次评分的反馈：`isFirstToday=false` → 不改长期状态（§3.5 分支 1），
  只累计 `sameDayCount` / `sameDayRequeued` 与日志（`longTermUpdate:false`）。
- 队列实现由 `src/core/queue.ts` 的 `RequeueQueue` 或 dev-ui 的会话 hook 处理；**规则必须在 core 里可测**。

### 3.10 统计口径（给 dev-data/dev-ui 的统计页）

| 指标 | 算法 |
|---|---|
| 今日已学 | `reviewLogs` 中 `localDateKey(reviewedAt)===today && longTermUpdate===true` 的 `wordId` 去重数 |
| 今日新学 | 上述日志中该词 `firstSeenAt` 落在今天的数量 |
| 今日反馈分布 | 今日日志按 rating 计数（只计 `longTermUpdate` 的首次反馈） |
| 累计已学 | `states` 中 `phase!=='new'` 的数量 |
| 连续打卡天数 | `reviewLogs` 去重日期序列，从今天/昨天往回连续计数 |
| 遗忘曲线 | 日志按 `elapsedDays` 分桶 `[0,1,2,3,4,5,6,7,8-14,15-30,31-60,61-120,>120]`，每桶 `familiar/(总数)`，模糊按失败计 |
| 今日已学拆分 | **task-49**：`getTodayBreakdown()` 用 `states.firstSeenAt` 推断 review/new（早于今日 0 点=review），已学=plan.ratings 未撤销评分；返回 `review/new` 各 `{planned,learned,remaining}` + 去重词列表（回炉只算一次、加学词 `isExtra`）。派生数据，不写库/不进迁移包 |
| 不熟悉度 Top N | 遍历 states 的 `meaningStats`，`f=familiarity(clicks,encounters)`，取 f 降序且 encounters>0 的前 N |
| 学习量（近 N 天） | 按日聚合 `reviewLogs` 条数（去重 wordId）与新学数 |
| 未来复习压力 | `states.dueAt` 按日期直方图（未来 7/30 天） |

### 3.11 `src/core` 文件拆分与导出（**task-6 交付清单**）

```
src/core/
├─ index.ts          # 只做 re-export（公共出口，UI/data 只从这里 import）
├─ types.ts          # §1.2 全部类型（无运行时代码）
├─ params.ts         # AlgoParams + DEFAULT_PARAMS
├─ dhp.ts            # retrievability / initialStability / stabilityAfterRecall / stabilityAfterForget
├─ schedule.ts       # intervalFromRetention / scheduleNext / isDue / memoryDurabilityDays / retrievabilityNow
├─ queue.ts          # pickQueue / DailyQueue / RequeueQueue / 当日回炉规则
├─ session.ts        # §4 状态机：createSession / tapBoard / openAnnotation / tapMemory / advanceMemory / exitMemory / markMeaning / isMemoryComplete
├─ familiarity.ts    # familiarity / updateMeaningStat / recordClick / recordEncounter（纯函数）
├─ stats.ts          # §3.10 统计纯函数（输入 logs/states，输出统计结构）
├─ ids.ts            # normalizeHeadword / wordIdOf / meaningIdOf / newDeckId / fnv1a32
├─ time.ts           # localDateKey / startOfLocalDay / addDays / dayDiff（已有，保留）
└─ index.ts          # 以上全部导出
```

**被 ban 的 import**（架构测试强制）：`react` / `react-dom` / `react-router-dom` / `dexie` /
`zustand` / `localStorage` / `indexedDB` / `window.` / `document.`。Date/time 只能用 `now` 入参。

---

## 4. 学习流程状态机（AC3 核心，`src/core/session.ts`）

### 4.1 三态页面（同一路由 `/study` 内切换，**不换路由**）

```
[白板面 board] --tap(整屏,非按钮区)--> [注释面 annotation]
       ▲                                      │
       │(只在提交 rating 后下一词才回白板)      │ 点「记忆」
       │                                      ▼
       │                                [记忆页 w-c memory]
       │                                      │ 全部含义满次数
       │                                      └──> [注释面 annotation]（保留滚动位置与 f）
       │
  提交 rating（认识/模糊/不认识） → 调度 → 下一词（白板面）；队列空 → 完成页
```

规则（D12/D13/D15/D16 + research §5）：
1. 白板面只显示：单词 + 音标/发音（`board.showPhonetic` 可关）+ 英文例句（`board.exampleCount` 条，无中文）。
2. 整屏点击（排除顶栏 44px 区、发音按钮）→ 注释面，**300ms 防误触锁**。
3. 从记忆页返回注释面后**不回白板面**；注释面保留滚动位置与不熟悉度。
4. 学习页为**沉浸式全屏**（无底部 Tab），顶栏 `×`（退出确认）/ 进度 `3 / 50` / `⋮`。
5. 退出确认文案：标题「退出学习？」正文「今天的进度会自动保存，下次可继续。」按钮「继续学习 / 退出」。
6. 中途退出：**当前词 w-c 已完成的次数保留**（D15，持久化到 `meta: session:<wordId>`），
   再次进入该词时从 `wcCounts` 继续；`annotation` 阶段退出也保留 current `wcCounts`。

### 4.2 会话类型与纯函数（dev-algo 实现，dev-ui 消费）

```ts
export interface SessionWord {
  wordId: string
  deckId: string
  headword: string
  phonetic?: string            // 已按设置挑选好的展示文本
  meanings: Array<{ meaningId: string; pos?: string; cn: string }>
  phrases: Array<{ en: string; cn: string }>
}

export interface SessionSettings {
  totalRepeats: number          // memory.totalRepeats，1–10，默认 3
  mode: 'sequential' | 'random'
  showPhrases: boolean
  exampleCount: number          // board.exampleCount，0–3
  showPhonetic: boolean
}

export interface SessionState {
  word: SessionWord
  settings: SessionSettings
  stage: 'board' | 'annotation' | 'memory'
  /** 当前 w-c 活动含义 id；非 memory 阶段为 null */
  activeMeaningId: string | null
  /** 每个含义的累计次数（含上次退出保留） */
  wcCounts: Record<string, number>
  /** w-c 页是否已完成过一轮（用于“记忆完成”提示） */
  wcCompletedOnce: boolean
  /** 是否已记录 encounters（一次会话只记一次，见 §4.6） */
  encountersRecorded: boolean
  startedAt: number
  /** 用于 UI 判断“刚满、待切换”，由 tapMemory 返回 */
  needsAdvance: boolean
}

export function createSession(input: {
  word: SessionWord
  settings: SessionSettings
  savedCounts?: Record<string, number>   // 来自 meta session:<wordId>
  now?: number
}): SessionState

export function tapBoard(state: SessionState): SessionState            // board → annotation
export function openMemory(state: SessionState): SessionState          // annotation → memory（选首个未满含义）
export function tapMemory(state: SessionState): SessionState           // 次数 +1；置 needsAdvance=count>=total
export function advanceMemory(state: SessionState, random?: () => number): SessionState
                                                                        // needsAdvance 时切下一个未满 c / 全部满→回 annotation
export function exitMemory(state: SessionState): SessionState          // memory → annotation（保留 wcCounts）
export function markMeaning(state: SessionState, meaningId: string): SessionState  // 注释面点击含义（只更新本地点击计数）
export function isMemoryComplete(state: SessionState): boolean         // 全部含义 wcCounts>=total
export function sessionSnapshot(state: SessionState): SessionSnapshot  // 供 data 层写入 meta
```

**动作幂等性**：`tapBoard` 在 `stage!=='board'` 时原样返回；`openMemory` 在 `stage!=='annotation'` 时原样返回
（防双击/防状态错位）。

### 4.3 w-c 流程精确伪代码（D16）

```
openMemory(state):
  unfilled = meanings.filter(m => (wcCounts[m.id] ?? 0) < totalRepeats)
  若 unfilled 为空 → 直接回 annotation（wcCompletedOnce=true）
  activeMeaningId = mode==='sequential'
      ? unfilled[0].id                              // 顺序：第一个未满
      : unfilled[floor(random()*unfilled.length)].id
  stage = 'memory'; needsAdvance=false

tapMemory(state, random):               // 点击屏幕任意处（顶栏/词组区以外）
  若 stage!=='memory' → 原样返回
  id = activeMeaningId; n = (wcCounts[id] ?? 0) + 1
  wcCounts = { ...wcCounts, [id]: n }

  // sequential（不变）
  若 mode==='sequential':
      needsAdvance = n >= totalRepeats      // 已满：UI 等 200ms 动画后调 advanceMemory
      return { ...state, wcCounts, needsAdvance }

  // random（用户原文语义，2026-11-11 修正）：**每次点击后立刻重新随机选**下一个 w-c 页
  unfilled = meanings.filter(m => (更新后 wcCounts[m.id] ?? 0) < totalRepeats)
  若 unfilled.length === 0:                 // 不存在未满 c → 一轮结束，回注释面
      stage='annotation'; activeMeaningId=null; needsAdvance=false; wcCompletedOnce=true
      return { ...state, wcCounts, stage, activeMeaningId, needsAdvance, wcCompletedOnce }
  next = unfilled[floor(random()*unfilled.length)]   // 未满全集均匀随机，**允许选中刚才那个 c**
  activeMeaningId = next.id; needsAdvance=false
  return { ...state, wcCounts, activeMeaningId, needsAdvance }

advanceMemory(state, random):               // 仅 sequential 需要调用
  若 !needsAdvance → 原样返回
  unfilled = meanings.filter(m => (wcCounts[m.id] ?? 0) < totalRepeats)
  若 unfilled.length === 0:
      stage='annotation'; activeMeaningId=null; needsAdvance=false; wcCompletedOnce=true
      return state
  若 mode==='sequential':
      // 按 meanings 数组顺序，从当前 active 之后找第一个未满（回绕到开头）
      idx = meanings.indexOf(activeMeaningId)
      next = meanings[(idx+1 .. idx+len) mod len] 中第一个 wcCounts<total 的
  否则: // random 兜底（正常路径已在 tapMemory 内完成，此处只防手工构造状态）
      next = unfilled[floor(random()*unfilled.length)]   // 全集均匀随机，允许当前 c
  activeMeaningId = next.id; needsAdvance=false
  return state
```

**随机模式语义（用户原文）**：「每当点击屏幕时让当前的 c 的相应计数自增 1，并从该 w 的所有 c 中随机选择一个『当前次数』未达到『总次数』的 c 来构成新的 w-c 页面（而不一定继续选择同一个 c，同一个 c 也可能被后续随机抽到），直至这样的 c 不存在。」
- **每次 tap 后立刻重选**（不是等当前 c 记满才换 c），**允许连续两次抽中同一个 c**；
- 一轮总点击次数恒 = `含义数 × totalRepeats`（随机只改变顺序，不会多/少）；无未满 c 时自动回注释面；
- 随机源 `random` 可注入，单测用固定序列验证（`tests/core/session.test.ts`）。

### 4.4 词组显示（`memory.showPhrases`）

- 开启（默认开）：w-c 页在次数下方显示**含当前含义中文/英文词的词组**，最多 3 条；英文 14px、中文 14px 灰。
- 词组来源 `Word.phrases`（KyleBing 数据，受限商业词表 4028 词 / 大纲 3962 词有词组）。
- **只显示与当前含义 c 相关的词组**：`Word.phrases` 每条可带 `meaningId`（构建期按中文词匹配分配，
  受限商业词表 53.9% / 大纲 38.0% 有归属；见 `docs/DATA-API.md` §7）。w-c 页过滤规则 =
  `phrase.meaningId === 当前 activeMeaningId`，最多 3 条；`meaningId` 缺失（未归属/旧数据）**不显示**
  （用户要求只显示当前 c，宁可不显示也不展示词级全量）。
- 关闭：整块不渲染、不占位。
- v1 不做「自动生成词组」（MaiMemo词组数据拿不到，D24）。

### 4.5 字号 / 卡片大小

- `memory.fontScale`（0.8–1.6，默认 1.0）只乘 w-c 页的 w/c 字号；
- `memory.cardSize`（0.8–1.4，默认 1.0）只影响卡片宽度/内边距：
  `max-width: min(92vw, calc(420px * cardSize)); padding: calc(24px * cardSize)`；
- 超长文本降字号：`min(fontSize, clamp(24px, 8vw, 34px))`，允许 2 行，不横向滚动。

### 4.6 不熟悉度（AC2）：**写入时机定稿**

**定义**：`familiarity(meaning) = clamp01(clicks / encounters)`；`clicks`=点过「标记不熟悉」的次数；
`encounters`=该含义被遇到的次数；0/0 显示 `—`。

| 时机 | 写入 | 说明 |
|---|---|---|
| **进入注释面**（board→annotation 的第一次转换，每个词每次会话只触发一次） | 该词**全部** meanings `encounters += 1` | 「遇到」= 看到释义面。⚠️ 白板面不算遇到；从记忆页返回注释面不重复计数（会话内 `encountersRecorded` 幂等） |
| 点击某含义行 | 该含义 `clicks += 1`（可重复点击，clicks 可 > encounters） | 立即持久化并重算 f；UI 240ms 过渡 + 轻震动 |
| 评分提交 | 写 `ReviewLog`（不含 clicks/encounters 快照，统计从 states 读） | — |

**数据层接口**（§9.2）：`recordMeaningEncounters(wordId, meaningIds)`、
`recordMeaningClick(wordId, meaningId)`；**只由 UI 在这两个时机调用**，逻辑层不自动写。
`WordState.meaningStats` 缺省 key 时按 0/0 处理并补齐。

### 4.7 中途退出与快照持久化（D15）

- UI 在 `stage==='memory'` 时，每次 `tapMemory/advanceMemory` 后 **debounce 500ms** 调
  `saveSessionSnapshot(wordId, sessionSnapshot(state))`；退出记忆/退出学习页面时**立即**保存。
- 再次进入该词：`createSession({savedCounts: snapshot.wcCounts})` → 已满的含义不再计入。
- 评分提交成功后**删除**该词 session 快照（`deleteSessionSnapshot(wordId)`）。
- 快照与状态解耦：快照丢失不影响长期记忆状态（最坏情况该词 w-c 重来）。

### 4.8 评分提交时序（防连点 + 当日回炉）

```
用户点 认识/模糊/不认识（三键高 48px，提交后 400ms 内禁用）
  → UI 调 data.submitRating(wordId, rating, now)
      事务内：scheduleNext → put states + add reviewLogs + meta.lastStudyDate
      → 返回 { state, log, longTermUpdate, requeued }
  → 会话队列：
      familiar → 移出队列
      vague/forgot → 按 §3.9 插回队列（gap 8 / 4），标记 requeued
  → 队列非空 → 下一词（白板面，200ms 过渡）
  → 队列空 → 完成页（今日学习 N 个 · 用时 M 分钟）→ 回首页/统计
```

- **只有当天第一次反馈影响长期调度**：由 `scheduleNext` 内部判断（`sameDayDate`），UI 不得绕过。
- 服务端「今日回顾」概念 v1 不做（无 offTheRecord 入口），故 `ReviewLog.longTermUpdate` 用于统计过滤。
- 学完的词若再次从词库手动进入（复习模式），同样走 `submitRating`，此时 `isFirstToday=false`。

---

## 5. 设置项 key 全清单（AC4）

存储：`settings` 表（`{key, value, updatedAt}`）；读取时与下表默认值合并；**越界值 clamp 后写回**。
设置 key 一旦发布**不可改名**（迁移成本），新增用新 key。

| key | 类型 | 默认 | 范围/枚举 | 生效方式 | UI 控件 |
|---|---|---|---|---|---|
| `study.dailyGoal` | number | **30** | 5–200，整数 | 首页任务卡 / `pickQueue` 的 dailyGoal | 数字行 → 弹层 |
| `study.recallMode` | string | `'en2cn'` | 固定 `en2cn`（v1） | 白板面显示英文 | 分段（v2 预留） |
| `board.exampleCount` | number | **2** | 0–3 | 白板面例句条数 | 数字行 → 弹层 |
| `board.showPhonetic` | boolean | **true** | — | 白板面音标+发音按钮显隐 | Switch |
| `memory.totalRepeats` | number | **3** | 1–10，整数 | `createSession.totalRepeats` | Stepper －/＋ |
| `memory.mode` | string | `'sequential'` | `sequential` / `random` | w-c 选 c 策略 | 分段控件 |
| `memory.showPhrases` | boolean | **true** | — | w-c 页词组块显隐（D47 修订：默认显示） | Switch |
| `memory.fontScale` | number | **1.0** | 0.8–1.6，步 0.05 | w-c 页 w/c 字号 | Slider |
| `memory.cardSize` | number | **1.0** | 0.8–1.4，步 0.05 | w-c 卡片宽/内边距 | Slider |
| `study.labelSwitch` | boolean | **true** | — | 三键标签：新词首次「认识/不确定/不认识」，之后「认识/模糊/忘记」 | Switch |
| `memory.showPredictedInterval` | boolean | **true** | — | 三键副标题显示「N 天后 / 今日进度%」 | Switch |
| `study.allowVagueComplete` | boolean | **false** | — | 允许「模糊」完成当日复习（官方默认不允许） | Switch |
| `app.fontScale` | number | **1.0** | 0.9–1.2，步 0.05 | 全局字号倍数（乘 token） | Slider |
| `app.theme` | string | `'system'` | `system`/`light`/`dark` | `<html data-theme>`（arch 已实现 `useTheme`，`system` 不写属性） | Radio 3 项 |
| `app.reduceMotion` | boolean | **false** | — | 动效时长 1ms（同时尊重 `prefers-reduced-motion`） | Switch |
| `data.maimemoToken` | string | `''` | 任意字符串（≤2048） | 仅存本机，用于MaiMemo导入；**不得打日志/导出** | 弹层输入 password |
| `data.proxyUrl` | string | `'http://127.0.0.1:8787'` | `''` 或 http(s) URL | MaiMemo API 代理地址（CORS，D23） | 输入行 |
| `data.selectedDeckId` | string | `'kaoyan-hongbaoshu-2025'` | 必须是存在的 deck id | 首页/学习页当前词库 | 词库页「设为在学」 |
| `study.newWordOrder` | string | **`'random'`** | `order` / `random` | 新词顺序：random 用 plan 稳定种子（同一天退出重进/改学习量顺序不变） | 分段控件 |
| `study.dailyReviewCap` | number | **0** | 0–9999 整数（0=不限） | 每日自动入队复习上限；超出顺延 backlog、不改 dueAt；手动加学/回炉不受限 | 数字输入 |

**设置影响面的明确要求**：
- 修改后**立即生效并持久化**（学习页正在展示时：字号/词组/次数立即重渲染；`dailyGoal` 下次取队列生效）。
- 输入框类设置失焦保存；Switch/分段/Stepper 点击即保存；Slider 拖动结束（`change`）保存。
- 刷新/重启后保持（读 settings 表）。
- `app.theme` 与 arch 的 `useTheme()` 对齐：**只需改 settings 表 + `setMode()`**，两者必须同步（dev-ui 实现时优先用 settings 作为唯一事实来源，`useTheme` 作为渲染通道）。
- 清空数据（危险操作）：清 `decks/words/states/reviewLogs/settings(学习类)/meta` → 二次确认弹窗文案「清空后将删除全部学习记录与词库，无法恢复」；保留 `data.maimemoToken` 可选（默认一起清）。


---

## 6. 导入 / 导出格式（AC5，`src/data/import-export.ts`）

### 6.1 导出：纯词库（DeckFile v1）

- 文件：`<deck.name>.deck.json`（名称非法字符替换为 `_`），内容 = §1.5 `DeckFile`。
- 导出**不含**任何学习状态（可公开分享词表）。
- 内置词库也允许导出（用户自己的数据权利）；导出时保留 `license/copyrightNotice`。

### 6.2 导出 / 导入：可迁移包（MigrationFile v1，D22）

```ts
export interface MigrationFile {
  format: 'momo-migration'
  formatVersion: 1
  exportedAt: number
  generator: string               // 'wordc@0.1.0'
  appVersion: string
  /** 载荷版本（数据格式版本），当前 1 */
  dataVersion: 1
  counts: { decks: number; words: number; states: number; reviewLogs: number }
  data: {
    decks: Deck[]
    words: Word[]
    states: WordState[]
    reviewLogs: ReviewLog[]        // 可选导出；最多保留最近 20000 条
    settings: SettingRecord[]      // ⚠️ 不含 data.maimemoToken（隐私，D23）
  }
  /** sha256(stableStringify({format,formatVersion,dataVersion,data})) 的小写 hex */
  checksum: string
}
```

- **checksum 算法**（dev-data 实现于 `src/data/checksum.ts`）：
  ```ts
  const canonical = stableStringify({ format, formatVersion, dataVersion, data })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  ```
  `crypto.subtle` 不可用（非安全上下文）时降级 FNV-1a 64 位并在导出文件 `meta.checksumAlgo` 标注；
  `stableStringify`：对象 key 递归排序、数组保持顺序、无空白、字符串 JSON 转义。
- **导入校验顺序**：`format/formatVersion → checksum → 字段校验（§6.4）→ 写库事务`。
  checksum 不符时**默认拒绝**；UI 提供「仍要导入（风险）」按钮（`force: true`）。
- **合并策略 `strategy`**：
  | 策略 | 行为 |
  |---|---|
  | `replace`（默认，同 id 覆盖） | 同 `deckId` 先清空该库的 words/states（二次确认），再写入；**AC5 往返一致性测试用此策略** |
  | `merge` | 按 `wordId` 对齐：已存在 → 取 `lastReviewedAt` 较新的 state；`clicks=max(旧,新)`、`encounters=max(旧,新)`；不存在 → 插入。settings 缺省项才补 |
  | `keepNewer` | 仅当导入包 `lastReviewedAt` 更新时覆盖 state（用于多设备回合同步） |
- 导入结果结构 `ImportReport`（见 §6.4）写入 `meta: import:last` 并在 UI 展示。

### 6.3 CSV 规范（用户自己的词单）

```csv
headword,pos,meaning,example,exampleTranslation,phoneticUK,phoneticUS,tags
abandon,vt.,放弃；抛弃,He abandoned the plan.,他放弃了计划,,[əˈbændən],我的词
```

- 编码 UTF-8（可带 BOM，读取时剥掉）；分隔符英文逗号；含逗号/引号/换行字段按 RFC4180 加双引号转义。
- 第一行必须是表头（列名大小写不敏感；允许缺少可选列，`headword` 必填）。
- **多义**：`meaning` 用中文分号 `；` 分隔 → 每条一个 `Meaning`，`pos` 对全部生效；
  `example/exampleTranslation` 作为词级例句（同一个）。
- 一行一个 headword；同 headword 多行 → 合并 meanings（按 `cn` 去重）。
- 无释义的行：`meanings=[{cn: headword}]` + tag `no-meaning`，导入报告里给 warning。

### 6.4 坏数据错误结构（结构化，UI 可逐条展示）

```ts
export type ImportIssue = {
  level: 'error' | 'warning'
  code: 'E_FORMAT' | 'E_VERSION' | 'E_CHECKSUM' | 'E_FIELD' | 'E_DUP' | 'E_IO'
        | 'W_NO_MEANING' | 'W_NO_PHONETIC' | 'W_SKIPPED'
  message: string          // 中文，给用户看
  path?: string            // 'words[12].meanings[0].cn'
  row?: number             // CSV 行号（1 起）
  field?: string
}

export interface ImportReport {
  ok: boolean
  kind: 'deck' | 'migration' | 'csv' | 'maimemo'
  counts: { decks: number; words: number; states: number; reviewLogs: number; skipped: number }
  issues: ImportIssue[]
  durationMs: number
}
```

- 导入过程**先校验后写库**；任何 `error` 级 issue → 整体不写库（`ok:false`），返回 issues。
- `warning` 不阻断，例如受限商业词表 18 条无释义、无音标、重复词被合并。

### 6.5 内置词库种子（`ensureBuiltinDecks()`）

- 首次启动 / `meta.builtin.seeded` 版本落后时执行：动态 import 两个 `.deck.json` → 事务内写 decks+words。
- 幂等：`meta.builtin.seeded` 记录每个内置词库的 `version`，相等则跳过。
- 失败（磁盘满/JSON 损坏）：UI 显示「内置词库加载失败，可重试 / 手动导入」，不阻塞其他词库。
- 单个内置库 6702 词写入 Dexie 预计 <3s（bulkPut 分批 500 条）；首启显示 loading 覆盖层。

---

## 7. MaiMemo导入通道（D23/D24，task-8）

### 7.1 结论与边界（不可越线）

| 能力 | v1 做法 |
|---|---|
| 鉴权 | **用户自己的 Bearer Token**（App→我的→更多设置→实验功能→开放 API 复制）；**绝不要求账号密码/扫码登录**（协议 5.1.6，D29） |
| 能导入 | 已学单词列表 + `next_study_date` / `last_study_date` / `first_study_date` / `last_response` / `study_count` / `tags`（进度） |
| 不能导入 | 内置词库词表、官方释义/例句/助记、记忆持久度真值 → 用本地词库 + 算法近似（§7.3） |
| CORS | 浏览器直连会被拦（无 ACAO）。MVP：**本地小代理**（`src/data/api/maimemo-proxy.mjs`，`node` 直接跑，监听 `127.0.0.1:8787`）+ 设置项 `data.proxyUrl`；代理也可换 Cloudflare Worker（用户自备） |
| Token 存储 | 仅 `settings['data.maimemoToken']`（本机 IndexedDB）；**不写日志、不进导出包、不上传**；7 天过期需重贴 |
| 失败降级 | 401/403→提示重取 Token；CORS/网络→提示配代理或「手动粘贴 JSON」；429→指数退避（1s/2s/4s，最多 3 次）；beta 接口 4xx/5xx→只导词库不导进度（不阻塞） |

### 7.2 使用到的接口（官方 OpenAPI，`data/raw/maimemo-openapi.yaml`）

Base：`https://open.maimemo.com/open`；Header：`Authorization: Bearer <token>`、`Content-Type: application/json`。

| 用途 | 接口 | 备注 |
|---|---|---|
| 拼写 → voc_id | `GET /api/v1/memo/vocabulary?spelling=apple`；批量 `POST /api/v1/memo/vocabulary/query {spellings:[…]}` ≤1000 | 旧路径 `/open/api/v1/vocabulary` 兼容回退 |
| 拉全量学习记录 | `POST /api/v1/memo/study/query_study_records {next_study_date:{start,end}, limit:1000}` | 分页：用上一页最后一条 `next_study_date` 作下一页 start，`voc_id` 去重；`as_count:true` 取总数校验 |
| 今日进度（可选） | `POST /api/v1/memo/study/get_study_progress` | 首页「MaiMemo今日进度」增强，v1 可选 |
| 今日单词（可选） | `POST /api/v1/memo/study/get_today_items` | 同上 |
| 频控 | 10s/20 次，60s/40 次，5h/2000 次 | 每页请求间隔 ≥200ms；单次导入 ≤20 页先提示 |

### 7.3 字段映射（StudyRecord → 本项目，D24）

| StudyRecord | 目标 | 规则 |
|---|---|---|
| `voc_spelling` | 匹配 `Word.headwordLower` / `headword` | 小写匹配；匹配不到 → 记入 `unmatched[]`（报告前 20 个） |
| `voc_id` | `Word.maimemoVocId` / `WordState.importedFrom='maimemo'` | 仅本机参考 |
| `first_study_date` | `WordState.firstSeenAt` | 解析为 epoch ms（按 +08:00 解释官方时间串） |
| `last_study_date` | `WordState.lastReviewedAt` | 同上 |
| `next_study_date` | `WordState.dueAt` | 同上；缺失→`last + 1 天` 兜底 |
| `last_response` | `WordState.lastRating` | FAMILIAR→familiar；VAGUE→vague；FORGET→forgot；WELL_FAMILIAR→（`phase:'mastered'`，`dueAt:null`）；CANCEL_WELL_FAMILIAR→familiar |
| `study_count`（每天最多计 1） | `WordState.reps` | 直接映射；仅用于展示 |
| `tags: 'STICKING'` | `WordState.difficulty = 8`、`lapses = max(2, floor(study_count/3))` | 顽固词近似 |
| **记忆持久度（无）** | `WordState.stability` 近似 | `intervalDays = max(0, round((dueAt - lastReviewedAt)/day))`；`stability = clamp(intervalDays / -log2(0.9), 0.1, 4096)`（等价于“按阈值法的间隔反推 h”） |
| **不熟悉度（无）** | `meaningStats` 初始 | 每个含义 `{clicks:1, encounters:2}` → f=0.5（D24 中性初始） |
| `nextIntervalDays` | `= max(1, intervalDays)` | 展示用 |
| `phase` | 无 first_study_date→`new`；有→`review`（last FORGET 且 dueAt 很近→`learning`） | |
| 备注 | 导入记录 `importedFrom:'maimemo'`、`importedAt`、`sameDayDate:''`、`sameDayCount:0` | 便于以后重算 |

**导入报告**：成功 N 词 / 未匹配 M 词（列前 20 个拼写，提供「加入当前词库」「忽略」）/ 跳过 K 条（解析失败）。导入**只改 states，不改 builtin 词表**。

**手动降级**：设置页提供「粘贴MaiMemo学习记录 JSON」输入（用户自行从官方 demo/导出获取），格式 = `StudyRecord[]`，走同一映射器 → 同样生成报告。

---

## 8. 页面 / 组件清单 + 路由 → 文件映射（task-9/10 按此拆文件，**互不重叠**）

### 8.1 路由表（**最终版**，dev-ui 落地时同步 `src/app/router.tsx` 与 `src/app/routes.ts`）

| 路由 | 页面 | 文件 | 底部 Tab | 任务归属 |
|---|---|---|---|---|
| `/` | 首页「今日任务仪表盘」（D19） | `src/ui/home/HomePage.tsx` | ✅ 首页 | task-10 |
| `/study` | 学习页（白板/注释/记忆，**沉浸式无 Tab**） | `src/ui/study/StudyPage.tsx` | ❌（首页进入） | task-9 |
| `/decks` | 词库列表 | `src/ui/decks/DecksPage.tsx` | ✅ 词库 | task-10 |
| `/decks/:deckId` | 词库详情（单词列表/搜索/增删改） | `src/ui/decks/DeckDetailPage.tsx` | ❌（从 /decks 进） | task-10 |
| `/stats` | 统计 | `src/ui/stats/StatsPage.tsx` | ✅ 统计 | task-10 |
| `/me` | 我的 | `src/ui/me/MePage.tsx` | ✅ 我的 | task-10 |
| `/me/settings` | 设置 | `src/ui/me/SettingsPage.tsx` | ❌ | task-10 |
| `/me/about` | 关于/版本/许可（含 D11 表述） | `src/ui/me/AboutPage.tsx` | ❌ | task-10 |
| `*` | 404 | `src/ui/components/NotFoundPage.tsx` | — | task-10 |

**底部 Tab = 4 个**：首页 / 词库 / 统计 / 我的（研究 03 §3.2；**学习页不占 Tab**）。
→ 需修改 `src/app/routes.ts`：`TAB_ITEMS` 去掉 `/study`，新增 `/decks/:deckId` 等不进 Tab；
`src/app/router.tsx` 的 import 全部指向新目录；**旧 `src/ui/pages/*.tsx` 占位文件在 dev-ui 完成后删除**。
外壳（`AppShell`/`TabBar`/主题/安全区/PWA）沿用 arch 脚手架，`src/app/layout/AppShell.tsx` 可被 task-10 调整样式。

### 8.2 学习页组件（task-9，`src/ui/study/`，**不要碰 `src/ui/components/`**）

| 文件 | 职责（行为必须符合 03-ui §5） |
|---|---|
| `StudyPage.tsx` | 路由页：取队列 → 会话循环 → 三态渲染 → 完成页 → 退出确认 |
| `components/BoardStage.tsx` | 白板面：大单词 + 音标/发音 + 英文例句（无中文）+ 提示语；整屏可点（排除顶栏/发音按钮），300ms 防误触 |
| `components/AnnotationStage.tsx` | 注释面：单词/音标 + 含义行（可点标记不熟）+ 不熟悉度条（5 档色 + 百分比）+ 例句/助记/词组 + 底部操作区 |
| `components/MemoryStage.tsx` | w-c 页：w→c 大卡、`当前/总次数`、点阵、词组块（开关）、整屏点击 |
| `components/ActionBar.tsx` | 记忆按钮（44px 居中）+ 三键（48px 均分，色 #2E9E86/#B4761D/#B64A31） |
| `components/MeaningRow.tsx` | 含义行 + 不熟悉度条 + clicks/encounters 展示 |
| `components/FamiliarityBar.tsx` | 4px 条 + 5 档色（f 区间映射见 03-ui §5.2.2） |
| `components/WordHead.tsx` | 单词+音标+发音（3 种尺寸 board/annotation/wc） |
| `components/CompletionPage.tsx` | 完成页（猫头鹰单色 SVG + 统计摘要 + 查看统计/回首页） |
| `hooks/useStudySession.ts` | 会话 hook：调 core session 状态机 + data 读写（局部 hook，不依赖 `src/app/hooks`） |
| `styles/study.css` 或 Tailwind 类 | 学习页专有样式（用 03-ui tokens） |

### 8.3 其余页面与通用组件（task-10，`src/ui/home|decks|stats|me|components/` + `src/app/`）

| 文件 | 职责 |
|---|---|
| `src/ui/home/HomePage.tsx` | 今日任务卡（待复习/待新学/今日进度/开始学习）、当前词库卡、连续打卡、空状态 |
| `src/ui/decks/DecksPage.tsx` | 当前在学、全部词库列表（进度）、新建/重命名/删除、导入词库、从MaiMemo导入、导出 |
| `src/ui/decks/DeckDetailPage.tsx` | 统计条 + 分段（全部/已学/未学）+ 虚拟滚动列表 + 搜索 + 行点击弹层 + 删除单词 |
| `src/ui/stats/StatsPage.tsx` | 概览三数字、今日反馈堆叠条、近 14 天柱状图（**纯 SVG**）、不熟悉度 Top 5 |
| `src/ui/me/MePage.tsx` | 头像/词汇量/打卡、学习数据入口、数据管理入口、设置、关于 |
| `src/ui/me/SettingsPage.tsx` | §5 全部设置项（控件与实时生效）、危险操作二次确认 |
| `src/ui/me/AboutPage.tsx` | 版本、算法说明（同源 MM/DHP，D11）、词库版权（D20/D21）、开源许可 |
| `src/ui/components/` | `PageShell` `SectionBand` `Card` `Buttons` `SegmentedControl` `Stepper` `Slider` `Switch` `SettingRow` `Sheet` `Dialog` `Toast` `EmptyState` `TabBar` `StatChart` `NotFoundPage`（组件 API 参考 03-ui §7） |
| `src/app/hooks/` | 共享数据 hooks：`useDecks()` `useDeckStats(deckId)` `useTodayStats()` `useStudyProgress()` `useSettings()`（用 dexie-react-hooks 的 `useLiveQuery`；**只有 UI 层可 import**） |
| `src/app/router.tsx` / `routes.ts` | 按 §8.1 更新路由/导航元数据 |
| `src/app/styles/global.css` | 用 03-ui `tokens.css` 覆盖 arch 的 CSS 变量名（或新增 `--mm-*` 变量并在 `tailwind.config.js` 映射；**不要两套主题变量并存**，见 §11） |

### 8.4 数据来源映射（页面 → data API）

| 页面 | 使用 |
|---|---|
| 首页 | `getTodayQueue()` / `getDeckProgress()` / `getStudyStreak()` / `ensureBuiltinDecks()` |
| 学习页 | `getTodayQueue()` → `getWord()` + `getState()` → `recordMeaningEncounters` / `recordMeaningClick` / `submitRating` / session 快照 |
| 词库页 | `listDecks()` / `getDeckProgress()` / `createDeck` / `renameDeck` / `deleteDeck` / `importDeckFile` / `importCsv` / `exportDeck` / `importMaimemo` |
| 统计页 | `getStatsOverview()` / `getDailyStats(range)` / `getUnfamiliarTop(n)` |
| 设置页 | `getSettings()` / `updateSettings()` / `clearAllData()` / `exportMigration()` / `importMigration()` |

---

## 9. 模块间接口契约（**三个 dev 并行不打架的关键**）

### 9.1 import 规则

- 跨层只从出口 import：`from '../../core'`、`from '../../data'`、`from '../../app/store'`、`from '../../app/theme'`。
- **不要用 `@/` 别名**（脚手架未给 Vite 配 resolve.alias，tsconfig 的 paths 只在编辑器生效）。
- `src/data` 内部分文件；`src/ui` 内可以 import `src/core` 纯函数（如 `familiarity()`、`localDateKey()`）。
- `src/core` 禁止 import `src/data` 与 React（架构测试强制）。

### 9.2 `src/core/index.ts` 导出清单（task-6 必须全部提供，签名固定）

```ts
// —— 类型（§1.2，全部 export type）——
export type {
  Deck, DeckSource, Word, Meaning, Example, Mnemonic, Phrase, Phonetic,
  Rating, Phase, WordState, MeaningStat, ReviewLog,
  SessionSnapshot, SettingsMap, SettingKey, SettingRecord, MetaRecord,
  DeckFile, MigrationFile, ImportIssue, ImportReport,
}
// —— 参数 ——
export { DEFAULT_PARAMS } from './params'
export type { AlgoParams } from './params'
// —— id ——
export { normalizeHeadword, wordIdOf, meaningIdOf, newDeckId, fnv1a32 } from './ids'
// —— 时间 ——
export { localDateKey, startOfLocalDay, addDays, dayDiff, DAY_MS } from './time'
// —— DHP ——
export { retrievability, initialStability, stabilityAfterRecall, stabilityAfterForget } from './dhp'
// —— 调度 ——
export {
  intervalFromRetention, scheduleNext, isDue, isNew,
  memoryDurabilityDays, retrievabilityNow,
  // task-26 新增
  previewNext, predictAll, isFirstShow,
  firstFamiliarDays, firstFamiliarHalfLife, firstVagueDays, firstVagueHalfLife, firstForgetDays,
  createWordState, requeueKindOf,
} from './schedule'
export type { ScheduleResult, NextPreview, Predict, WordPredicts } from './schedule'
// —— 队列 ——
export { pickQueue } from './queue'
export type { QueueOptions, DailyQueue } from './queue'
// —— 不熟悉度 ——
export { familiarity, emptyMeaningStat, applyMeaningClick, applyMeaningEncounter } from './familiarity'
// —— 会话状态机 ——
export {
  createSession, tapBoard, openMemory, tapMemory, advanceMemory,
  exitMemory, markMeaning, isMemoryComplete, sessionSnapshot,
} from './session'
export type { SessionWord, SessionSettings, SessionState } from './session'
// —— 统计 ——
export {
  computeStudyStreak, computeDailyStats, computeFeedbackDistribution,
  computeForgettingCurve, computeUnfamiliarTop, computeReviewPressure,
} from './stats'
export type { StatsOverview, DailyStatPoint, FeedbackDistribution,
  ForgettingCurveBucket, UnfamiliarTopItem, ReviewPressurePoint } from './stats'
```

`src/core/stats.ts` 输入必须是纯数据数组（`ReviewLog[]` / `WordState[]` / `Map<wordId, Word>`），
**不许查 DB**；数据层负责把 rows 查出来传进去。

### 9.3 `src/data/index.ts` 导出清单（task-7/8 必须全部提供）

```ts
// —— 数据库 ——
export { db, getDb, resetDatabase, AppDatabase } from './db'
// —— 内置词库 ——
export { ensureBuiltinDecks, BUILTIN_DECK_IDS } from './builtin'
// —— 词库管理 ——
export {
  listDecks, getDeck, getDeckProgress,
  createDeck, renameDeck, deleteDeck, setDefaultDeck,
  getWordsPage, getWord, searchWords,
  upsertWord, deleteWord,
} from './decks.repo'
export type { DeckProgress, WordPageQuery } from './decks.repo'
// —— 单词状态 / 学习 ——
export {
  getState, getStates, getTodayQueue, getNextWords, submitRating,
  recordMeaningEncounters, recordMeaningClick,
  saveSessionSnapshot, loadSessionSnapshot, deleteSessionSnapshot,
} from './study.repo'
export type { SubmitRatingResult } from './study.repo'
// —— 设置 ——
export { getSettings, updateSettings, resetSettings } from './settings.repo'
export type { AppSettings } from './settings.repo'   // = 合并默认值后的完整对象
// —— 导入导出 ——
export {
  exportDeck, exportMigration, importDeckFile, importCsv, importMigration, clearAllData,
} from './import-export'
export type { ImportOptions, ExportOptions } from './import-export'
// —— 统计 ——
export { getStatsOverview, getDailyStats, getDailyStatsRange, getUnfamiliarTop } from './stats.repo'
// —— MaiMemo API（task-8，单独出口文件）——
export {
  importMaimemoProgress, importMaimemoRecords, setMaimemoSession,
} from './api/maimemo'
export type { MaimemoImportResult, MaimemoError } from './api/maimemo'
```

关键签名（**一个字都别改**）：

```ts
// study.repo.ts
export interface SubmitRatingResult {
  state: WordState
  log: ReviewLog
  intervalDays: number
  longTermUpdate: boolean
  /** 当日回炉建议：'requeue-forgot' | 'requeue-vague' | 'none' */
  requeue: 'requeue-forgot' | 'requeue-vague' | 'none'
}
export function submitRating(wordId: string, rating: Rating, now?: number): Promise<SubmitRatingResult>

export function getTodayQueue(opts?: {
  deckId?: string | null; now?: number; dailyGoal?: number; extraNewWordIds?: string[]
}): Promise<DailyQueue>

export function recordMeaningEncounters(wordId: string, meaningIds: string[]): Promise<WordState>
export function recordMeaningClick(wordId: string, meaningId: string): Promise<WordState>

export function saveSessionSnapshot(snap: SessionSnapshot): Promise<void>
export function loadSessionSnapshot(wordId: string): Promise<SessionSnapshot | null>
export function deleteSessionSnapshot(wordId: string): Promise<void>

// settings.repo.ts
export type AppSettings = SettingsMap   // 完整对象（含默认值）
export function getSettings(): Promise<AppSettings>
export function updateSettings(patch: Partial<SettingsMap>): Promise<AppSettings>

// import-export.ts
export interface ImportOptions {
  strategy?: 'replace' | 'merge' | 'keepNewer'   // 默认 replace
  force?: boolean                                 // checksum 不符仍导入
}
export function importDeckFile(input: string | File, opts?: ImportOptions): Promise<ImportReport>
export function importMigration(input: string | File, opts?: ImportOptions): Promise<ImportReport>
export function importCsv(input: string | File, deckName?: string): Promise<ImportReport>
export function exportDeck(deckId: string): Promise<Blob>
export function exportMigration(opts?: ExportOptions): Promise<Blob>
export function clearAllData(opts?: { keepToken?: boolean }): Promise<void>

// api/maimemo.ts（task-8）
export function importMaimemoProgress(opts: {
  token?: string; proxyUrl?: string;
  onProgress?: (done: number, total: number) => void
}): Promise<MaimemoImportResult>
export function importMaimemoRecords(records: unknown[]): Promise<MaimemoImportResult>
```

### 9.4 UI 数据访问规则

- UI 不直接 `import { db }` 做写操作；读可以用 `useLiveQuery(() => db.decks.toArray(), [])`
  （放在 `src/app/hooks/` 内），写一律走 §9.3 函数。
- 所有 data 函数**错误用 throw**（DB/校验），导入类函数返回 `ImportReport` 不 throw；
  UI 统一 `try/catch` + `toast.error(message)`。
- 设置变更：UI 调 `updateSettings()` → `useLiveQuery` 自动重渲染；同时同步 `useTheme().setMode()`（§5）。

### 9.5 文件所有权矩阵（并行开发防冲突）

| 目录/文件 | 归属 | 其他人 |
|---|---|---|
| `src/core/**`, `tests/core/**`, `docs/CORE-API.md` | dev-algo (task-6) | 只读 |
| `src/data/**`（不含 `api/`）, `tests/data/**`, `docs/DATA-API.md`, `src/data/builtin/**` | dev-data (task-7) | 只读 |
| `src/data/api/**`, `tests/data/api/**`, `docs/API-IMPORT.md` | dev-data (task-8) | 只读 |
| `src/ui/study/**`, `tests/ui/**`, `docs/UI-STUDY.md` | dev-ui A (task-9) | 只读 |
| `src/ui/home|decks|stats|me/**`, `src/ui/components/**`, `src/app/**`, `public/**`, `docs/UI-APP.md` | dev-ui B (task-10) | 只读 |
| `docs/ARCH.md`, `docs/SPEC.md`, 根配置 | arch | 要改先报 Lead |
| `docs/QA.md`, `tests/e2e/**`, `scripts/**` | QA/集成 (task-11/12) | 只读 |

⚠️ `src/app/` 虽然属 task-10，但 `router.tsx`/`routes.ts` 的**路径字符串**是所有任务的公共契约：
新增/改路由必须先 `send_message` 给 Lead（D27 精神）。

---

## 10. 验收标准 AC1–AC8（每条可测；QA task-11 逐条执行）

### AC1 · 调度可解释、与同源算法一致
- 单测（`tests/core/official-align.test.ts` / `schedule.test.ts`）：**新词首评认识**按官方难度 d → **7–90 天**
  （认识 **K=80**：d=1→63、d=2→44、d=3→33、d=5→21、d=10→10；模糊 **K_v=100**：d=1→3、d=2→2、d=3→2、d=5→2、d=10→1；±1 天）；首评忘记 1 天；
  d0=5 一直 familiar 的连续间隔 = **[21,44,88,169,311,365,365…]**（h 相对误差 ≤1%）；
  复习日 forgot（h=75.10，间隔 11 天）→ h'≈7.78（±1%）、difficulty=7、间隔按公式=1 天（不再强制次日）。
  官方同难度首评实测 56/62/78 天（分散）→ 只验「落在区间 + 参数可调」，不验逐词一致。
- 单测：新词首次评分**不出现 NaN/Infinity**（familiar/vague/forgot 三种各一次断言）。
- 单测：同日第二次评分 `longTermUpdate=false` 且 h/d/dueAt 不变。
- 文档/关于页表述为「同源 MM/DHP 模型」，不承诺与官方逐词一致（D11）。
- **通过标准**：以上测试全绿 + 随机抽 3 个词手工复算与实现一致（QA 用独立脚本重算）。

### AC2 · 不熟悉度计算精确
- `familiarity(0,0)===null`（展示 `—`）；`familiarity(1,3)≈0.3333`；`familiarity(7,5)===1`（展示 clamp，原始 clicks=7 保留）。
- 进入注释面一次 → 全部含义 `encounters+1`（同一次会话内多次进出注释面不重复 +1）；
  点击一条含义 → 仅该含义 `clicks+1`；刷新后数值保持。
- UI：条宽=clamp 后 f、颜色按 5 档（0–20%/20–40%/40–60%/60–80%/80–100%），右侧显示 `clicks/encounters 百分比`。
- **通过标准**：`tests/core/familiarity.test.ts` + 手工步骤（点 2 次某含义、刷新、看条与数字）。

### AC3 · mode 两种流程正确
- `totalRepeats=3`、`mode=sequential`、3 个含义：tap 序列产生次数 `[3,3,3]`，切换顺序 M1→M2→M3，结束后回 annotation。
- `mode=random`：**每次 tap 后立刻**从「未满」全集均匀随机选下一个 c（允许连续同一个 c）；无未满 c 自动回注释面；总 tap 次数恒 = `totalRepeats × meanings.length`；注入固定 `random` 可复现。
- 边界：`totalRepeats=1`（每次 tap 即切换）、`totalRepeats=10`、`meanings.length=1`（不切换、满后回注释面）。
- 中途退出再进入：`savedCounts` 恢复，已满含义不再出现（D15）。
- **通过标准**：`tests/core/session.test.ts` 全绿 + 手工走 3 个词两种模式。

### AC4 · 设置项生效
- 每个 §5 设置项：改值 → `getSettings()` 返回新值 → 重启（重新加载页面）后保持。
- 学习页实时生效：`memory.totalRepeats`/`mode`/`showPhrases`/`memory.fontScale`/`cardSize` 改动后下一次进 w-c 可见；
  `board.exampleCount`/`showPhonetic` 改后回白板面可见；`app.theme` 切换立即变；`study.dailyGoal` 下次队列生效。
- **通过标准**：设置页逐项手工验收（QA 脚本）+ `tests/data/settings.test.ts`。

### AC5 · 导入导出往返一致
- `exportMigration()` → `clearAllData()` → `importMigration(file, {strategy:'replace'})` → 所有 `states` 逐字段 deep equal
  （允许 `updatedAt` 变化除外，需在测试中显式忽略该字段），`decks/words/settings` 一致。
- checksum：修改文件任一字节 → 导入被拒（`E_CHECKSUM`）；`force:true` 可强行导入。
- CSV：带引号逗号、多义分号、重复行合并、缺 `headword` 行报 `E_FIELD`（含行号）。
- 坏 JSON / 版本不兼容（formatVersion=2）→ `E_FORMAT`/`E_VERSION`，不写库。
- **通过标准**：`tests/data/import-export.test.ts`（用 fake-indexeddb 或 node 环境模拟；若引入依赖受限，则用 `tests/data/` 下的纯函数校验 + 手工步骤，需在 docs 说明）。

### AC6 · 词库管理增删改查
- 新建词库（名称必填、重名提示）→ 立即出现在列表；重命名/删除（确认）→ 列表与首页当前词库同步更新；
- 从文件导入 JSON/CSV → 词数正确、进度为 0；删除内置词库需二次确认（可重装/重新种子）；
- 词库详情：搜索（中文/英文/前缀）、分段筛选、分页/虚拟滚动、单词行弹层、删除单词、手动加词；
- **通过标准**：UI 手工验收 + `tests/data/decks.repo.test.ts`（CRUD + 分页 + 搜索）。

### AC7 · 默认词库正确
- `ensureBuiltinDecks()` 后：`decks.length=2`；默认词库 `kaoyan-hongbaoshu-2025`（受限商业词表，6702 词，isDefault=true）；
  第二词库 `kaoyan-2027-dagang`（**5528** 词：源 5530 条按 `normalizeHeadword` 去重，`may/May`、`march/March` 两对大小写变体各保留首次出现）；词库详情页展示版权/许可（D20/D21）；
- 学习队列默认从受限商业词表取词。
- **通过标准**：`tests/data/builtin.test.ts` 断言 count + `docs/DATA-API.md` 记录来源与转换脚本命令。

### AC8 · PWA 可安装、离线可用
- `pnpm build && pnpm preview` → 手机 Chrome `http://127.0.0.1:4173`：manifest 可解析（名称/图标/standalone/theme_color），
  SW 注册成功（DevTools→Application），断网刷新仍能打开并完成一轮学习（内置词库已种子化、数据在本机）；
- 主屏安装：Chrome 菜单出现「安装应用/添加到主屏幕」；启动后无地址栏（standalone）；
- `theme-color` 浅/深主题正确（白/`#101312`）；离线首页无白屏、无资源 404。
- **通过标准**：QA 按 docs/QA.md 的手机步骤执行并截图；`pnpm build` 产物中 `sw.js`/`manifest.webmanifest`/`icons/*` 存在
  （arch 已在 ARCH.md 记录 preview 验证方法）。

---

## 11. 与 research / 既有脚手架的偏差与解释（Lead 需知情）

| # | 本文定稿 | research 建议 / 脚手架现状 | 解释（DECISIONS 优先） |
|---|---|---|---|
| 1 | 默认词库 = **受限商业词表 2025（6702 词）**，第二 = 大纲 5528 | research 建议：默认用大纲 5530（版权更干净） | **D20 拍板受限商业词表默认**；产品内必须标注「非官方、仅个人学习、禁止商用」（D20/§6）；若 Lead 后改主意，只改 `isDefault` 与默认选中，不影响代码结构 |
| 2 | 学习量与默认 `dailyGoal=30` | research 默认 100（ALGO_CONST.DEFAULT_DAILY_TARGET）；UI 研究建议 30 | 采用 UI 研究的 30（可调 5–200）；调度数学与学习量无关，只影响队列截断 |
| 3 | 底部 Tab **4 个**（首页/词库/统计/我的），学习页无 Tab | arch 脚手架占位为 5 个（含「学习」） | 采用 UI 研究 §3.2（更接近MaiMemo原版）；需改 `src/app/routes.ts` 的 `TAB_ITEMS`（task-10 执行） |
| 4 | 评分只有 3 个：认识/模糊/不认识 | MaiMemo有 4 个（+熟知） | 用户需求 + D9/D16；`phase='mastered'` 仅为MaiMemo导入数据保留，UI 无「熟知」按钮 |
| 5 | 词难度 `d0` 固定 5，不做 WDR/词频代理 | research 建议用词频代理（可见差异来源，附录 B.3） | D7：先保证可解释/可上线；`difficultyPrior` 钩子留好，v2 再接 |
| 6 | 当日回炉 gap = 4/8 个词位 | research 推测值（D 级证据） | D10：参数化放 `params.ts`，可 A/B；不动数据格式 |
| 7 | `encounters` 在**进入注释面**时 +1（每个词每会话一次） | research/UI 说「进入白板面时 +1」 | Lead 授权由 SPEC 定；选「看到释义才算遇到」更符合“遇到”语义，且避免白板面刷词导致 encounters 虚高；已写进 §4.6 |
| 8 | 不熟悉度展示 `clamp01`，原始 `clicks` 可 > `encounters` | UI 研究 §5.2.2 同 | 一致 |
| 9 | MaiMemo导入需「Token + 本地代理」，不聚合账号密码 | research 同 | D23/D24 + 协议 5.1.6；Token 过期 7 天需重贴 |
| 10 | 内置词库以动态 chunk 打包（不静态进主 bundle） | research 建议 `public/` fetch | 保证离线首启可用（PWA precache 主 bundle 不含词库；词库 chunk 懒加载 + 随后写 Dexie） |
| 11 | 主题变量：**统一采用 UI 研究的 `--mm-*` tokens**（替换 arch 占位的 `--color-*`） | arch 脚手架当前是 `--color-*` | 避免两套变量并存；task-10 在 `global.css` 用 `--mm-*` 落地，`tailwind.config.js` 的语义色映射同步改（arch 可协助，改前报备） |
| 12 | 同日非首次评分的日志 `longTermUpdate=false` | research 同 | 统计时只计入首次反馈（§3.10） |

**修正记录（2026-11-10，dev-algo/dev-data 核对后）**
- §1.3/§3.1/§3.2/§3.3：d0=5 的初始半衰期 `h0` 由 `1.74` 修正为 **`1.7635`**（`-1/log2(0.925-0.05×5) = -1/log2(0.675)`）。只有 1.7635 能复现 §3.3 基准序列（次序 2：`p=0.675`、`h=12.31`）；1.74 会得 `p=0.6713`。
- §1.6/AC7：内置大纲词库条数由源文件 5530 条修正为 **5528**（`may/May`、`march/March` 两对大小写变体按 `normalizeHeadword` 去重、各保留首次出现）；受限商业词表保持 **6702**。

---

## 12. 并行开工清单 & 待 Lead 确认

### 12.1 三条线如何同时开工（依赖已满足 task-5）

| 任务 | 可立即开工 | 依据 | 前置产出 |
|---|---|---|---|
| task-6 dev-algo（core） | ✅ | 本文 §1/§3/§4/§9.2 | 无（类型先落 `types.ts` + `params.ts`，同时给 UI 契约） |
| task-7 dev-data（存储/导入导出/内置库） | ✅ | 本文 §1/§2/§6/§9.3、§7 | 依赖 task-6 的 `ids/time/types`？→ **类型在 §1.2，dev-data 可先复制/等 core 类型导出**；建议 dev-algo 先 30 分钟内交付 `types.ts`+`ids.ts`+`time.ts`，dev-data 并行写 repo 逻辑，最后联调 |
| task-8 dev-data（MaiMemo API） | ⏸ 等 task-7 | 本文 §7、§9.3 | 可先写 doc + 映射器纯函数 + mock 测试（接口不必等） |
| task-9 dev-ui A（学习页） | ✅ | 本文 §4/§8.2/§5、03-ui | core session 契约（§4.2）可先按签名 mock；集成时换真实现 |
| task-10 dev-ui B（其余页 + 外壳） | ✅ | 本文 §8.1/§8.3/§5、03-ui | 同上；先做 PageShell/Settings/TabBar/主题，后接数据 |
| task-11 QA | ⏸ 等 6/7/8/9/10 | 本文 §10 AC1–AC8 | — |
| task-12 集成 | ⏸ 等 9/10 | §10 AC8、ARCH.md §7 | — |

**集成顺序建议**：core 类型/ids/time（30 min，dev-algo 先发）→ core 调度/会话 + data 表结构/设置/内置库并行 →
data 导入导出 + MaiMemo → UI 学习页 + 其余页 → QA。

### 12.2 需要 Lead 转达 / 拍板的点（不阻塞开工，按本文默认值先做）

1. **词库版权**：默认受限商业词表属“个人学习用”的导出词表（D20 已拍板），是否需要在首启/关于页加显式免责声明文案？默认按「关于页 + 词库详情页标注」实现。
2. **MaiMemo Token 何时要**：验收阶段（D29）由 Lead 向用户一次性索取；开发期全部用 mock，不阻塞。
3. **词组数据缺失**：两份内置词库 `phrases=[]`，w-c「显示词组」开关默认开但无内容 → 首版接受“空词组”；若要求必须有词组，需额外数据源（不阻塞）。
4. **音标缺失**：内置数据无音标；`board.showPhonetic` 默认 true 但无数据时 `Word.phonetic` 为空 → **白板面不显示音标/发音按钮**（隐藏而非占位）。若要补音标，需 ECDICT 63MB 增量导入（D25，后续）。
5. **每日学习量单位**：按官方=单词数（复习+新学），非分钟；首页可显示「预计约 X 分钟」（3s/9s/6s 成本估算，可选）。
6. **AC5 测试依赖**：`fake-indexeddb` 是否允许新增 devDependency？若不允许，AC5 的自动化改为纯函数 + 手工步骤（SPEC 已给出降级方案）。

### 12.3 文档交付检查（Lead 验收 task-5）

| 研究产出 | 本文吸收位置 |
|---|---|
| 01 算法（DHP/阈值/SSP-MMC/参数/基准序列） | §3（公式、参数、基准）、§11-5/6 |
| 02 数据 API（Token/CORS/字段映射/词库源） | §7、§1.6、§6、§11-1/9 |
| 03 UI（白板/注释/w-c/不熟度/token/设置/组件） | §4、§5、§8、§11-3/11 |
| DECISIONS D1–D29 | 全文（§3.1、§4、§5、§7、§11 逐条对应） |
| ARCH 脚手架（路由/主题/PWA/测试） | §0-4、§8.1、§9.1 |

---

*（本文结束。改动必须同步 §9 接口与相关测试；任何与 DECISIONS 冲突的改动先报 Lead。）*
