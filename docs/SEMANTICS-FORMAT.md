# 本义 / 引申链格式规范 v4（grouped semantics）

> 任务：task-96 · 负责人 research-api · 日期：**2026-11-12**
> 适用：`--kind semantics`（AI 批量生成 `momo-pack` 的 `coreSenses` + `meaningMap`）、App 内生成、CLI（`tools/gen-pack-deepseek.mjs`）
> 代码常量：`src/data/ai/prompts.ts` → `PROMPT_VERSION_V4` / `SEMANTICS_JSON_SCHEMA_V4` / `buildSystemPromptV4` / `buildUserPromptV4` / `buildSemanticsRepairPromptV4`
> 相关：`docs/AI-BULK-GEN.md §3.6`、`src/data/ai/types.ts`（`CoreSense` / `MeaningMapEntry`）、`src/data/ai/semantics.ts`（v3 校验器，v4 新增校验见 §6）

---

## 0. 为什么改（v3 的真实缺陷）

用户截图里 plan / base / tunnel 的「本义」出现的是**括号说明文字**，不是含义：

| 截图问题 | 实际内容 | 性质 | 正确本义 |
|---|---|---|---|
| plan 本义① | 「看是否指图纸」 | 检查步骤 | **图纸**（或平面图） |
| base 本义① | 「源自希腊 basis」 | 词源说明 | **基础** |
| tunnel 同类 | 「是否为隧道」 | 检查步骤 | **隧道** |
| 一致性问题 | 同一本义在不同 c 下括号内容措辞不同 | v3 让模型对每个 c 各写一次 label，靠自觉保证一致 | 同义项只写一次 |

**根因**：v3 的输出结构是「每个 c 一条 `coreSenseLabel`」，模型要重复写同一个标签，容易写成解释性文字且措辞漂移。
**v4 的修法**：改成 grouped——模型对每个词**只输出一次** `coreSenses` 清单，每个 c 只用 `coreSenseIndex` 引用。label 物理上只存在一份，**结构上不可能不一致**。

---

## 0.1 模板唯一来源与强制性

- **canonical 提示词**：**[docs/prompts/semantics-v4.md](./prompts/semantics-v4.md)**（system + user + schema + repair + 自检清单，逐字来自 `src/data/ai/prompts.ts` 的 v4 函数）。
- **所有批量生成必须使用 v4（或更新）模板**：App 内批量生成（`src/data/ai/generate.ts`）、CLI（`tools/gen-pack-deepseek.mjs`）、外部 workflow、子代理一律如此；v3 的 per-c `coreSenseLabel` 格式**停止使用**。
- 生成的 `momo-pack` 必须写 `meta.promptVersion='v4.0-semantics-grouped'`，否则无法追溯用哪个模板生成。
- 一致性守护：`tests/data/ai/semantics-prompt-consistency.test.ts` 检查本文件/`prompts.ts`/canonical md 三者同步。

---

## 1. v4 输出结构（模型直接输出，不是后聚合）

```json
{
  "items": [
    {
      "headword": "plan",
      "coreSenses": [
        { "index": 1, "label": "平面图", "gloss": "平铺绘制的图形，后指图纸、示意图", "origin": "拉丁 planum=平面", "confidence": "high" },
        { "index": 2, "label": "计划",   "gloss": "预先安排的行动方案", "origin": "图纸义=方案", "confidence": "high" },
        { "index": 3, "label": "设计",   "gloss": "为建造或制作预先画出方案", "confidence": "medium" }
      ],
      "meaningMap": [
        { "meaningIndex": 1, "coreSenseIndex": 2, "steps": ["平面图", "按图施工的方案", "预先安排"] },
        { "meaningIndex": 2, "coreSenseIndex": 1 },
        { "meaningIndex": 3, "coreSenseIndex": 2 },
        { "meaningIndex": 4, "coreSenseIndex": 3 }
      ]
    }
  ]
}
```

### 1.1 结构不变量（校验器必须逐条检查）

