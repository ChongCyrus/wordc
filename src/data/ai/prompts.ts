/**
 * Prompt 模板 v1（task-70）—— **纯函数、无浏览器/Dexie 依赖**。
 *
 * 与 arch 的批量 CLI（task-73）共用同一契约：CLI 直接 import 本文件拼 prompt，
 * 保证「手动试水」与「App 内生成」输出风格/校验一致。
 * 证据/规格：docs/ARCH-CONTENT-PACKS.md §6、docs/SPEC-CONTENT-PACKS.md §2。
 */

import type {
  ContentKind,
  GenerateTarget,
  PackExample,
  PackMnemonic,
  PackPhrase,
  SingleContentKind,
} from './types'

/** prompt 版本号（写进 momo-pack meta.promptVersion） */
export const PROMPT_VERSION = 'v1'

/** 每类内容每个目标最多生成多少条（合并上限另由数据层限制） */
export const CONTENT_LIMITS: Record<SingleContentKind, number> = {
  examples: 2,
  phrases: 3,
  mnemonics: 1,
}

/** 允许的助记类型（模型输出用的英文代号；与 ARCH prompt 一致） */
export const MNEMONIC_TYPES = ['root', 'assoc', 'story'] as const

/**
 * AI 英文助记类型 → core `Mnemonic.type`（中文）映射。
 * packs/schema 的 Mnemonic.type 只接受 core 的中文类型，UI/落库前用本表转换。
 */
export const AI_MNEMONIC_TYPE_MAP: Record<(typeof MNEMONIC_TYPES)[number], '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他'> = {
  root: '词根',
  assoc: '联想',
  story: '联想',
}

/** 把 AI 产出的助记类型规范成 core Mnemonic.type（未知值回退「其他」） */
export function toCoreMnemonicType(type: string): '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他' {
  return (AI_MNEMONIC_TYPE_MAP as Record<string, '联想' | '谐音' | '词根' | '词源' | '串记' | '口诀' | '其他'>)[type] ?? '其他'
}

/** 生成结果 JSON schema（给模型看的文本版，保持与 zod 校验一致） */
export const PACK_ITEMS_JSON_SCHEMA = `{
  "items": [
    {
      "headword": "string（原拼写，必须与输入 target 一致）",
      "meaningIndex": "number?（1 起；仅当输入 target 带 meaningIndex 时填写）",
      "examples": [{"en": "string", "cn": "string"}],
      "phrases": [{"en": "string", "cn": "string", "meaningIndex": "number?"}],
      "mnemonics": [{"type": "root|assoc|story", "text": "string（≤60 字中文）"}]
    }
  ]
}`

/** system prompt（固定，版本化；CLI 与 App 共用） */
export function buildSystemPrompt(): string {
  return [
    `你是英语学习内容编辑（prompt ${PROMPT_VERSION}）。给定一批单词/含义，生成【例句/词组/助记】。`,
    '要求：',
    '1) 只输出严格 JSON（不要 Markdown 代码块/解释/前后缀），schema 见下；',
    '2) 例句：英文自然、必须包含目标词原形或其变形，附准确中文翻译；每个目标 1–2 条；',
    '3) 词组：英文短语 + 中文释义；若给定 meaningIndex，词组必须表达该含义；否则给常用义；',
    '4) 助记：type ∈ {"root","assoc","story"}，text 简洁（≤60 字中文）；',
    '5) 不得编造生僻义/错误翻译；不得输出已有内容（会提供 existing 计数，尽量换个角度）；',
    '6) 每个目标最多 limit 条；无合适内容则输出空数组；',
    '7) headword 必须与输入 target 的 headword 一致（大小写可不同）；不得输出输入之外的词。',
    'JSON schema:',
    PACK_ITEMS_JSON_SCHEMA,
  ].join('\n')
}

/** task-128：助记 prompt 版本 */
export const PROMPT_VERSION_MNEMONIC = 'v3.0-mnemonic-c'

