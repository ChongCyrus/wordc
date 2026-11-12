# 数据格式规范（词库 / 迁移包）

> **声明**：本格式由**本项目（WordC · 词到义）自行定义**，**不是**任何官方格式，与「墨墨背单词」官方无隶属关系。
> 可执行的事实来源是 `src/data/schema.ts`（zod schema）与 `src/data/checksum.ts`；本文与代码冲突时**以代码为准**。
> 当前格式版本：`formatVersion = 1`（`dataVersion = 1`）；后续只做**向后兼容的可选字段新增**。

## 0. 通用约定

| 项 | 规则 |
|---|---|
| 时间 | epoch 毫秒（`Date.now()`），本地日期键用 `YYYY-MM-DD` |
| 词库 id | 任意非空字符串，同一导入文件内唯一（例：`example-deck`） |
| 词条 id | **`${deckId}:${小写规范化 headword}`**（例：`example-deck:apple`；规范化见 `src/core/ids.ts`） |
| 含义 id | **`${wordId}#M${从 1 开始的序号}`**（例：`example-deck:apple#M1`） |
| 编码 | UTF-8（无 BOM）；JSON 顶层对象 |
| 导入识别 | 顶层 `format`：`momo-deck` = 词库；`momo-migration` = 迁移包（含学习进度） |

## 1. 词库格式 `momo-deck` v1

用于**只分享词表**（不含学习状态）；App「词库 → 导出」与 `tools/make-deck-from-export.mjs` 输出此格式。

### 1.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | `"momo-deck"` | ✅ | 固定字面量 |
| `formatVersion` | `1` | ✅ | 当前固定 1 |
| `exportedAt` | number | ✅ | 导出/生成时间（ms） |
| `generator` | string | ✅ | 生成器标识（例：`wordc@0.3.3`） |
| `deck` | object | ✅ | 词库元数据（见 1.2） |
| `words` | array | ✅ | 词条数组（见 1.3），至少 1 条 |
| `meta` | object | 否 | `wordCount` / `license` / `sourceUrl` / `copyrightNotice`（导出时保留许可信息） |

### 1.2 `deck` 字段

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 词库 id |
| `name` | string | ✅ | 显示名 |
| `description` | string | 否 | 简介 |
| `source` | `builtin`\|`imported`\|`custom`\|`maimemo` | 默认 `imported` | 来源（**自定义导入用 `imported`**） |
| `builtinKey` | `hongbaoshu-2025`\|`kaoyan-2027-dagang` | 否 | 仅内置词库使用；自定义词库不要填 |
| `wordCount` | number | 默认 0 | 词条数（导出时会重算） |
| `version` | number | 默认 1 | 词库内容版本 |
| `license` | string | 否 | 词库数据许可说明（强烈建议填写） |
| `isDefault` | boolean | 否 | 是否为「在学」词库 |
| `createdAt` / `updatedAt` | number | 默认 0 | ms |

### 1.3 `words[]` 词条字段

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `id` | string | 自动 | 缺省时按 `${deckId}:${headwordLower}` 生成 |
| `deckId` | string | 自动 | 缺省时取外层 `deck.id` |
| `headword` | string | ✅（或旧字段 `term`） | 原拼写 |
| `headwordLower` | string | 自动 | 小写规范化形式 |
| `phonetic` | string \| `{uk?,us?}` | 否 | 音标 |
| `meanings` | array | 自动 | `[{ id?, pos?, cn, examples? }]`；`cn` 必填 |
| `examples` | array | 默认 [] | `[{ en, cn?, source? }]` |
| `mnemonics` | array | 默认 [] | `[{ type, text }]` |
| `phrases` | array | 默认 [] | `[{ en, cn, meaningId? }]`；`meaningId` 可选（无归属=词级） |
| `tags` | string[] | 默认 [] | 标签 |
| `order` | number | 自动 | 词库内顺序（1 起） |
| `difficulty` | number | 否 | 单词难度 1–10（公开难度数据；缺失按默认值处理） |
| `frequency` / `cefr` / `examCount` / `chapter` | number/string | 否 | 词频 / CEFR / 真题次数 / 章节 |
| `maimemoVocId` | string | 否 | 仅本机参考，可省略 |
| `createdAt` | number | 自动 | ms |

