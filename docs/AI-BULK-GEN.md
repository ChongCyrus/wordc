# AI 批量生成内容包（tools/gen-pack-deepseek.mjs）

> 用途：用 DeepSeek 为整词库/指定范围**预生成**例句/词组/助记，产出 `momo-pack v1` 文件；之后在 App「导入内容包」里逐条 ✓/❌ 审核，点 ✓ 才落库。
> 与 App 内生成**共用同一 prompt/校验契约**（直接 import `src/data/ai/prompts.ts`）。

## 1. 前置

- Node **≥22.18 / 24**（直接运行 `.ts` 的 type stripping；旧版加 `--experimental-strip-types`）；
- DeepSeek Key：`export DEEPSEEK_API_KEY=sk-...`，或放在 `.secrets/deepseek-key`（600，git 忽略）；**脚本不会打印 Key**；
- 词库文件：`src/data/builtin/<deck>.deck.json`（紧凑列式，公开仓自带大纲）。

## 2. 用法

```bash
# 干跑（不耗 API，估算请求数）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kinds examples,phrases,mnemonics \
  --limit 200 --dry-run

# 200 词试水
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kinds examples,phrases,mnemonics \
  --limit 200 --out /tmp/wordc-200.pack.json

# 分片（如 12 片，断点续传：已有 items 的 headword 跳过）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kinds examples,phrases,mnemonics \
  --shard 3/12 --out packs/pregen/wordc-dagang-003.pack.json --resume
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--deck` | `kaoyan-2027-dagang` | 内置词库 id（读 `src/data/builtin/<deck>.deck.json`） |
| `--kinds` | `examples,phrases,mnemonics` | 可只生成某类；单 kind 时 pack.kind=该 kind，多 kind 为 `mixed` |
| `--limit` / `--offset` | 0 / 0 | 取词范围（按 `order`） |
| `--shard i/n` | — | 在 limit/offset 之后再分片 |
| `--out` | `packs/pregen/wordc-dagang.pack.json` | 输出 pack 路径 |
| `--resume` | off | 读取已有 out，跳过已生成 headword |
| `--batch` | 20 | 每请求词数（≤50） |
| `--concurrency` | 3 | 并发请求数 |
| `--max-cost` | 40 | 元；超限停止（已生成保留） |
| `--model` / `--base-url` | `deepseek-chat` / `https://api.deepseek.com` | 可换 OpenAI 兼容端点 |

## 3. 生成/校验行为

- prompt：system/user 来自 `src/data/ai/prompts.ts`（`PROMPT_VERSION='v1'`），要求严格 JSON；
- 解析：去 code fence → JSON → 只保留输入词 → 字段/条数校验（examples≤2、phrases≤3、mnemonics≤1/批）；
- 失败重试：JSON 格式错误 → repair prompt 重试 1 次；429 → 1s/2s/4s 退避；5xx → 重试 2 次；401/402 直接中止；
- 成本：按 `usage.prompt_tokens/completion_tokens` × 单价（¥2/¥8 每百万 tokens）累计，写入 `meta.stats.costYuan`；
- 输出 `momo-pack v1`：`items` 以 `headwordLower` 定位（examples 词级；phrases 可带 `meaningIndex`；mnemonics 词级）；checksum=`sha256(stableStringify({format,formatVersion,kind,items}))`；
- `meta`：`provider=deepseek`、`model`、`promptVersion`、`createdAt`、`scope`、`stats`；**不含 Key**。

## 3.5 w-c 级模式（`--per-meaning`，prompt v2.1）

对「每个含义」独立生成（而非每个词一份内容），适合 w-c 学习页按含义展示：

```bash
# 20 词自检（只取多含义内容词，排除虚词）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --per-meaning   --min-meanings 2 --limit-words 20 \
  --exclude-words "the,be,a,to,for,on,as,by,not,from,of,and,or,at,with,in,is,are,was,were" \
  --out /tmp/wordc-wc-check20.pack.json

# 全量 12 片（每片约 461 词 / 599 c；断点续传）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --per-meaning \
  --shard 3/12 --out /tmp/wordc-pack-wc-full/wordc-dagang-wc-003.pack.json --resume --max-cost 25
```

- 含义拆分：`words[i][2]` 按 `、/；/;` 拆（`--min-meanings` 可只取多含义词；`--exclude-words` 过滤虚词）；
- prompt v2.1：每个 c 必须对应 `meaning.cn` 原文；**近义 c 必须区分，无法区分输出 `skipped:true`**（不编重复内容）；同词不同 c 的例句/词组去重；
- 输出 pack：`kind=mixed`，条目带 `meaningIndex`（1 起）；CLI 额外校验：
  - `meaningIndex` 必须在 1..N 且属于输入 c；
  - 例句/词组中至少一条包含目标词（原形/变形），否则该 c 记 `skipped`；