/** 助记 system prompt：帮助记住「单词 w → 具体含义 c」的映射（docs/AI-CONTENT-SPEC §3.1） */
export function buildSystemPromptMnemonic(): string {
  return [
    `你是英语词汇助记编辑（prompt ${PROMPT_VERSION_MNEMONIC}）。给定一批「单词 + 指定含义 c（含 meaningIndex/词性/中文）」，为每个 c 生成 1 条助记。`,
    '目标：帮助学习者记住「这个单词 w → 这个具体含义 c」的映射，不是只解释词根。',
    '要求：',
    '1) 只输出严格 JSON（不要 Markdown/解释/前后缀），schema 见下；',
    '2) 每条助记必须同时锚定「单词拼写/发音/构词」+「该 c 的中文含义」：读完能由 w 想起 c；',
    '3) 允许形式（贴合该词即可，可混合）：①词根/构词拆解 + 一句话桥接到中文含义（如 ad(向)+dress(引导) → 把话引向某人 → 致辞）；②自然谐音/近音；③形象/场景故事（把拼写片段与含义绑定）；④与易混词/同词其它 c 对比；',
    '4) 禁止：只写词源/词根解释而没有「→ 该 c 中文含义」的桥接；只重复中文释义；与目标 c 无关的通用助记；编造词源；',
    '5) 每个输入 target 必须原样返回 headword 与 meaningIndex（1 起，与输入一致），不得串到同词其它 c；',
    '6) 长度：1–2 句、≤60 字，中文为主，可含英文词根/单词；每个 target 仅 1 条；',
    '7) 输出 mnemonics type ∈ {"root","assoc","story"}。',
    'JSON schema:',
    PACK_ITEMS_JSON_SCHEMA,
  ].join('\n')
}

/** 助记 user prompt：逐条列出 (headword, meaningIndex, pos, cn) */
export function buildUserPromptMnemonic(targets: GenerateTarget[]): string {
  const payload = targets.map((target) => ({
    headword: target.headword,
    meaningIndex: target.meaningIndex,
    meaning: target.meaningIndex != null ? target.meanings[target.meaningIndex - 1] : undefined,
  }))
  return [
    'kind = mnemonics（每个 target 对应一个具体含义 c；必须返回 headword+meaningIndex，并为该 c 生成 1 条助记）',
    'targets（逐条返回，headword+meaningIndex 必须一致）：',
    JSON.stringify(payload),
  ].join('\n')
}

/** 某批次里每个目标的输入摘要（避免把 Word 全量塞进 prompt） */
function targetPayload(target: GenerateTarget): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    headword: target.headword,
    meanings: target.meanings.map((m) => ({ pos: m.pos, cn: m.cn })),
    existing: target.existing,
  }
  if (target.meaningIndex != null) payload.meaningIndex = target.meaningIndex
  return payload
}

export interface BuildUserPromptOptions {
  kind: SingleContentKind
  targets: GenerateTarget[]
  /** 每目标条数上限；缺省 CONTENT_LIMITS[kind] */
  limit?: number
}

/** user prompt（动态；严格 JSON 输入摘要） */
export function buildUserPrompt(opts: BuildUserPromptOptions): string {
  const limit = Math.max(1, Math.floor(opts.limit ?? CONTENT_LIMITS[opts.kind]))
  return [
    `kind = ${opts.kind}`,
    `limit = ${limit}（每个目标最多 ${limit} 条）`,
    `targets = ${JSON.stringify(opts.targets.map(targetPayload))}`,
    '请只输出 JSON 对象 {"items":[...]}，items 顺序与 targets 一致。',
  ].join('\n')
}

/** 解析失败后的修复提示（追加到原 user prompt） */
export function buildRepairPrompt(previousUserPrompt: string, errorSummary: string): string {
  const safe = errorSummary.replace(/\s+/g, ' ').slice(0, 300)
  return [
    previousUserPrompt,
    `你的输出不是合法 JSON（错误：${safe}）。`,
    '请严格只输出符合 schema 的 JSON 对象 {"items":[...]}，不要 Markdown、不要解释、不要额外文字。',
  ].join('\n')
}