> 旧格式兼容：词条可用 `term` 代替 `headword`、`meaning`/`example`/`exampleTranslation` 等扁平字段；导入时自动规范化。

### 1.4 最小示例（脱敏虚构，可直接导入）

```json
{
  "format": "momo-deck",
  "formatVersion": 1,
  "exportedAt": 1762790400000,
  "generator": "wordc@0.3.3",
  "deck": {
    "id": "example-deck",
    "name": "示例词库",
    "description": "最小示例（虚构数据）",
    "source": "imported",
    "wordCount": 2,
    "version": 1,
    "license": "示例数据，仅用于格式说明",
    "createdAt": 1762790400000,
    "updatedAt": 1762790400000
  },
  "words": [
    {
      "id": "example-deck:apple",
      "deckId": "example-deck",
      "headword": "apple",
      "headwordLower": "apple",
      "phonetic": { "uk": "[ˈæpl]", "us": "[ˈæpl]" },
      "meanings": [
        { "id": "example-deck:apple#M1", "pos": "n.", "cn": "苹果" }
      ],
      "examples": [
        { "en": "She ate an apple.", "cn": "她吃了一个苹果。" }
      ],
      "mnemonics": [],
      "phrases": [],
      "tags": ["示例"],
      "order": 1,
      "createdAt": 1762790400000
    },
    {
      "id": "example-deck:banana",
      "deckId": "example-deck",
      "headword": "banana",
      "headwordLower": "banana",
      "meanings": [
        { "id": "example-deck:banana#M1", "pos": "n.", "cn": "香蕉" }
      ],
      "examples": [],
      "mnemonics": [],
      "phrases": [],
      "tags": ["示例"],
      "order": 2,
      "createdAt": 1762790400000
    }
  ],
  "meta": {
    "wordCount": 2,
    "license": "示例数据，仅用于格式说明"
  }
}
```

## 2. 迁移包格式 `momo-migration` v1

用于**备份 / 换机 / 跨设备迁移**：含词库 + 学习状态 + 设置 +（可选）今日计划。

### 2.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | `"momo-migration"` | ✅ | 固定字面量 |
| `formatVersion` | `1` | ✅ | 当前固定 1 |
| `dataVersion` | `1` | ✅ | 载荷版本（schema 版本） |
| `exportedAt` | number | ✅ | 导出时间 |
| `generator` | string | ✅ | 生成器标识 |
| `appVersion` | string | ✅ | 导出时 App 版本 |
| `counts` | object | ✅ | `{decks,words,states,reviewLogs,plans?}` 计数（应与 `data` 一致；`plans` 为可选） |
| `data` | object | ✅ | 见 2.2 |
| `checksum` | string | ✅ | 见 §3 |
| `meta` | object | 否 | `{ checksumAlgo?: "sha256" \| "fnv1a64" }` |

### 2.2 `data` 段落

| 字段 | 类型 | 说明 |
|---|---|---|
| `decks` | `Deck[]` | 同 §1.2 |
| `words` | `Word[]` | 同 §1.3 |
| `states` | `WordState[]` | 学习状态（见 2.3） |
| `reviewLogs` | `ReviewLog[]` | 复习日志；导出默认最多最近 **20000** 条 |
| `settings` | `SettingRecord[]` | `[{key,value,updatedAt}]`；**不含 `data.maimemoToken`** |
| `plans` | `DailyPlan[]` | **可选**（v2）；只含导出当天计划，最多 2 条；旧包缺省 |

### 2.3 进度字段：`WordState`

