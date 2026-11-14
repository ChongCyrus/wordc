import type { DerivationMapContent } from '../components/types'

/** AI 生成结果（generation）按当前预览模式合并：绝不切换用户当前选择的模式 */
export function mergeGeneratedDerivation(input: {
  current: DerivationMapContent
  generated: { rootLabel?: string; text?: string; mermaid?: string }
}): DerivationMapContent {
  const { current, generated } = input
  return {
    mode: current.mode,
    text: generated.text?.trim() ? generated.text : current.text,
    mermaid: generated.mermaid?.trim() ? generated.mermaid : current.mermaid,
    ...(generated.rootLabel ? { rootLabel: generated.rootLabel } : current.rootLabel ? { rootLabel: current.rootLabel } : {}),
    source: 'ai',
  }
}

/** 当前模式是否有可展示内容（空则显示占位，不自动切模式） */
export function derivationModeHasContent(content: DerivationMapContent): boolean {
  return content.mode === 'mermaid'
    ? Boolean(content.mermaid?.trim())
    : Boolean(content.text?.trim())
}