/** 把模型条目里的 kind 内容折叠成 momo-pack 条目（校验通过后由 generate 使用） */
export interface RawPackItem {
  headword: string
  headwordLower?: string
  meaningIndex?: number
  examples?: PackExample[]
  phrases?: PackPhrase[]
  mnemonics?: PackMnemonic[]
}

export type { ContentKind }


// ============================================================================
// prompt v2（w-c 级：每个含义独立内容）—— task-73/74 追加，v1 保持不变
// ============================================================================

/** v2 版本号（写进 pack meta.promptVersion='v2'） */
export const PROMPT_VERSION_V2 = 'v2.1'

/** w-c 级：每个含义最多生成多少条 */
export const WC_CONTENT_LIMITS: Record<SingleContentKind, number> = {
  examples: 2,
  phrases: 3,
  mnemonics: 1,
}

/** w-c 级生成目标：一个词的每个含义分别作为目标（meaningIndex 1 起） */
export interface WcMeaningTarget {
  headword: string
  headwordLower: string
  meaningIndex: number
  meaning: { pos?: string; cn: string }
}

/** v2 输出 JSON schema（给模型看的文本版） */
export const PACK_ITEMS_JSON_SCHEMA_V2 = `{
  "items": [
    {
      "headword": "string（原拼写，必须与输入 target 一致）",
      "meaningIndex": "number（1 起，必须等于输入该含义的序号）",
      "skipped": "boolean?（无法与该词其它 c 区分时 true，此时内容数组留空）",
      "examples": [{"en": "string", "cn": "string"}],
      "phrases": [{"en": "string", "cn": "string"}],
      "mnemonics": [{"type": "root|assoc|story", "text": "string（≤60 字中文）"}]
    }
  ]
}`

/** system prompt v2：按「含义」生成，不得串到别的 c */
export function buildSystemPromptV2(): string {
  return [
    `你是英语学习内容编辑（prompt ${PROMPT_VERSION_V2}）。给定一批「单词的某个具体含义」，为每个含义生成例句/词组/助记。`,
    '要求：',
    '1) 只输出严格 JSON（不要 Markdown/解释/前后缀），schema 见下；',
    '2) 每个输入 target 都对应一个「含义」，必须原样输出其 headword 与 meaningIndex（1 起，与输入一致）；',
    '3) **中文含义原文是强约束**：生成内容必须准确表达输入里的 meaning.cn，不得偏离/扩大/换成该词的其他义项，不得串到同词其它 c；',
    '4) **每条例句/词组都必须出现目标词本身**（原形或变形）；**近义/近重复 c 必须区分**：如果一个词的两个 c 含义接近（如 sheet 的“（一）张/纸”、take 的“拿走/携带”），必须让内容体现差异；若确实无法区分，输出该 c 的 `"skipped": true` 且内容数组留空，**不要编造重复内容**；',
    '5) examples：1–2 条英文例句 + 中文翻译；phrases：2–3 条英文短语 + 中文释义；mnemonics：1 条助记（type ∈ root/assoc/story，≤60 字中文）；例句/词组必须包含该词原形/变形，且**同一词不同 c 之间不得重复同一英文内容**；',
    '6) 不得编造生僻义/错误翻译；只输出输入里出现的 (headword, meaningIndex)，不得输出额外目标。',
    'JSON schema:',
    PACK_ITEMS_JSON_SCHEMA_V2,
  ].join('\n')
}

/** user prompt v2：每批列出 (headword, meaningIndex, pos, cn) */
export function buildUserPromptV2(targets: WcMeaningTarget[], limit: Record<SingleContentKind, number> = WC_CONTENT_LIMITS): string {
  const payload = targets.map((t) => ({
    headword: t.headword,
    meaningIndex: t.meaningIndex,
    meaning: { ...(t.meaning.pos ? { pos: t.meaning.pos } : {}), cn: t.meaning.cn },
  }))
  return [
    `kind = mixed（每含义：例句+词组+助记；中文含义原文见 target.meaning.cn，必须严格对应）`,
    `limit = ${JSON.stringify(limit)}`,
    'targets（必须逐条返回，headword+meaningIndex 一致）：',
    JSON.stringify(payload),
  ].join('\n')
}