| # | 规则 | 违反处理 |
|---|---|---|
| S1 | `coreSenses` 1–4 项（1 个本义也合法；多义词通常 2–3 个） | 重试 / invalid |
| S2 | `index` 从 1 起**连续、不重复**（1..N） | 归一化重排；无法则 invalid |
| S3 | `label` 词内**唯一**（逐字不同），且不得近义重复（见 §2.3 合并规则） | 合并后重映射；仍冲突则 invalid |
| S4 | `meaningMap` 覆盖输入的每个 `meaningIndex` **恰好一次** | 缺失/重复 → invalid（可重试） |
| S5 | `coreSenseIndex` 必须指向存在的 coreSense | 丢弃该条 → 触发 S4 失败 |
| S6 | 每个 coreSense **至少被 1 个含义引用**（不得有孤儿本义） | 删除孤儿本义并重排 index |
| S7 | 不得添加输入之外的 headword / meaningIndex | 丢弃并记录 |
| S8 | `steps` 可选；有则 2–4 步、每步 2–20 字 | 不合规则丢弃 steps（不阻断整条），或重试 |

---

## 2. label 规则（v4 最重要的质量门）

### 2.1 硬性格式

- **必须是「含义/义项」**：能独立回答「这个本义是什么意思」，名词/动词/形容词性短语均可。
- 长度：**2–6 个汉字**，`^[\u4e00-\u9fff]{2,6}$`（纯汉字，不含标点/数字/字母/空格/引号/编号）。
- 不允许标点（`，。；：、！？（）【】` 等）、不允许「的」堆叠（`/的.*的/`）。
- 不允许是释义原文整句；应是概括性短词（如「基础」而不是「事物的根本或起点」——后者放 gloss）。

### 2.2 黑名单

| 类别 | 禁止字样（label 中出现即不合格） |
|---|---|
| 检查/判断 | `是否`、`看`、`检查`、`判断`、`确认`、`核对`、`推导` |
| 词源/来源 | `源自`、`源古`、`来自`、`出自`、`词源`、`词根` |
| 语言名 | `希腊`、`拉丁`、`英语`、`法语`、`德语`、`古英语` |
| 箭头/步骤 | `→`、`->`、`第一步`、`第二步`、`本义`、`引申义`（单独当 label 时） |
| 口吻词 | `可能`、`大概`、`也许`、`疑似` |

> 注意：**`源` 单字不禁**（「根源」「源泉」是合法含义）；只禁「源自/源古/词源」这类说明性组合。

### 2.3 正反例（各 5 条）

| ✅ 正例（含义） | ❌ 反例（说明文字） | 判定原因 |
|---|---|---|
| 基础 | 源自希腊 basis | 词源说明 |
| 图纸 | 看是否指图纸 | 检查步骤 |
| 计划 | 可能是计划 | 揣测口吻 |
| 抽取 | 本义→引申义 | 箭头/步骤词 |
| 提前支付 | 拉丁 pre+pay | 语言/构词说明 |

### 2.4 近义拆分合并规则（词内）

同义/直接近义的 label 不能拆成两个本义；校验器按以下确定性顺序合并：

1. `normalize(label)` = 去首尾空白 → 全角转半角 → 去内部空格 → 去结尾「的」；
2. 若两个 normalized 完全相等 → 合并；
3. 若存在**包含关系**且较短者 ≥2 字（如「计划」⊂「计划方案」）→ 合并为**较短**者（保留其 gloss/origin，较长者的 gloss 可拼接去重）；
4. 若长度相同且**编辑距离 ≤1**（如「基础」/「基底」不算，编辑距离 2；「同食同伴」/「同食同伙」编辑距离 2 也不合并——**只在 ≤1 且语义相同时人工确认**，默认不自动合并，避免误合）；
5. 合并后统一重映射 `meaningMap[].coreSenseIndex`，并重排 `coreSenses[].index`（1..N）。

> 编辑距离 ≤1 的自动合并风险较高（可能把「基地/基地」之外的近似含义误合），建议**只自动做 1–3**，第 4 条只报告 warning 交人工/重试。

---

## 3. gloss / origin / steps 规则

### 3.1 gloss（本义解释，必填）
- 长度 **1–40 字**；
- 用一句中文说明这个本义是什么；可含「指…」「即…」；
- 不得复述某个具体含义原文、不得写检查/判断过程、不得是词源罗列。

