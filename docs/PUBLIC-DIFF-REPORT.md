# 公开树 vs 私有仓 Diff 报告

- 生成时间：2026-11-12T05:34:04.475Z
- 私有仓：`/root/workspace/背单词APP开发`
- 公开树：`/tmp/wordc-public`
- 公开文件：**313**；修改 **73**；新增 **4**；私有仓未进入公开树 **1702**

## 结论

- **逻辑变更：0** ✅（仅文案/注释/配置/数据 meta 变化）
- **deck 数据语义差异：0** ✅（仅 generator/版本类字段允许差异）

## 修改文件明细

| 文件 | 分类 | 说明 |
|---|---|---|
| `.github/workflows/ci.yml` | 配置/文档 | 文本变化 |
| `.gitignore` | 配置/文档 | 文本变化 |
| `LICENSE` | 新增（公开版生成/改写） | 私仓无对应文件 |
| `README.md` | 配置/文档 | 文本变化 |
| `THIRD-PARTY-NOTICES.md` | 新增（公开版生成/改写） | 私仓无对应文件 |
| `docs/AI-BULK-GEN.md` | 配置/文档 | 文本变化 |
| `docs/ARCH-v2.md` | 配置/文档 | 文本变化 |
| `docs/ARCH.md` | 配置/文档 | 文本变化 |
| `docs/CI.md` | 配置/文档 | 文本变化 |
| `docs/IMPORT-YOUR-DECK.md` | 配置/文档 | 文本变化 |
| `docs/PUBLIC-SCOPE.md` | 新增（公开版生成/改写） | 私仓无对应文件 |
| `docs/SPEC-v2.md` | 配置/文档 | 文本变化 |
| `docs/SPEC.md` | 配置/文档 | 文本变化 |
| `docs/UI-APP.md` | 配置/文档 | 文本变化 |
| `docs/UI-STUDY.md` | 配置/文档 | 文本变化 |
| `docs/assets/demo/README.md` | 配置/文档 | 文本变化 |
| `docs/prompts/semantics-v4.md` | 配置/文档 | 文本变化 |
| `package.json` | 配置 | JSON 字段变化 |
| `public/packs/dagang/wc-content-full.pack.json` | 新增（公开版生成/改写） | 私仓无对应文件 |
| `scripts/serve.py` | 配置/文档 | 文本变化 |
| `scripts/start.sh` | 配置/文档 | 文本变化 |
| `scripts/stop.sh` | 配置/文档 | 文本变化 |
| `src/app/brand.ts` | 配置（sanitize 覆盖：品牌/词库清单） | 公开版按约定覆盖，非逻辑代码 |
| `src/app/styles/global.css` | 配置/文档 | 文本变化 |
| `src/app/styles/tokens.css` | 配置/文档 | 文本变化 |
| `src/core/ids.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/core/params.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/core/schedule.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/core/types.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/ai/prompts.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/api/maimemo-client.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/api/maimemo.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/builtin/deck-sources.ts` | 配置（sanitize 覆盖：品牌/词库清单） | 公开版按约定覆盖，非逻辑代码 |
| `src/data/builtin/index.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/builtin/kaoyan-2027-dagang.deck.json` | 数据（meta/版本类允许差异） | 词条/释义/难度/词组逐项一致；允许差异字段：generator |
| `src/data/builtin/manifest.json` | 配置 | JSON 字段变化 |
| `src/data/checksum.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/default-packs.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/import-export.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/index.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/settings.repo.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/data/word-factory.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/ui/ai/AiGeneratePanel.tsx` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/ui/decks/DecksPage.tsx` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/ui/me/AboutPage.tsx` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `src/ui/study/components/types.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/core/ids-time.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/core/requeue-preview.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/core/schedule.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/api/maimemo-real-data.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/builtin.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/content-pack-deck.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/default-packs.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/import-export.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/new-word-order.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/phrase-meanings.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/plans.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/data/real-packs.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/e2e/algo-independent.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/e2e/data-robustness.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/e2e/demo-public.mjs` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/e2e/v2-e2e.mjs` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/tools/deck-split.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/ui/ai-ui.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/ui/brand.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/ui/files-bridge.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/ui/pages-smoke.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tests/ui/study-flow.test.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tools/apk/AndroidManifest.xml` | 配置/文档 | 文本变化 |
| `tools/apk/build-apk.sh` | 配置/文档 | 文本变化 |
| `tools/apk/src/com/dsh/momoreword/MainActivity.java` | 配置/文案（Java） | 包名/文案变化（预期） |
| `tools/e2e/package-lock.json` | 配置 | JSON 字段变化 |
| `tools/e2e/package.json` | 配置 | JSON 字段变化 |
| `tools/export-words-for-ai.mjs` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tools/lib/deck-words.mjs` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `tools/make-deck-from-export.mjs` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |
| `vite.config.ts` | 文案/注释 | 去注释与字符串内容后 token 序列一致 |

## 未进入公开树的私有文件（按目录汇总）

- `.github/workflows`
- `.secrets/apk-keystore-pass`
- `.secrets/apk-release.jks`
- `.secrets/bailian-key`
- `.secrets/deepseek-key`
- `.secrets/github-token`
- `.secrets/github-token-delete`
- `.secrets/juflowai-key`
- `.secrets/maimemo-token`
- `.secrets/push-state.json`
- `.secrets/user-export`
- `.secrets/zhipu-key`
- `START.md`
- `data/packs`
- `data/raw`
- `docs/ACCEPTANCE-0.2.0.md`
- `docs/API-IMPORT.md`
- `docs/APK.md`
- `docs/ARCH-CONTENT-PACKS.md`
- `docs/CORE-API.md`
- `docs/DATA-API.md`
- `docs/DATA-PLAN-v2-design.md`
- `docs/DECISIONS.md`
- `docs/DEMO-STORYBOARD.md`
- `docs/E2E.md`
- `docs/EXTERNAL-AI-PIPELINE.md`
- `docs/MIRRORS.md`
- `docs/OFFICIAL-ALIGNMENT.md`
- `docs/PUBLIC-PLAN.md`
- `docs/PUBLIC-README.md`
- `docs/PUBLIC-RELEASE.md`
- `docs/PUBLIC-WORKFLOW.md`
- `docs/QA-AUDIT-v2.md`
- `docs/QA-v2.md`
- `docs/QA.md`
- `docs/RUN.md`
- `docs/SPEC-CONTENT-PACKS.md`
- `docs/assets`
- `docs/research`
- `scripts/.server.pid`
- `scripts/build-private.sh`
- `scripts/deliver.sh`
- `scripts/logs`
- `src/data`
- `tests/data`
- `tests/e2e`
- `tests/ui`
- `tools/apk`
- `tools/apply-semantics-patch.mjs`
- `tools/audit-semantics-pack.mjs`
- `tools/e2e`
- `tools/fix-semantics-labels.mjs`
- `tools/fix-semantics-origins.mjs`
- `tools/github`
- `tools/sanitize-public.mjs`
- `vendor/research-algo`

> 说明：公开树由 `tools/sanitize-public.mjs` 生成；本报告由 `tools/verify-public-tree.mjs` 校验。
> deck JSON 若仅 `generator/generatedAt/dataVersion/formatVersion` 等元数据不同，词条/释义/难度/词组必须逐项一致。