// ============ Prompt v3：本义 / 引申链（semantics，task-76） ============

/**
 * prompt 版本（v3 semantics）；与 arch CLI task-78 共用同一契约。
 * 输出统一为 `{items:[{headword, coreSenses, meaningMap}]}`（便于批量/CLI 复用）。
 */
export const PROMPT_VERSION_V3 = 'v3.7-semantics'

/** semantics prompt 的输入目标（CLI/App 通用；meaningIndex 缺省按数组下标 1 起） */
export interface SemanticsPromptTarget {
  headword: string
  headwordLower?: string
  meanings: Array<{ meaningIndex?: number; pos?: string; cn: string }>
}

/** v3.4 输出 JSON schema 文本（给模型看）：**每个含义一条 coreSenseLabel** */
export const SEMANTICS_JSON_SCHEMA = `{
  "items": [
    {
      "headword": "string（原拼写，与输入一致）",
      "meanings": [
        {
          "meaningIndex": "number（1 起，每个含义必须且只能出现一次）",
          "coreSenseLabel": "string（2–6 字中文规范化本义标签；同一本义的所有 c 必须逐字完全相同；不同本义必须不同）",
          "coreSenseNote": "string?（≤40 字，解释该本义/标注理由）",
          "origin": "string?（≤20 字，词源/词根本义等）",
          "confidence": "high|medium|low",
          "steps": ["string?（可选，2–4 步、每步 ≤20 字，顺序从本义到该 c）"]
        }
      ]
    }
  ]
}`

