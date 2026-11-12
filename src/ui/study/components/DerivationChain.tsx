/** 「本义 → 引申」链（task-77）：11–12px 次要色小字，长文本可换行不挤压操作区。 */
export interface DerivationChainView {
  /** v4：本义 label（来自 coreSenses；渲染为「本义①「label」」） */
  label?: string
  /** 链步骤（v4 只含步骤；v3 旧契约 steps[0]=本义，作为无 label 时的回退） */
  steps: readonly string[]
  /** true = 来自 AI pack（链尾标注「AI 推演，仅供参考」） */
  aiGenerated?: boolean
}

export interface DerivationChainProps extends DerivationChainView {
  /** 紧凑模式（w-c 页当前 c 下方） */
  compact?: boolean
}

export function DerivationChain({ label, steps, aiGenerated, compact = false }: DerivationChainProps) {
  const items = steps.map((step) => step.trim()).filter((step) => step.length > 0)
  const title = (label ?? items[0] ?? '').trim()
  if (!title && items.length === 0) return null
  // v4：label 单独展示，steps 全部作为后续步骤；v3 旧行为：steps[0] 当作本义
  const chain = label ? items : items.slice(1)
  return (
    <div
      className="derivation-chain"
      style={compact ? { fontSize: 11 } : undefined}
    >
      <span className="derivation-chain-body">
        本义① 「{title}」
        {chain.map((step, index) => (
          <span key={`${step}-${index}`}> → {step}</span>
        ))}
      </span>
      {aiGenerated ? (
        <span className="derivation-ai">（AI 推演，仅供参考）</span>
      ) : null}
    </div>
  )
}