| 字段 | 类型 | 说明 |
|---|---|---|
| `wordId` / `deckId` | string | 主键 / 所属词库 |
| `phase` | `new`\|`learning`\|`review`\|`lapsed`\|`mastered`\|`suspended` | 学习阶段 |
| `stability` | number | 记忆半衰期 h（天） |
| `difficulty` | number | 单词难度 d（1–18） |
| `reps` / `lapses` | number | 连续成功次数 / 遗忘累计次数 |
| `firstSeenAt` / `lastReviewedAt` | number\|null | 首次学习 / 上次复习时间 |
| `dueAt` | number\|null | 下次到期（本地日期 00:00 的 ms；未学为 null） |
| `nextIntervalDays` | number | 当前间隔（1–365 天，对外=「记忆持久度」） |
| `retrievability` | number | 上次结算时回忆概率快照（0–1） |
| `lastRating` | `familiar`\|`vague`\|`forgot`\|null | 最近评分 |
| `sameDayCount` / `sameDayDate` / `sameDayRequeued` | number/string | 同日回炉/计数（跨天自动归零） |
| `meaningStats` | `Record<meaningId,{clicks,encounters}>` | 各含义不熟悉度（clicks/encounters） |
| `todayProgress` / `todayProgressDate` | number/string | 可选：当日进度 0–1（v1 模型/兼容） |
| `todayProgressLevel` | number | 可选：v2 档位 1–5（缺失按评分回退） |
| `canFinishToday` | boolean | 可选：v2 完成标志（缺失按规则派生） |
| `importedFrom` / `importedAt` | `maimemo`\|`backup` / number | 可选：导入来源 |
| `createdAt` / `updatedAt` | number | ms |

### 2.4 进度字段：`ReviewLog`

`wordId`、`deckId`、`rating`（三档）、`reviewedAt`、`stabilityBefore`、`difficultyBefore`、`stabilityAfter`、`difficultyAfter`、`elapsedDays`、`nextIntervalDays`、`retrievabilityAtReview`（可 null）、`longTermUpdate`（bool）、`durationMs?`；
可选回退/改判字段：`stateBefore?`（WordState 快照）、`corrected?`、`correctedBy?`（`reverted?` 为兼容别名）。

### 2.5 进度字段：`DailyPlan`（可选）

`id`、`date`（YYYY-MM-DD）、`deckId`、`wordIds[]`、`index`、`sources`（`goal`/`extra`/`requeue`）、`goals{dailyGoal,dueCount,newBudget,extraCount}`、`ratings[{wordId,rating,reviewedAt,longTermUpdate,corrected?,correctedBy?}]`、`wcCounts?`、`createdAt`、`updatedAt`、`completedAt|null`。

### 2.6 最小迁移包示例（`46378cd8f81bc8e78b5fc99a0be73f783b3038acfe9713d0c4294626321e91fe` 处为真实 SHA-256）

```json
{
  "format": "momo-migration",
  "formatVersion": 1,
  "dataVersion": 1,
  "exportedAt": 1762790400000,
  "generator": "wordc@0.3.3",
  "appVersion": "0.3.3",
  "counts": { "decks": 1, "words": 1, "states": 1, "reviewLogs": 1 },
  "data": {
    "decks": [
      {
        "id": "example-deck",
        "name": "示例词库",
        "source": "imported",
        "wordCount": 1,
        "version": 1,
        "createdAt": 1762790400000,
        "updatedAt": 1762790400000
      }
    ],
    "words": [
      {
        "id": "example-deck:apple",
        "deckId": "example-deck",
        "headword": "apple",
        "headwordLower": "apple",
        "meanings": [{ "id": "example-deck:apple#M1", "pos": "n.", "cn": "苹果" }],
        "examples": [],
        "mnemonics": [],
        "phrases": [],
        "tags": [],
        "order": 1,
        "createdAt": 1762790400000
      }
    ],
    "states": [
      {
        "wordId": "example-deck:apple",
        "deckId": "example-deck",
        "phase": "review",
        "stability": 3.2,
        "difficulty": 5,
        "reps": 2,
        "lapses": 0,
        "firstSeenAt": 1762704000000,
        "lastReviewedAt": 1762790400000,
        "dueAt": 1762876800000,
        "nextIntervalDays": 3,
        "retrievability": 0.9,
        "lastRating": "familiar",
        "sameDayCount": 1,
        "sameDayDate": "2026-11-10",
        "meaningStats": { "example-deck:apple#M1": { "clicks": 1, "encounters": 3 } },
        "sameDayRequeued": 0,
        "todayProgress": 1,
        "todayProgressDate": "2026-11-10",
        "createdAt": 1762704000000,
        "updatedAt": 1762790400000
      }
    ],
    "reviewLogs": [
      {
        "wordId": "example-deck:apple",
        "deckId": "example-deck",
        "rating": "familiar",
        "reviewedAt": 1762790400000,
        "stabilityBefore": 1.8,
        "difficultyBefore": 5,
        "stabilityAfter": 3.2,
        "difficultyAfter": 5,
        "elapsedDays": 1,
        "nextIntervalDays": 3,
        "retrievabilityAtReview": 0.9,
        "longTermUpdate": true
      }
    ],
    "settings": [
      { "key": "study.dailyGoal", "value": 30, "updatedAt": 1762790400000 }
    ]
  },
  "checksum": "46378cd8f81bc8e78b5fc99a0be73f783b3038acfe9713d0c4294626321e91fe",
  "meta": { "checksumAlgo": "sha256" }
}
```