/** v3.4 system prompt：先读全部 c，再由模型自行拆合，用**相同 label** 表示同一本义 */
export function buildSystemPromptV3(): string {
  return [
    `你是英语词义结构标注编辑（prompt ${PROMPT_VERSION_V3}）。给定一个英文单词及其中文释义列表（含义下标从 1 起），`,
    '为**每个含义**标注它来源的「本义」，只输出严格 JSON（不要 Markdown/解释/前后缀）：',
    '0) **核心理解（最重要）：「本义」是一个集合/多值映射，不是唯一值。** 一个单词完全可能同时拥有 2–3 个（最多 4 个）不同的本义；不要把「本义」误解成「全词只有一个本义」。',
    '1) 必须分两步做：',
    '   第一步【先识别本义集合】：通读该词**全部含义**，先列出该词共有哪些**不同的本义**（1–4 个；很多词有 2–3 个，例如一词多义、名动同形、具体义与抽象义、不同词源并存时）；',
    '   第二步【再映射】把每个 c 映射到上一步的其中一个本义：同一本义用**逐字相同** label，不同本义用**不同** label。',
    '1.1) 反例约束（必须避免）：',
    '   - ❌ 不要因为「本义」这个词，就把全词所有 c 硬塞进同一个 label——只要 c 之间是不同词性、具体↔抽象、不同语义场或不同词源，就应分属**不同本义**；',
    '   - ❌ 也不要为了多拆而把**同一个本义**拆成多个 label（同源/直接近义引申必须合并）。',
    '1.2) 大本义再拆规则（重要，针对 charge/abstract 这类多义大词）：',
    '   - 若某个 coreSenseLabel 覆盖 **≥6 个 c**，必须检查能否拆成 2–4 个更细的本义；',
    '   - 出现以下任一情况**必须拆**：c 之间词性不同（名/动/形…）、具体↔抽象、不同语义域、或引申路径明显不同（如「收费/充电/控告/负责」这类本义已分裂）；',
    '   - 拆分后**每个 c 重新标注 coreSenseLabel**，同一新本义仍逐字一致、不同新本义不同 label；',
    '   - 若检查后确认无法干净拆分（各 c 共享同一底层本义、只是语用差异），允许保留宽泛本义，但必须在 `coreSenseNote` 写明「多义共享本义：<理由>」，不得静默保留大组。',
    '   - 真实反例（必须避免）：charge 的 12 个 c 不能全部归「装载」，至少区分「收费 / 充电 / 控告 / 负责」等 2–4 个细本义；abstract 的 11 个 c 不能全部归「抽离提取」，应区分「提取动作 / 抽象概念 / 摘要」；',
    '   - 正例：advance 的 12 个 c 拆成「向前推进」与「提前支付」两个本义（不同词性/语义域），是合格粒度。',
    '   - steps 必须体现细分差异：不同细本义的 steps 不得完全复用同一串路径（否则说明只是换了 label、没有真正拆开）；同一细本义内的 c 可共享路径起点。',
    '1.3) 跨词性大类必拆（针对 abstract 这类「词源同源、但名词/形容词/动词混合」的大词）：',
    '   - 若同一 label 覆盖 **≥8 个 c**，且这些 c 横跨不同词性大类（名词实体 / 形容词 / 动词动作 / 副词等）或明显不同语义角色，**即使词源同源也必须至少拆 2 个细本义**，按词性/语义角色重新标 label；',
    '   - 示例（必须拆）：abstract 的 c 至少拆出「提取动作（动词：提取/抽象化/转移）」「抽象概念（名词/形容词：抽象/抽象概念/抽象的/深奥）」「摘要（名词实体：摘要/做摘要/写梗概）」中的 ≥2 类；charge 拆 6 个细本义是正例；',
    '   - 反例（不要拆碎）：同一词性、同一语义角色内部（如多个具体名词义）仍应合并，不要为凑数量拆；但「词源同源」不能作为跨词性合并的理由。',
    '2) 每个含义输出一条：{meaningIndex, coreSenseLabel(2–6 个中文字的规范化本义标签), coreSenseNote?(≤40字解释), origin?(≤20字，词源/词根本义), confidence(high|medium|low), steps?(可选 2–4 步、每步≤20字，从本义到该 c)}。',
    '3) **标签一致性（最重要）**：同一个本义的所有 c 必须使用**逐字完全相同**的 coreSenseLabel；不同本义必须使用不同 label。同义不同写法（如「同食同伴」vs「共同进食者」）视为错误。',
    '4) label 用中文概括本义：例：多个 c 都源于「一起吃饭的人」→ 统一写「同食同伴」；不要写整句、不要带标点/编号、不要复述释义原文。',
    '5) 每个 meaningIndex 必须且只能出现一次；不得添加输入之外的词/含义；无法可靠判断时 confidence=low 并在 coreSenseNote 说明。',
    '6) 只输出 JSON：{"items":[{"headword":"...","meanings":[{"meaningIndex":1,"coreSenseLabel":"同食同伴","coreSenseNote":"...","origin":"...","confidence":"high","steps":["...","..."]}]}]}',
    'JSON schema:',
    SEMANTICS_JSON_SCHEMA,
  ].join('\n')
}

function semanticsTargetPayload(t: SemanticsPromptTarget): Record<string, unknown> {
  return {
    headword: t.headword,
    meanings: t.meanings.map((m, i) => ({
      meaningIndex: m.meaningIndex ?? i + 1,
      ...(m.pos ? { pos: m.pos } : {}),
      cn: m.cn,
    })),
  }
}

/**
 * v3 user prompt（两种调用方式，App 批量 / CLI 单词均可用）：
 * - `buildUserPromptV3(targets)`：批量（targets 数组）；
 * - `buildUserPromptV3(word, meanings)`：单词语义（meanings 按数组顺序 1 起）。
 * 输出统一为 `{"items":[...]}` 包装，便于批量解析（task-78 CLI 同契约）。
 */