### 3.2 origin（词源/词根，可选）
- 长度 **≤20 字**；**必须带含义解释**，若没把握**整个字段省略**；
- 合格：`拉丁 basis=基础`、`古英语 plan=平面`、`法语 suite=跟随`、`拉丁 abs+tract=抽离`；
- 不合格：`源自希腊 basis`、`希腊语`、`词根 tract`（只给来源不给含义）；
- 校验 regex：`/(=|＝|即|意为|意思是|指)/` 且**不以「源自」「来自」「出自」开头**且长度 ≤20。

### 3.3 steps（引申链，可选）
- **2–4 步**，每步 **2–20 字**；
- 只写「本义 → 该含义」的**语义演变**，例如 `["抽取", "抽取要点", "摘要"]`；
- 禁止出现 `是否`、`看`、`检查`、`来源`、`源自`、`词源`、`希腊`、`拉丁`、箭头；禁止是推理日志/检查步骤；
- 直接同义（c 与 label 同义）时**省略 steps**；steps 首步通常等于 label 或 label 的近义（允许，用于 UI 展示链条）。

---

## 4. 三个词的期望输出（golden examples）

### 4.1 plan

输入：`1. n. 计划；方案  2. n. 平面图；示意图  3. v. 计划；打算  4. v. 设计；绘制平面图`

```json
{
  "headword": "plan",
  "coreSenses": [
    { "index": 1, "label": "平面图", "gloss": "平铺绘制的图形，后指图纸、示意图", "origin": "拉丁 planum=平面", "confidence": "high" },
    { "index": 2, "label": "计划", "gloss": "预先安排的行动方案", "origin": "图纸义=方案", "confidence": "high" },
    { "index": 3, "label": "设计", "gloss": "为建造或制作预先画出方案", "confidence": "medium" }
  ],
  "meaningMap": [
    { "meaningIndex": 1, "coreSenseIndex": 2, "steps": ["平面图", "按图施工的方案", "预先安排"] },
    { "meaningIndex": 2, "coreSenseIndex": 1 },
    { "meaningIndex": 3, "coreSenseIndex": 2 },
    { "meaningIndex": 4, "coreSenseIndex": 3 }
  ]
}
```

校验要点：label 均 2–6 汉字、无黑名单词；origin `拉丁 planum=平面` 含 `=` 与含义；meaningMap 覆盖 1–4；4 个 c 全部有归属。

### 4.2 base

输入：`1. n. 基础；基底  2. n. 底部；底座  3. n. 基地；根据地  4. adj. 基础的；基本的  5. vt. 以…为基础`

```json
{
  "headword": "base",
  "coreSenses": [
    { "index": 1, "label": "基础", "gloss": "事物的根本或起点，可作支撑", "origin": "希腊 basis=基础", "confidence": "high" },
    { "index": 2, "label": "底部", "gloss": "物体最下面的支撑部分", "confidence": "high" },
    { "index": 3, "label": "基地", "gloss": "活动或驻扎的固定地点", "origin": "基础义=地点", "confidence": "medium" }
  ],
  "meaningMap": [
    { "meaningIndex": 1, "coreSenseIndex": 1 },
    { "meaningIndex": 2, "coreSenseIndex": 2 },
    { "meaningIndex": 3, "coreSenseIndex": 3 },
    { "meaningIndex": 4, "coreSenseIndex": 1, "steps": ["基础", "作为基本部分"] },
    { "meaningIndex": 5, "coreSenseIndex": 1, "steps": ["基础", "把…放在基础之上"] }
  ]
}
```

校验要点：用户截图中的 `源自希腊 basis` 必须改写为**含义 label「基础」**，词源只出现在 origin 且 `希腊 basis=基础` 含解释。

### 4.3 abstract

输入：`1. adj. 抽象的  2. adj. 深奥的  3. n. 抽象概念  4. n. 摘要；梗概  5. v. 提取；抽取  6. v. 抽象化  7. v. 转移（注意力）`

