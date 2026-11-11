/** 「本义 → 引申」链（task-77）：11–12px 次要色小字，长文本可换行不挤压操作区。 */
export interface DerivationChainView {
  /** 链步骤：第 1 个为本义，后续为引申义（不含箭头，渲染时拼接） */
  steps: readonly string[]
  /** true = 来自 AI pack（链尾标注「AI 推演，仅供参考」） */
  aiGenerated?: boolean
}

export interface DerivationChainProps extends DerivationChainView {
  /** 紧凑模式（w-c 页当前 c 下方） */
  compact?: boolean
}

export function DerivationChain({ steps, aiGenerated, compact = false }: DerivationChainProps) {
  const items = steps.map((step) => step.trim()).filter((step) => step.length > 0)
  if (items.length === 0) return null
  return (
    <div
      className="derivation-chain"
      style={compact ? { fontSize: 11 } : undefined}
    >
      <span className="derivation-chain-body">
        本义① 「{items[0]}」
        {items.slice(1).map((step, index) => (
          <span key={`${step}-${index}`}> → {step}</span>
        ))}
      </span>
      {aiGenerated ? (
        <span className="derivation-ai">（AI 推演，仅供参考）</span>
      ) : null}
    </div>
  )
}