export function buildUserPromptV3(targets: readonly SemanticsPromptTarget[]): string
export function buildUserPromptV3(
  word: string,
  meanings: ReadonlyArray<{ cn: string; pos?: string; meaningIndex?: number }>,
): string
export function buildUserPromptV3(
  input: readonly SemanticsPromptTarget[] | string,
  meanings?: ReadonlyArray<{ cn: string; pos?: string; meaningIndex?: number }>,
): string {
  const targets: SemanticsPromptTarget[] =
    typeof input === 'string'
      ? [{ headword: input, meanings: (meanings ?? []).map((m) => ({ ...m })) }]
      : [...input]
  return [
    `targets = ${JSON.stringify(targets.map(semanticsTargetPayload))}`,
    '请先通读每个 headword 的全部含义，再逐条输出 JSON 对象 {"items":[...]}；meanings 必须覆盖该词全部 meaningIndex，同一本义用完全相同的 coreSenseLabel。',
  ].join('\n')
}

/** v3 修复提示（输出不合法 JSON / 映射缺失时追加） */
export function buildSemanticsRepairPromptV3(previousUserPrompt: string, errorSummary: string): string {
  const safe = errorSummary.replace(/\s+/g, ' ').slice(0, 300)
  return [
    previousUserPrompt,
    `你的输出不符合要求（错误：${safe}）。`,
    '请严格只输出符合 schema 的 JSON 对象 {"items":[...]}：每个含义一条、meaningIndex 覆盖且不重复、confidence 必填；',
    '同一本义的所有 c 必须使用逐字相同的 coreSenseLabel（不同本义必须不同）；不要 Markdown/解释。',
  ].join('\n')
}

// ============ Prompt v4：本义 / 引申链（grouped semantics，task-96） ============

/**
 * prompt 版本（v4 semantics，grouped 输出）。
 *
 * 与 v3 的关键差异：**模型直接输出分组结构**——
 * `{items:[{headword, coreSenses:[{index,label,gloss,origin?,confidence}], meaningMap:[{meaningIndex,coreSenseIndex,steps?}]}]}`。
 * label 只在 coreSenses 出现一次，c 通过 coreSenseIndex 引用 → **结构上保证同本义 label 逐字一致**
 * （v3 是每个 c 各写一次 coreSenseLabel，靠模型自觉，实测会出现「看是否指图纸」这类非本义 label）。
 *
 * 规格与校验规则：docs/SEMANTICS-FORMAT.md（含 plan/base/abstract 期望输出）。
 * 兼容：v3 的 buildSystemPromptV3/buildUserPromptV3/buildSemanticsRepairPromptV3 **保留不动**，
 * 由 dev-engine 在 generate.ts / CLI 切到 v4 后旧版才可删除。
 */
export const PROMPT_VERSION_V4 = 'v4.0-semantics-grouped'

/** v4 输出 JSON schema 文本（给模型看）：**每词一份 coreSenses + 映射表** */
export const SEMANTICS_JSON_SCHEMA_V4 = `{
  "items": [
    {
      "headword": "string（原拼写，与输入一致）",
      "coreSenses": [
        {
          "index": "number（1 起，词内连续不重复）",
          "label": "string（2–6 个汉字，必须是「含义/义项」，如：基础、图纸、计划；不得是检查步骤或词源）",
          "gloss": "string（≤40 字，解释这个本义是什么）",
          "origin": "string?（≤20 字且必须解释含义，如「拉丁 basis=基础」；没有把握就省略整个字段）",
          "confidence": "high|medium|low"
        }
      ],
      "meaningMap": [
        {
          "meaningIndex": "number（1 起，覆盖输入每个含义且只能出现一次）",
          "coreSenseIndex": "number（指向上面 coreSenses[].index）",
          "steps": ["string?（可选，2–4 步、每步≤20 字，只写「本义→该含义」的语义演变）"]
        }
      ]
    }
  ]
}`