## 3. checksum 算法

```
canonical = stableStringify({ format, formatVersion, dataVersion, data })
checksum  = sha256(canonical) 的小写 hex（64 位）
```

- `stableStringify`：对象 key **递归排序**、数组保持顺序、无空白、字符串按 JSON 转义、`undefined` 对象字段忽略（数组中的 `undefined` → `null`）；
- 非安全上下文（`crypto.subtle` 不可用，如局域网 http 的 PWA）降级为 **FNV-1a 64 位**（16 位小写 hex），并在 `meta.checksumAlgo` 标为 `fnv1a64`；
- 校验时 **SHA-256 与 FNV-1a 都尝试**，任一匹配即通过（跨端导出可互导）。

### 3.1 导入校验顺序（失败行为）

1. `format` / `formatVersion` / `dataVersion`（版本不支持 → `E_VERSION`，中止）；
2. `checksum`（不符默认**拒绝导入**；UI 可「仍要导入（风险）」`force: true`）；
3. 字段校验（zod schema → `E_FIELD`，含 `path`/`row`，中止写库）；
4. id 规则校验 → **事务写库**（`decks + words + states + reviewLogs + plans`）。

## 4. 版本兼容

- `formatVersion` 当前 **1**；v2 只新增**可选字段**，不改变既有字段语义：`counts.plans?`、`data.plans?`、
  `meta.checksumAlgo?`、`WordState.todayProgressLevel?/canFinishToday?`、`ReviewLog.stateBefore?/corrected?/correctedBy?`；
- 旧包（缺这些字段）导入时按缺省处理（plans=0、todayProgress=0、不可撤销等）；
- **降级不支持**：旧版本 App 打开 `formatVersion > 1` 会报版本不支持（请先导出再升级）；
- 跨设备迁移：同一 keystore/浏览器数据无需特殊处理；迁移包只含你自己的数据。

## 5. 隐私

- 迁移包**不含 `data.maimemoToken`**（导出时过滤）；也不含任何账号密码/代理密钥；
- `plans` 只含导出当天的计划；`reviewLogs` 默认最多 50000 条（可在导出选项调整）；
- 所有数据仅保存在本机 IndexedDB；导入/导出都不经过网络。

## 6. CSV / TXT 输入

除 JSON 外，`tools/make-deck-from-export.mjs` 还支持 CSV / TSV / TXT（`word,meaning`、`headword<TAB>释义` 等），
用法与示例见 [`docs/IMPORT-YOUR-DECK.md`](IMPORT-YOUR-DECK.md)。

## 7. 示例校验

本文档中的 2 个 JSON 示例由单元测试 `tests/data/docs-format-example.test.ts` 用 `src/data/schema.ts` 实际解析，
并校验迁移包 checksum，防止文档与代码漂移。

## 8. 内容包格式 `momo-pack` v1（AI 生成内容，task-70）

> 用途：用户用 AI 生成的例句/词组/助记为「内容包」，**先审核 ✓ 再合并进词库**；也可手工/导入产生。
> 与 `momo-deck`/`momo-migration` 一样是本项目自定义格式，与官方无隶属关系。
> 本章是**公开版**说明；实现以 `src/data/schema.ts`（后续 M1 提供）与 `src/data/checksum.ts` 为准。

