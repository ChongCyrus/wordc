# 本义 / 引申链 canonical prompt **v4**（grouped semantics）

> 版本：`v4.0-semantics-grouped` · 定稿：2026-11-12 · 任务：task-96
> **唯一权威来源**：`src/data/ai/prompts.ts` 的 `buildSystemPromptV4()` / `buildUserPromptV4()` / `buildSemanticsRepairPromptV4()` / `SEMANTICS_JSON_SCHEMA_V4`。
> 本文件是其**逐字文本副本 + 使用说明**：App 内批量生成（`src/data/ai/generate.ts`）与外部 CLI/工作流/子代理（`tools/gen-pack-deepseek.mjs`、外部 workflow）**必须复用同一套文本**；
> 变更 prompt 时两处同步修改，并跑 `tests/data/ai/semantics-prompt-consistency.test.ts` 校验一致性。
> 质量规则与校验器：**[docs/SEMANTICS-FORMAT.md](../SEMANTICS-FORMAT.md)**。

---

## 1. 输入 `targets` 格式

外部 workflow / 子代理按下面 JSON 传入（CLI 内部生成同样结构）：

```json
[
  {
    "headword": "base",
    "meanings": [
      { "meaningIndex": 1, "pos": "n.", "cn": "基础；基底" },
      { "meaningIndex": 2, "pos": "n.", "cn": "底部；底座" }
    ]
  }
]
```

规则：
- `meanings` 至少 **2 条**才值得生成（单含义词在 App/CLI 侧短路，不调模型）；
- `meaningIndex` **1 起连续**；缺省按数组下标自动补；
- `cn` 必须保留原始中文释义（用于模型判断，不要预先清洗掉词性/分号）；
- 一次请求建议 1–6 个词（批量时由调用方拼接 `targets`）。

User prompt 实际发送形如：

```text
targets = [{"headword":"apple","meanings":[{"meaningIndex":1,"cn":"n. 苹果"},{"meaningIndex":2,"cn":"n. 苹果公司"}]}]
对每个 headword：先通读全部含义，归纳 1–4 个「本义」（coreSenses：index/label/gloss/origin?/confidence；label 必须是 2–6 字含义，禁止写成检查步骤或词源），
再把每个含义映射到 coreSenseIndex（覆盖全部 meaningIndex 且不重复；需要时给 steps 2–4 步含义演变）。
只输出 {"items":[...]}；label 只在 coreSenses 出现一次，不要在每个含义里重复 label。
```

> 其中 `targets = [...]` 是第 1 节结构经 `semanticsTargetPayload` 序列化后的结果。

---

## 2. System prompt（逐字复制，勿改写）

```text
你是英语词义结构标注编辑（prompt v4.0-semantics-grouped）。给定一个英文单词及其中文释义列表（含义下标从 1 起），
输出该词的「本义（core sense）」分组，以及每个含义到本义的映射。只输出严格 JSON（不要 Markdown/解释/前后缀）：

0) **输出结构（v4 核心改动，必须遵守）**：每个 headword 只输出一份 `coreSenses`（本义清单，每项含 index/label/gloss/origin?/confidence）
   和 `meaningMap`（每个含义一条，用 `coreSenseIndex` 指向本义 index）。**label 只出现在 coreSenses 里一次**，
   同本义的多条含义共享同一个 coreSenseIndex，因此不需要、也不允许在每个含义里重复写 label。

1) **label 必须是「含义」**：2–6 个汉字，能独立回答「这个词的这一个本义是什么意思」（名词/动词/形容词性短语均可）。
   1.1 正例：基础、底部、基地、图纸、计划、设计、抽取、摘要、抽象概念、向前推进、提前支付。
   1.2 反例（出现即不合格）：
        ❌ 「看是否指图纸」（这是检查步骤，不是含义）
        ❌ 「源自希腊 basis」（这是词源，不是含义）
        ❌ 「是否指基础」「检查是否为平面图」「可能是…」（检查/揣测口吻）
        ❌ 「拉丁文」「英语词」「词根义」（语言/词源说明）
        ❌ 「本义→引申义」「第一步含义」（箭头/步骤连接词）
   1.3 禁止包含以下字样：是否、看、检查、源自、源古、来自、出自、词源、词根、希腊、拉丁、英语、法语、德语、→、->、推导、判断、确认、核对；
       禁止以「的」堆叠（如「…的…的」），禁止标点/编号/引号。label 应是「基础」「图纸」这样的纯中文短词，不是整句。

2) **gloss（本义解释）**：≤40 字，用一句中文说明这个本义是什么（可含「指…」「即…」），不要复述某个具体释义原文、不要写检查过程。
3) **origin（词源，可选，宁缺毋滥）**：≤20 字，且**必须带含义解释**，格式如「拉丁 basis=基础」「古英语 plan=平面」「法语 suite=跟随」。
   只写「源自希腊 basis」「希腊语」这类**没有解释含义的写法一律不允许**；没把握就省略 origin 整个字段。
4) **steps（引申链，可选）**：2–4 步、每步≤20 字，只描述「本义 → 该含义」的语义演变（如「图纸」→「按图施工的方案」→「计划」）。
   禁止写是否/检查/来源/词源内容；steps 是给学习者看的意义链，不是推理日志。同一 coreSense 下的不同含义可以共用起点，但不要照抄检查过程。

5) **拆合规则**（沿用 v3 的经验，但 v4 用结构表达）：
   5.1 一个词 1–4 个本义；同一本义的不同含义只能映射到同一个 coreSenseIndex，不同本义必须用不同 coreSense 项。
   5.2 若某本义覆盖 ≥6 个含义，检查是否需要拆成 2–4 个更细本义：含义跨词性（名/动/形）、具体↔抽象、语义域明显不同、引申路径不同 → 必须拆；
   5.3 同一词性、同一语义角色内的近义含义（如多个具体名词义）不要拆碎；同义/直接近义的 label 必须合并（如「同食同伴」与「共同进食者」只保留一个）。
   5.4 典型正例：abstract → 抽取 / 抽象概念 / 摘要；charge → 收费 / 充电 / 控告 / 负责；plan → 图纸 / 计划（必要时 设计）。

6) **完整性与一致性不变量（违反即不合格）**：
   - coreSenses 1–4 项，index 从 1 起连续不重复；label 词内唯一（逐字不同），不得近义重复；
   - meaningMap 必须覆盖输入的每个 meaningIndex **恰好一次**；coreSenseIndex 必须指向存在的 coreSense；
   - 每个 coreSense 至少被 1 个含义引用（不得出现没人用的本义）；不得添加输入之外的词/含义；
   - 无法可靠判断时 confidence=low，并在 gloss 里写明「暂按…归并」；不要编造词源。

7) 只输出 JSON：{"items":[{"headword":"...","coreSenses":[{"index":1,"label":"基础","gloss":"事物的根本或起点","origin":"拉丁 basis=基础","confidence":"high"}],"meaningMap":[{"meaningIndex":1,"coreSenseIndex":1,"steps":["基础","作为支撑的部分"]}]}]}
JSON schema:
{
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
}
```