/** v4 system prompt：先归纳本义集合，再映射 c；标签只写一次（结构保证一致） */
export function buildSystemPromptV4(): string {
  return [
    `你是英语词义结构标注编辑（prompt ${PROMPT_VERSION_V4}）。给定一个英文单词及其中文释义列表（含义下标从 1 起），`,
    '输出该词的「本义（core sense）」分组，以及每个含义到本义的映射。只输出严格 JSON（不要 Markdown/解释/前后缀）：',
    '',
    '0) **输出结构（v4 核心改动，必须遵守）**：每个 headword 只输出一份 `coreSenses`（本义清单，每项含 index/label/gloss/origin?/confidence）',
    '   和 `meaningMap`（每个含义一条，用 `coreSenseIndex` 指向本义 index）。**label 只出现在 coreSenses 里一次**，',
    '   同本义的多条含义共享同一个 coreSenseIndex，因此不需要、也不允许在每个含义里重复写 label。',
    '',
    '1) **label 必须是「含义」**：2–6 个汉字，能独立回答「这个词的这一个本义是什么意思」（名词/动词/形容词性短语均可）。',
    '   1.1 正例：基础、底部、基地、图纸、计划、设计、抽取、摘要、抽象概念、向前推进、提前支付。',
    '   1.2 反例（出现即不合格）：',
    '        ❌ 「看是否指图纸」（这是检查步骤，不是含义）',
    '        ❌ 「源自希腊 basis」（这是词源，不是含义）',
    '        ❌ 「是否指基础」「检查是否为平面图」「可能是…」（检查/揣测口吻）',
    '        ❌ 「拉丁文」「英语词」「词根义」（语言/词源说明）',
    '        ❌ 「本义→引申义」「第一步含义」（箭头/步骤连接词）',
    '   1.3 禁止包含以下字样：是否、看、检查、源自、源古、来自、出自、词源、词根、希腊、拉丁、英语、法语、德语、→、->、推导、判断、确认、核对；',
    '       禁止以「的」堆叠（如「…的…的」），禁止标点/编号/引号。label 应是「基础」「图纸」这样的纯中文短词，不是整句。',
    '',
    '2) **gloss（本义解释）**：≤40 字，用一句中文说明这个本义是什么（可含「指…」「即…」），不要复述某个具体释义原文、不要写检查过程。',
    '3) **origin（词源，可选，宁缺毋滥）**：≤20 字，且**必须带含义解释**，格式如「拉丁 basis=基础」「古英语 plan=平面」「法语 suite=跟随」。',
    '   只写「源自希腊 basis」「希腊语」这类**没有解释含义的写法一律不允许**；没把握就省略 origin 整个字段。',
    '4) **steps（引申链，可选）**：2–4 步、每步≤20 字，只描述「本义 → 该含义」的语义演变（如「图纸」→「按图施工的方案」→「计划」）。',
    '   禁止写是否/检查/来源/词源内容；也禁止元推理词（通读、义项、定名、归并、其中、综上、判断、可见、分类、统计、归纳、标注、映射、判定、推断、总结、首先、其次、然后、释义、归为、归入、判为、分为、区分、其余、归类、拆分、划为）。steps 是给学习者看的意义链，不是推理日志。同一 coreSense 下的不同含义可以共用起点，但不要照抄检查过程或标注步骤。',
    '',
    '5) **拆合规则**（沿用 v3 的经验，但 v4 用结构表达）：',
    '   5.1 一个词 1–4 个本义；同一本义的不同含义只能映射到同一个 coreSenseIndex，不同本义必须用不同 coreSense 项。',
    '   5.2 若某本义覆盖 ≥6 个含义，检查是否需要拆成 2–4 个更细本义：含义跨词性（名/动/形）、具体↔抽象、语义域明显不同、引申路径不同 → 必须拆；',
    '   5.3 同一词性、同一语义角色内的近义含义（如多个具体名词义）不要拆碎；同义/直接近义的 label 必须合并（如「同食同伴」与「共同进食者」只保留一个）。',
    '   5.4 典型正例：abstract → 抽取 / 抽象概念 / 摘要；charge → 收费 / 充电 / 控告 / 负责；plan → 图纸 / 计划（必要时 设计）。',
    '',
    '6) **完整性与一致性不变量（违反即不合格）**：',
    '   - coreSenses 1–4 项，index 从 1 起连续不重复；label 词内唯一（逐字不同），不得近义重复；',
    '   - meaningMap 必须覆盖输入的每个 meaningIndex **恰好一次**；coreSenseIndex 必须指向存在的 coreSense；',
    '   - 每个 coreSense 至少被 1 个含义引用（不得出现没人用的本义）；不得添加输入之外的词/含义；',
    '   - 无法可靠判断时 confidence=low，并在 gloss 里写明「暂按…归并」；不要编造词源。',
    '',
    '7) 只输出 JSON：{"items":[{"headword":"...","coreSenses":[{"index":1,"label":"基础","gloss":"事物的根本或起点","origin":"拉丁 basis=基础","confidence":"high"}],"meaningMap":[{"meaningIndex":1,"coreSenseIndex":1,"steps":["基础","作为支撑的部分"]}]}]}',
    'JSON schema:',
    SEMANTICS_JSON_SCHEMA_V4,
  ].join('\n')
}