### 8.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | `"momo-pack"` | ✅ | 固定字面量 |
| `formatVersion` | `1` | ✅ | 当前固定 1 |
| `kind` | `"examples"`\|`"phrases"`\|`"mnemonics"`\|`"mixed"` | ✅ | 内容类型；`mixed` 允许条目内混合 |
| `createdAt` | number | ✅ | 生成/导出时间（ms） |
| `generator` | string | ✅ | 生成器标识（如 `wordc-ai@0.4.0`） |
| `items` | array | ✅ | 条目数组（单文件建议 ≤50000 条，超出分片） |
| `checksum` | string | ✅ | 见 §8.4 |
| `meta` | object | 否 | `name/description/source`（`ai`\|`manual`\|`import`）/`provider`/`model`/`promptVersion`/`scope`/`createdBy`/`licenseNote` |

### 8.2 条目定位（不依赖 deckId/voc_id，可跨词库复用）

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `headword` | string | ✅ | 原拼写（展示用） |
| `headwordLower` | string | 自动 | 缺省 = 规范化小写（`normalizeHeadword`，与 `Word.headwordLower` 同规则） |
| `meaningIndex` | number | 否 | **1 起**，对应 `Word.meanings` 数组下标；省略 = 词级 |
| `examples` | array | 否 | `[{ en, cn }]`（`kind=examples/mixed`） |
| `phrases` | array | 否 | `[{ en, cn, meaningIndex? }]`（`kind=phrases/mixed`；短语级可覆盖条目级含义） |
| `mnemonics` | array | 否 | `[{ type: 'root'\|'assoc'\|'story', text }]`（`kind=mnemonics/mixed`） |

- 定位优先级：`phrases[].meaningIndex` > 条目 `meaningIndex` > 词级（无含义绑定）。
- 同一 `headwordLower` 允许多个条目（不同 `meaningIndex`）；**同 headword+meaningIndex 只允许一条**。
- `meaningIndex` 越界（超出该词含义数）→ 导入时丢弃该条目并在报告中 warning。

### 8.3 合并策略：**只补缺、不覆盖**（v1）

- AI 生成内容只用于**补充**缺失的例句/词组/助记；已有内容**不覆盖**（用户手动编辑/官方词库内容优先）。
- 合并上限：`Word.examples ≤ 8`、`Word.phrases ≤ 8`、`Word.mnemonics ≤ 4`（含义级例句 ≤ 4）；
  超出上限的条目**跳过并在导入报告标记**（不静默丢弃）。
- 合并前必须人工审核（✓/❌）；❌ 的 target 记入本机 `meta: ai.rejected`，后续生成默认排除。

### 8.4 checksum 算法

```
canonical = stableStringify({ format, formatVersion, kind, items })
checksum  = sha256(canonical)           // 小写 hex
```
- `stableStringify`：对象 key 递归排序、数组保持顺序、无空白（同迁移包，见 §3）。
- 非安全上下文（`crypto.subtle` 不可用）可降级 FNV-1a 64 位，并在 `meta.checksumAlgo` 标注；
  导入/导出应同时兼容两种算法（见 §3）。

### 8.5 隐私

- **不含任何 API Key / Token**（AI Key 只存本机 settings，不导出、不写日志）。
- AI 生成内容仅供个人学习使用；`meta.licenseNote` 记录来源提示，分享前请自行确认。

### 8.6 示例（checksum 可复现）

```json
{
  "format": "momo-pack",
  "formatVersion": 1,
  "kind": "examples",
  "createdAt": 1762790400000,
  "generator": "wordc-ai@0.4.0",
  "items": [
    {
      "headword": "embrace",
      "headwordLower": "embrace",
      "meaningIndex": 1,
      "examples": [
        { "en": "She gave him a warm embrace.", "cn": "她给了他一个温暖的拥抱。" }
      ]
    },
    {
      "headword": "dog",
      "headwordLower": "dog",
      "examples": [
        { "en": "The dog barked at the stranger.", "cn": "那只狗对着陌生人叫。" }
      ]
    }
  ],
  "checksum": "510eb82c490b65bd6df9133ca0a0e9a67f83c2b9c972765f1d627c46093b3459",
  "meta": {
    "name": "示例内容包",
    "source": "ai",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "promptVersion": "v1",
    "createdBy": "WordC",
    "licenseNote": "AI 生成内容，仅供个人学习使用"
  }
}
```