```json
{
  "headword": "abstract",
  "coreSenses": [
    { "index": 1, "label": "抽取", "gloss": "从整体中取出某一部分", "origin": "拉丁 abs+tract=抽离", "confidence": "high" },
    { "index": 2, "label": "抽象概念", "gloss": "从具体事物中概括出的观念", "origin": "抽取义=抽象概念", "confidence": "high" },
    { "index": 3, "label": "摘要", "gloss": "抽取要点形成的短文", "origin": "抽取义=摘要", "confidence": "medium" }
  ],
  "meaningMap": [
    { "meaningIndex": 1, "coreSenseIndex": 2 },
    { "meaningIndex": 2, "coreSenseIndex": 2, "steps": ["抽象概念", "难以具体理解"] },
    { "meaningIndex": 3, "coreSenseIndex": 2 },
    { "meaningIndex": 4, "coreSenseIndex": 3, "steps": ["抽取", "抽取要点", "摘要"] },
    { "meaningIndex": 5, "coreSenseIndex": 1 },
    { "meaningIndex": 6, "coreSenseIndex": 2, "steps": ["抽取", "抽取共同点", "抽象化"] },
    { "meaningIndex": 7, "coreSenseIndex": 1, "steps": ["抽取", "抽走", "转移"] }
  ]
}
```

校验要点：跨词性大类已拆分（抽取/抽象概念/摘要）；steps 只写含义演变；无检查/词源字样。

### 4.4 tunnel（用户截图同类词，补充示例）

输入：`1. n. 隧道；地道  2. v. 挖隧道；挖掘通道  3. n. （动物的）洞穴`

```json
{
  "headword": "tunnel",
  "coreSenses": [
    { "index": 1, "label": "隧道", "gloss": "在地下或山中挖出的通道", "origin": "古法语 tonel=桶", "confidence": "high" },
    { "index": 2, "label": "挖掘通道", "gloss": "开凿地下通道的动作", "confidence": "high" }
  ],
  "meaningMap": [
    { "meaningIndex": 1, "coreSenseIndex": 1 },
    { "meaningIndex": 2, "coreSenseIndex": 2, "steps": ["隧道", "开凿隧道"] },
    { "meaningIndex": 3, "coreSenseIndex": 1 }
  ]
}
```

---

## 5. 校验器规则（给 dev-data 实现）

> 建议位置：`src/data/ai/semantics.ts` 新增 `validateSemanticsV4Items()`；CLI 与 App 共用；纯函数、只依赖 zod/自包含。
> 设计原则：**能安全自动修的就修（trim/合并/去重/丢非法 steps），结构不变量（S1–S8）坏了才 return error 重试**。

### 5.1 常量

```ts
const LABEL_RE = /^[\u4e00-\u9fff]{2,6}$/
const LABEL_BLACKLIST = ['是否','看','检查','判断','确认','核对','推导','源自','源古','来自','出自','词源','词根','希腊','拉丁','英语','法语','德语','古英语','→','->','可能','大概','也许','疑似','第一步','第二步']
const STEP_BLACKLIST = ['是否','看','检查','判断','确认','核对','来源','源自','来自','出自','词源','词根','希腊','拉丁','英语','法语','德语','→','->','推导']
const DOUBLE_DE = /的[^的]{0,6}的/
const PUNCT = /[，。；：、！？"'“”‘’（）()\[\]【】<>《》\d]/
const ORIGIN_OK = /(=|＝|即|意为|意思是|指)/
const ORIGIN_BAD_PREFIX = /^(源自|来自|出自)/
```

### 5.2 单条校验流程（伪代码）