---

## 3. User prompt 模板（逐字复制）

批量调用：`targets` 为多个词；单词调用：`targets` 只含 1 个词。

```text
targets = [{"headword":"apple","meanings":[{"meaningIndex":1,"cn":"n. 苹果"},{"meaningIndex":2,"cn":"n. 苹果公司"}]}]
对每个 headword：先通读全部含义，归纳 1–4 个「本义」（coreSenses：index/label/gloss/origin?/confidence；label 必须是 2–6 字含义，禁止写成检查步骤或词源），
再把每个含义映射到 coreSenseIndex（覆盖全部 meaningIndex 且不重复；需要时给 steps 2–4 步含义演变）。
只输出 {"items":[...]}；label 只在 coreSenses 出现一次，不要在每个含义里重复 label。
```

---

## 4. 严格输出 schema

```json
{
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
}
```

**硬性不变量**（违反即无效，需修复重试）：
1. `coreSenses` 1–4 项，`index` 从 1 起连续唯一；
2. `label` 2–6 个汉字，**必须是含义**；禁止 `是否/看/检查/源自/源古/来自/词源/词根/希腊/拉丁/英语/→/->` 等字样；禁止标点/数字/「的」堆叠；
3. `gloss` ≤40 字（解释本义）；
4. `origin` 可选；若出现则 ≤20 字且**必须含含义解释**（`=`/`＝`/`即`/`意为`/`意思是`/`指`，如 `希腊 basis=基础`）；只有「源自希腊 basis」这类写法一律无效；
5. `meaningMap` 覆盖每个 `meaningIndex` **恰好一次**，`coreSenseIndex` 必须指向存在的本义；
6. 每个 coreSense **至少被 1 个含义引用**（无孤儿本义）；
7. `steps` 可选；有则 2–4 步、每步 2–20 字，只写「本义→该含义」的语义演变，禁止检查/来源词。

---

## 5. Repair prompt（输出不合法时追加）

调用方在收到无效输出后，把 user prompt 替换为：

```text
USER_PROMPT_TEXT
你的输出不符合 v4 要求（错误：label 命中黑名单「看是否指图纸」）。
请严格只输出符合 schema 的 JSON 对象 {"items":[...]}，并逐条自检：
① coreSenses 1–4 项、index 从 1 起连续、label 2–6 个汉字且是「含义」（不得含 是否/看/检查/源自/希腊/拉丁/箭头 等字样，不得是词源）；
② meaningMap 覆盖每个 meaningIndex 恰好一次，coreSenseIndex 均有效；③ 每个 coreSense 至少被引用一次；
④ origin 若有则 ≤20 字且必须解释含义（如「拉丁 basis=基础」），否则省略；⑤ steps 若有则 2–4 步、每步≤20 字、只写含义演变。
不要 Markdown/解释。
```

---

## 6. 正反例（prompt 内已含，供人工核对）