/**
 * v4 user prompt（两种调用方式，App 批量 / CLI 单词均可用）：
 * - `buildUserPromptV4(targets)`：批量（targets 数组）；
 * - `buildUserPromptV4(word, meanings)`：单词语义（meanings 按数组顺序 1 起）。
 * 输出统一 `{items:[...]}`；引导模型「先归纳 coreSenses，再逐条映射」。
 */
export function buildUserPromptV4(targets: readonly SemanticsPromptTarget[]): string
export function buildUserPromptV4(
  word: string,
  meanings: ReadonlyArray<{ cn: string; pos?: string; meaningIndex?: number }>,
): string
export function buildUserPromptV4(
  input: readonly SemanticsPromptTarget[] | string,
  meanings?: ReadonlyArray<{ cn: string; pos?: string; meaningIndex?: number }>,
): string {
  const targets: SemanticsPromptTarget[] =
    typeof input === 'string'
      ? [{ headword: input, meanings: (meanings ?? []).map((m) => ({ ...m })) }]
      : [...input]
  return [
    `targets = ${JSON.stringify(targets.map(semanticsTargetPayload))}`,
    '对每个 headword：先通读全部含义，归纳 1–4 个「本义」（coreSenses：index/label/gloss/origin?/confidence；label 必须是 2–6 字含义，禁止写成检查步骤或词源），',
    '再把每个含义映射到 coreSenseIndex（覆盖全部 meaningIndex 且不重复；需要时给 steps 2–4 步含义演变）。',
    '只输出 {"items":[...]}；label 只在 coreSenses 出现一次，不要在每个含义里重复 label。',
  ].join('\n')
}

/** v4 修复提示（输出不合法 JSON / 映射缺失 / label 违规时追加） */
export function buildSemanticsRepairPromptV4(previousUserPrompt: string, errorSummary: string): string {
  const safe = errorSummary.replace(/\s+/g, ' ').slice(0, 300)
  return [
    previousUserPrompt,
    `你的输出不符合 v4 要求（错误：${safe}）。`,
    '请严格只输出符合 schema 的 JSON 对象 {"items":[...]}，并逐条自检：',
    '① coreSenses 1–4 项、index 从 1 起连续、label 2–6 个汉字且是「含义」（不得含 是否/看/检查/源自/希腊/拉丁/箭头 等字样，不得是词源）；',
    '② meaningMap 覆盖每个 meaningIndex 恰好一次，coreSenseIndex 均有效；③ 每个 coreSense 至少被引用一次；',
    '④ origin 若有则 ≤20 字且必须解释含义（如「拉丁 basis=基础」），否则省略；⑤ steps 若有则 2–4 步、每步≤20 字、只写含义演变。',
    '不要 Markdown/解释。',
  ].join('\n')
}
