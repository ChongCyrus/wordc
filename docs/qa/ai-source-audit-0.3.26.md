# AI 补内容源码级审计（0.3.26，task-125）

> 范围：`src/ui/ai/AiGeneratePanel.tsx`、`src/app/hooks/aiUi.ts`、`src/data/generation-draft.ts`、`src/data/packs.repo.ts`、`src/data/ai/**`。
> 方法：只读源码对照 `docs/AI-CONTENT-SPEC.md`，不跑浏览器/不调 API。行号为审计时近似位置。

## 结论摘要

| 级别 | 问题 |
|---|---|
| P1 | replace 路径「先清后应用」非原子（UI 调 `applyReplacementPack` 后未校验替换条数；空条目的 replace 可能清空旧内容且无回滚） |
| P1 | 完成态草稿继续再点开始：`batchSize=0` 空跑，可能显示「失败 1」并触发清理（task-123 只拦了「未继续」分支） |
| P2 | 费用预估未接 `estimateBatchCost`：`estimateText` 恒为 `formatAiBudget(0, cap)`，显示 ¥0.00（缺失） |
| P2 | 重开面板旧 summary/error 残留：`refreshEstimate` 只在依赖变化时清，`open` false→true 未触发清理 |
| P2 | 目标数估算用 `limit:500` 截断：total 由 `page.total` 也不参与，>500 目标时显示的目标数偏小/不一致 |
| P2 | 保存成功后才清草稿；若 `onApplied`/`onClose` 抛错（实际不抛），清理顺序仍在成功路径，基本符合 |
| P3 | 审核无「将替换」逐条说明（replaceNotice 仅在 view prop，未在条目上标注） |

## 逐条对照

### 1. 目标/费用重算
- 符合：`refreshEstimate` 由 `[scope,targetDeckId,customSearch,selectedWordIds,kinds,modes,batchLimit,selectedMeaningIndexes]` 触发（task-115）；进入「指定含义」未勾选时目标=0 + 提示（`AiGeneratePanel.tsx` refreshEstimate 开头）。
- 不符（P2）：费用估算未使用 `estimateBatchCost`，`estimateText` 为固定格式字符串（`AiGeneratePanel.tsx` ≈684）。
- 不符（P2）：目标数请求固定 offset 0/limit 500，未按 `page.total` 展示「已选 N/共 M」（≈675）。

### 2. 旧 summary/error 清理
- 符合：选项变化路径 `refreshEstimate` 先 `setError(null)/setSummary(null)/setProgress(null)`（≈560）。
- 不符（P2）：面板关闭再打开时若选项未变，effect 不重跑，旧 summary/error/progress 仍保留到下次操作（`open` 未加入清理）。

### 3. 0 目标禁用
- 符合：`AiGenerateView` 开始按钮 `disabled={targetCount===0 || kinds.length===0}`；`handleStart` 前有草稿阻断、目标为 0 时生成 `pairs.length===0` 提示且不建草稿。

### 4. 草稿生命周期
- 符合：开始生成创建 draft（`createGenerationDraft`，仅当 pairs>0）；每片 `appendGenerationDraftItems` + `updateGenerationDraftCursor`；顶部「已生成 X/总 Y（草稿已保存）」；打开面板清理 done=0 草稿（≈583）。
- 符合：应用成功用 `activeDraftId` 立即 `clearGenerationDraft` 并重置（≈928）。
- 符合：未继续草稿点击开始被阻断（≈697）。
- 不符（P1）：已「继续」到完成（cursor==total）后再点开始，`batchSizeForLimit(limit, 0)=0`，slice 空 → generateItems 空跑 → summary「完成 0/1 失败 1」并进入 catch 清理草稿（≈850），与 task-123 期望「完成草稿应提示先继续/放弃」不一致。
- 符合：失败/超时才清理草稿，正常取消保留（canceled 分支 return 前不清理）。

### 5. replace semantics 清空（P1）
- UI 符合：`replaceEntries.length>0` 时调用 `applyReplacementPack(packId, wordIds, kinds)`（≈915-925），不再走普通 approve+apply。
- **不符/风险（P1）**：UI 未在导入后校验 `replace` 条目的有效数量（`listPackItems` 中 kind=semantics 且 payload 含 coreSenses/meaningMap 的条数）；若模型输出空/格式失败导致 pack items 为 0，`applyReplacementPack` 仍可能执行「清空该词旧本义 → 应用 0 条」，造成内容丢失且无回滚。建议：调用前校验 `replaceEntries` 每条 `item.coreSenses?.length>0`；调用后检查 `applied.replaced>0`（或返回结构）否则 toast 错误并保留原草稿。
- 需 data 侧确认：`applyReplacementPack` 是否单事务（清旧+应用新原子、非空校验）——见 `src/data/packs.repo.ts`（task-124 范围）。

### 6. 幂等
- 符合：`appendGenerationDraftItems` 按 headwordLower+meaningIndex 去重（data 测试 3/3）。
- 符合：普通 `applyApproved` 幂等、单事务。
- 风险：replace 重试若前一次已清空则不可恢复；需要 data 侧原子保证。

### 7. 范围/模式
- 符合：`modes` 按 kind 传给 `pendingGenerationTargetsPage(filters:{mode})`；切换后重算。
- 缺失：`replaceNotice` 未按条目渲染「将替换」；仅面板顶部提示。

### 8. 审核与保存
- 符合：✓/❌、全选/全不选、只应用 ✓（selectedEntries）、拒绝 `rejectGeneratedItem`。
- 缺失：保存失败仅 toast，草稿保留（正确），但未提供「重试保存」。

### 9. Key 与传输
- 符合：UI 只用 `maskApiKey` 回显，输入框只写不读；pack meta 不含 key。
- 符合：错误码走 `aiErrorMessage`，无 key 泄漏。

## 建议修复顺序（供 task-124/126）

1. **P1 replace 非空+原子**：UI 前置校验 + data 层 `applyReplacementPack` 事务内校验（清空前确认新条目非空）；失败保留草稿。
2. **P1 完成草稿阻断**：`handleStart` 前若 `draftCursor >= draftTotal && draftTotal>0` → summary「当前草稿已生成完成，请审核/放弃后重新开始」并 return，不创建/不清理。
3. P2 费用预估接 `estimateBatchCost`；目标数用 `page.total` 显示 N/M。
4. P2 面板 `open` 边沿清 summary/error/progress。
5. P3 replaceNotice 条目级「将替换」标注。