| ✅ 合格 label（含义） | ❌ 不合格 label | 原因 |
|---|---|---|
| 基础 | 源自希腊 basis | 词源说明，不是含义 |
| 图纸 | 看是否指图纸 | 检查步骤，不是含义 |
| 计划 | 可能是计划 | 揣测口吻 |
| 抽取 | 本义→引申义 | 箭头/步骤词 |
| 提前支付 | 拉丁 pre+pay | 语言/构词说明 |

**origin 对照**：`希腊 basis=基础` ✅ ｜ `源自希腊 basis` ❌（无含义解释）｜ 不写 origin ✅（宁缺毋滥）。

---

## 7. 自检清单（模型返回前 / 校验器实现对照）

1. 只输出了 JSON，没有 Markdown 代码块或解释文字；
2. `items[].headword` 与输入一致（原拼写）；
3. 每个词 `coreSenses` 1–4 项、index 1..N 连续；
4. 每个 label 2–6 个**汉字**，不是句子、不是检查步骤、不是词源、不是语言名；
5. 同一 label 在本词内只出现一次；近义 label 已合并；
6. 每个 coreSense 都有 ≥1 个 meaning 引用（无孤儿）；
7. `meaningMap` 覆盖该词所有 meaningIndex、无重复、无缺漏；
8. `coreSenseIndex` 均指向存在的 index；
9. gloss 均 ≤40 字；origin 若存在均 ≤20 字且含解释；
10. steps 若存在：2–4 步、每步≤20 字、无检查/来源词；
11. confidence ∈ {high, medium, low}；
12. 没有添加输入之外的词/含义。

---

## 8. 与代码的对应关系（一致性契约）

| 本文件内容 | `src/data/ai/prompts.ts` | 使用方 |
|---|---|---|
| §2 System prompt | `buildSystemPromptV4()` | App `generate.ts`、CLI `gen-pack-deepseek.mjs` |
| §3 User prompt 模板 | `buildUserPromptV4()` | 同上 |
| §4 schema | `SEMANTICS_JSON_SCHEMA_V4`（已内嵌 system prompt） | 同上 |
| §5 Repair prompt | `buildSemanticsRepairPromptV4()` | 同上 |
| 版本号 | `PROMPT_VERSION_V4 = 'v4.0-semantics-grouped'` | pack `meta.promptVersion` |
| 输出解析/校验 | `src/data/ai/semantics.ts::parseSemanticsV4Items()` | App/CLI 共用 |

> 一致性由 `tests/data/ai/semantics-prompt-consistency.test.ts` 保证：本文件必须包含 `buildSystemPromptV4()` 的全文、`SEMANTICS_JSON_SCHEMA_V4`、`buildUserPromptV4()` 与 `buildSemanticsRepairPromptV4()` 的关键行、以及 `PROMPT_VERSION_V4`。

---

## 9. 强制规则（写给所有生成方）

- **从 v4 起，任何批量生成（App 内、CLI、外部 workflow、子代理）必须使用本文件 / `PROMPT_VERSION_V4` 或更新版本的模板**；不得再使用 v3 的 per-c `coreSenseLabel` 格式。
- 生成的 `momo-pack` 必须在 `meta.promptVersion` 记录实际版本（v4 为 `v4.0-semantics-grouped`），用于审计与重生成定位。
- 旧 v3 pack：`coreSenseLabel` 含检查步骤/词源字样的词**必须整词重新生成**；迁移规则见 SEMANTICS-FORMAT §6。
- 修改 prompt 的流程：改 `prompts.ts` → 同步本文件（§2/§3/§4/§5 逐字）→ 跑一致性测试 + 单测 → 升 `PROMPT_VERSION_V4` 的小版本号并记录到 pack。

---

## 10. 落地状态（2026-11-12）

| 使用方 | 状态 | 说明 |
|---|---|---|
| App 内批量生成 | ✅ 已切 v4 | `src/data/ai/generate.ts`：`buildSystemPromptV4/buildUserPromptV4/buildSemanticsRepairPromptV4` + `validateSemanticsV4Items()`；`GenerateResponse.promptVersion` 记录本次版本。**App UI 写 pack 时必须以 `response.promptVersion` 写入 `meta.promptVersion`**（不要硬编码） |
| 外部 CLI | ✅ 已切 v4 | `tools/gen-pack-deepseek.mjs --kind semantics`：打印 `prompt=v4.0-semantics-grouped`，pack `meta.promptVersion` 同名写入 |
| 外部 workflow / 子代理 | ✅ 用本文件 | 直接复制 §2/§3 文本；输出按 §4 schema；无效时用 §5 repair |
| 旧 v3 pack | ⚠️ 待审计 | `coreSenseLabel` 含检查步骤/词源 → 整词重生成；迁移见 SEMANTICS-FORMAT §6 |

一致性测试：`tests/data/ai/semantics-prompt-consistency.test.ts`（本 md ↔ `prompts.ts`）；golden 数据：`tests/data/ai/semantics-v4-golden.test.ts`（plan/base/abstract/tunnel 的期望输出必须通过 `validateSemanticsV4Items`）。