```ts
type V4Sense = { index:number; label:string; gloss:string; origin?:string; confidence:'high'|'medium'|'low' }
type V4Map   = { meaningIndex:number; coreSenseIndex:number; steps?:string[] }
type V4Item  = { headword:string; coreSenses:V4Sense[]; meaningMap:V4Map[] }

function validateOne(item: V4Item, meanings: {cn:string}[]): { item?: V4Item; errors: string[] } {
  const errors: string[] = []
  const M = meanings.length

  // 1) coreSenses 数量/index
  if (item.coreSenses.length < 1 || item.coreSenses.length > 4) errors.push('E_SENSE_COUNT')
  // index 连续 1..N（不连续则按数组顺序重排并写 warning）

  // 2) label 逐项
  for (const s of item.coreSenses) {
    const label = s.label.trim()
    if (!LABEL_RE.test(label)) errors.push(`E_LABEL_FORMAT:${label}`)
    else if (PUNCT.test(label)) errors.push(`E_LABEL_PUNCT:${label}`)
    else if (LABEL_BLACKLIST.some(w => label.includes(w))) errors.push(`E_LABEL_BANNED:${label}`)
    else if (DOUBLE_DE.test(label)) errors.push(`E_LABEL_DE:${label}`)
    // gloss
    if (!s.gloss || s.gloss.trim().length < 1 || s.gloss.trim().length > 40) errors.push(`E_GLOSS_LEN:${label}`)
    // origin
    if (s.origin) {
      const o = s.origin.trim()
      if (o.length > 20) errors.push(`E_ORIGIN_LEN:${label}`)
      else if (ORIGIN_BAD_PREFIX.test(o) || !ORIGIN_OK.test(o)) errors.push(`E_ORIGIN_NO_EXPLAIN:${label}`)
    }
    if (!['high','medium','low'].includes(s.confidence)) errors.push(`E_CONFIDENCE:${label}`)
  }

  // 3) label 去重/近义合并（§2.4）→ 重映射
  // 4) meaningMap 覆盖
  const seen = new Set<number>()
  for (const m of item.meaningMap) {
    if (m.meaningIndex < 1 || m.meaningIndex > M) errors.push(`E_MAP_RANGE:${m.meaningIndex}`)
    if (seen.has(m.meaningIndex)) errors.push(`E_MAP_DUP:${m.meaningIndex}`)
    seen.add(m.meaningIndex)
    if (!item.coreSenses.some(s => s.index === m.coreSenseIndex)) errors.push(`E_MAP_INDEX:${m.meaningIndex}`)
    if (m.steps) {
      if (m.steps.length < 2 || m.steps.length > 4) errors.push(`E_STEPS_COUNT:${m.meaningIndex}`)
      for (const st of m.steps) {
        const t = st.trim()
        if (t.length < 1 || t.length > 20) errors.push(`E_STEPS_LEN:${m.meaningIndex}`)
        else if (STEP_BLACKLIST.some(w => t.includes(w))) errors.push(`E_STEPS_BANNED:${m.meaningIndex}`)
      }
    }
  }
  for (let i = 1; i <= M; i++) if (!seen.has(i)) errors.push(`E_MAP_MISSING:${i}`)

  // 5) 孤儿本义
  for (const s of item.coreSenses) {
    if (!item.meaningMap.some(m => m.coreSenseIndex === s.index)) errors.push(`E_SENSE_UNUSED:${s.index}`)
  }

  // 6) label 与含义原文完全相等的占比（质量 warning，不阻断）
  // 若 label === meanings[i].cn.trim() 且该词所有 label 都这样 → warning E_LABEL_RESTATE
  return { item: errors.length ? undefined : fixup(item), errors }
}
```

### 5.3 错误码表（dev-data / QA 对齐用）

| 错误码 | 含义 | 是否可重试 |
|---|---|---|
| `E_SENSE_COUNT` | coreSenses 数量不在 1–4 | 是 |
| `E_LABEL_FORMAT` | label 不是 2–6 纯汉字 | 是 |
| `E_LABEL_PUNCT` | label 含标点/数字 | 是 |
| `E_LABEL_BANNED` | label 命中黑名单（检查/词源/语言名/箭头等） | 是 |
| `E_LABEL_DE` | label 「的」堆叠 | 是 |
| `E_LABEL_DUP` / `E_LABEL_SIMILAR` | 词内重复/近义拆分（已合并则 warning） | 合并即可，不改判 invalid |
| `E_GLOSS_LEN` | gloss 缺失或 >40 字 | 是 |
| `E_ORIGIN_LEN` | origin >20 字 | 是 |
| `E_ORIGIN_NO_EXPLAIN` | origin 只有来源没有含义解释（如「源自希腊 basis」） | 是 |
| `E_CONFIDENCE` | confidence 非法 | 归一 low |
| `E_STEPS_COUNT` / `E_STEPS_LEN` | steps 步数/长度不合规 | 丢 steps（warning）或重试 |
| `E_STEPS_BANNED` | steps 含检查/来源词 | 丢 steps 或重试 |
| `E_MAP_RANGE` / `E_MAP_DUP` / `E_MAP_MISSING` | meaningMap 覆盖问题 | 是 |
| `E_MAP_INDEX` | coreSenseIndex 不存在 | 是 |
| `E_SENSE_UNUSED` | 孤儿本义 | 删本义重排后继续 |