- `meta.stats` 记录 `words/meanings/skippedMeanings/failedBatches/missingMeanings/tokens/costYuan`；
- 合并分片：`node tools/merge-packs.mjs --out /tmp/wordc-pack-wc-full/wordc-2027-dagang-wc-full.pack.json /tmp/wordc-pack-wc-full/wordc-dagang-wc-*.pack.json`；
- 小样实测（2026-11-11）：10+10 词两组各 22 c，0 失败/0 串 c，约 ¥0.023/组；20 词 42 c 自检 ¥0.051、15.7s。

## 3.6 本义/引申链（`--kind semantics`，prompt v3）

只对**多含义词（≥2 c）**生成「每个 c 源于是哪个本义」；格式为 `momo-pack v1` 可选字段扩展（`kind='semantics'`）。

```bash
# 规模自检（不调模型）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kind semantics --dry-run
# → 当前大纲：1317 个多含义词 / 2715 个 c

# 20 词小样（排除虚词；可指定实词）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kind semantics \
  --min-meanings 2 --limit-words 20 --exclude-words "the,be,a,to,for,on,..." \
  --out /tmp/wordc-semantics-sample20.pack.json

# 指定词（如 company/make/sheet/well）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kind semantics \
  --include-words company,make,sheet,well --out /tmp/wordc-semantics-extra4.pack.json

# 全量（分片 + 断点续传 + 预算）
node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kind semantics \
  --shard 3/12 --out /tmp/wordc-pack-sem/wordc-sem-003.pack.json --resume --max-cost 15
```

- prompt v3（`v3-semantics`）：`coreSenses` 1–3（index 唯一、label/origin/note/confidence）、`meaningMap` 覆盖该词全部 c（meaningIndex 不重复、coreSenseIndex 指向 coreSenses）；
- CLI 额外校验：coreSenses 非空/index 唯一、meaningMap 覆盖 1..N、coreSenseIndex 有效；不完整则重试/计 invalid，不落不完整条目；
- 产物每词一条 item：`{headword, headwordLower, coreSenses, meaningMap}`；`meta.promptVersion='v3-semantics'`，`meta.stats` 记录 words/coveredWords/coreSenses/mappedMeanings/invalidItems/cost；
- 小样实测（v3.5 定稿，2026-11-11）：20 个实词 / 42 c，**映射 42/42、0 失败/0 invalid**；**同本义多 c 组 14、maxGroupSize 3、label 逐字一致 14/14=100%**；**steps 覆盖非首义 c 100%**（61 条）；coreSenses 27、multi-core 6/20（AI 自然拆合，不硬拆）；confidence high 22/medium 5/low 0；**¥0.0227 / 6.6s**；company/make/sheet/well 补充 4 词 ¥0.0068；
- 全量预估：1317 词 / 2715 c，约 **¥1.5–2.5、5–8 分钟**（以 `--max-cost 15` 兜底）。

## 4. 费用参考

| 范围 | 请求数（20词/批） | tokens(入/出) 实测/估算 | 费用 |
|---|---|---|---|
| 200 词 × 三类（实测） | 30 | 32,411 / 33,560 | **≈¥0.33**（约 60s） |
| 5528 词 × 三类（估算） | 828 | ≈0.9M / 0.93M | **≈¥12–35**（含重试；reasoner 约 2–4×） |
| 每 500 词分片 | 75 | ≈80k / 85k | **≈¥1.5–3** |

> 价格以 DeepSeek 官网为准；可用 `--max-cost` 兜底。

## 5. 安全/隐私

- Key 只从 env 或 `.secrets/deepseek-key` 读取，不打印、不写日志、不写 pack；
- 生成内容仅本地文件，不上传；导入 App 后也必须人工 ✓ 才落库；
- 不要把含真实 Key 的日志/文件分享出去。

## 6. 试水记录（2026-11-11）

```text
deck=kaoyan-2027-dagang 词=200 kinds=examples,phrases,mnemonics
30/30 批成功，0 失败；items=200；样例：make/year/think/company/provide 均 2 examples + 3 phrases + 1 mnemonic
tokens(in/out)=32411/33560；实际花费 ¥0.3333；耗时 ≈59.7s；checksum 自洽
产物：/tmp/wordc-200.pack.json
```
