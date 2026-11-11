# 导入你自己的词库（公开版 / 自定义词表）

> 公开版只内置**可合法分发**的「2027 考研英语大纲词汇」。受限商业词表等版权受限词表不随仓分发；
> 如果你已经拥有某份词表（自己的MaiMemo导出、课程资料、CSV……），可以转成 deck JSON 后导入，**仅在你自己的设备上使用**。

## 1. 准备你的单词文件

支持以下格式（脚本自动识别）：

| 格式 | 示例 |
|---|---|
| JSON 数组 / `{ "words": [...] }` | `[{"word":"apple","meaning":"n. 苹果"}, …]` |
| 本仓库 deck/迁移包 JSON | `format: momo-deck` 或迁移包（直接透传） |
| CSV（首行表头） | `word,meaning` 两列，或兼容 `headword/term/spelling`、`translation/meanings` |
| TXT / TSV | 每行 `headword<TAB>释义`（也支持两个以上空格分隔） |

**不要**把受限词表提交进仓库；本仓库不包含任何受限样例。

## 2. 生成 deck JSON

```bash
node tools/make-deck-from-export.mjs \
  --in 我的单词.json \
  --out 我的词库.deck.json \
  --name "我的词库"
```

- 同 headword（忽略大小写）会自动去重；
- 释义按换行 / `；` / `;` 拆成多个含义；
- 输出是 App 可直接解析的 `momo-deck`（formatVersion 1）文件。

## 3. 在 App 里导入

App → **词库** → **导入词库** → 选择上一步生成的 `*.deck.json` → 导入完成后「设为在学」即可。
导入只写本机 IndexedDB；不会上传到任何服务器。

## 4. 常见问题

- **公开版为什么没有受限商业词表？** 受限商业词表词表的再分发受版权限制，公开版只带大纲词库；
  你仍可以在自己设备上导入自己合法持有的词表。
- **能从旧版（私版）迁移过来吗？** 可以：私版「导出迁移包」→ 公开版「导入迁移包」，
  你的词库/学习进度/计划都会保留（迁移包只包含你自己的数据）。
- **覆盖会重复吗？** 同一 deck id 重复导入会覆盖同 id 词条；不同文件名生成不同 deck id，可并存。

## 5. 开发者备注

- 脚本入口：`tools/make-deck-from-export.mjs`（纯 Node ≥18，无第三方依赖）；
- 词条 id 规则与 App 一致：`<deckId>:<normalizedHeadword>`；
- 生成的 deck 走 `parseDeckFile()` 校验（zod schema，见 `src/data/schema.ts`）；
- 完整字段规范（`momo-deck` v1 / `momo-migration` v1、进度字段、checksum）见 [`docs/DATA-FORMAT.md`](DATA-FORMAT.md)。