### 5.4 自动修复顺序（fixup）

1. trim 所有字符串；2. coreSenses 按 index 排序并重排为 1..N；3. 合并重复 label；4. 删除孤儿本义并重排 + 重映射；5. 丢弃非法/超长 steps（保留其余）；6. confidence 非法→`low`、gloss 缺省→`''` 并记 warning（不阻断）。
**只有 S4/S5/S6 修复后仍不满足时才判 invalid（返回 undefined 触发重试）**。

---

## 6. 与 v3 的兼容 / 迁移

1. **prompt 常量**：v4 新增 `PROMPT_VERSION_V4`、`buildSystemPromptV4()`、`buildUserPromptV4()`、`buildSemanticsRepairPromptV4()`；**v3 的导出保持不变**（`generate.ts` / CLI 当前仍调用 v3，直到 dev-engine 切换）。
2. **类型**：`types.ts` 的 `CoreSense` 现为 `{index,label,note?,origin?,confidence}`；v4 的 `gloss` 落库时映射到 `note` 即可（UI 显示语义相同）。若要类型对齐，dev-engine 可把 `note` 重命名/新增 `gloss`（需同步 `semantics.ts` 与 packs schema）。
3. **v3 已生成数据迁移**（dev-data 脚本）：
   - 按 `(headword, label.trim())` 逐字聚合（v3 每个 c 一条 label → 分组）；
   - 对每组 label 跑 §2 校验：命中黑名单（如「看是否指图纸」「源自希腊 basis」）→ **该词整体标记待重生成**（不要自动猜本义）；
   - 通过校验的词：改写为 `coreSenses:[{index,label,gloss:合并后的 coreSenseNote, origin, confidence}'}]` + `meaningMap`；
   - 迁移后统计：invalid 词数、合并组数、label 修复率，写入迁移报告。
4. **校验器**：v4 校验器为**新增**函数；v3 的 `aggregateSemanticsLabels` 保留（历史 pack 仍可读）。CLI/App 切 v4 后，`meta.promptVersion='v4.0-semantics-grouped'`。

---

## 7. 给 dev 的接入清单

- **dev-engine**：`src/data/ai/generate.ts` 的 `buildSystemPromptV3/buildUserPromptV3/buildSemanticsRepairPromptV3` 切到 `*V4`；解析从「每 c 的 coreSenseLabel 聚合」改为「直接读 grouped coreSenses/meaningMap」；promptVersion 写 v4；CLI（`tools/gen-pack-deepseek.mjs`）同步。
- **dev-data**：新增 `validateSemanticsV4Items()`（§5 规则）+ 单测（用 §4 的 plan/base/abstract/tunnel 作为 golden cases；至少覆盖：正常、黑名单 label、origin 无解释、缺映射、孤儿本义、近义 label 合并）。
- **dev-ui**：本义展示用 `label`（大、短），`gloss` 作为括注小字（≤40 字），`origin` 单独一行「词源：希腊 basis=基础」，`steps` 仅在 c 与 label 不同义时展示为链（2–4 步）。**不再把 gloss/origin 塞进本义标题的括号里**（这正是用户看到「看是否指图纸」的位置）。
- **QA**：验收标准——任一生成词：label 100% 过 `^[\u4e00-\u9fff]{2,6}$` 且无黑名单词；同本义 c 共享同一 coreSenseIndex（结构保证）；origin 100% 含 `=`/`即`/`意为`；无 S1–S8 违规。
