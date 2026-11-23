/**
 * 词性标签墨墨化（只改展示层，不改数据格式）。
 *
 * 数据里 pos 仍然是 `n.` / `vt.` / `phr.` 这类原始写法；展示成 `[名] [动] [词组]`。
 * 组合词性（`n.&vt.`、`vt./vi.`）逐项映射并去重；只要含未知词性就整体保留原样。
 */

const POS_LABELS: Record<string, string> = {
  n: '名',
  v: '动',
  vt: '动',
  vi: '动',
  adj: '形',
  adv: '副',
  prep: '介',
  conj: '连',
  pron: '代',
  num: '数',
  art: '冠',
  int: '叹',
  phr: '词组',
}

/** 单个词性 token → 中文标签；未知返回 null */
export function posLabelOf(token: string): string | null {
  const key = token.trim().toLowerCase().replace(/\.+$/, '')
  if (!key) return null
  return POS_LABELS[key] ?? null
}

/**
 * 展示用词性标签：
 * - `n.` → `[名]`
 * - `vt./vi.` → `[动]`（同义去重）
 * - `n.&vt.` → `[名][动]`
 * - 空/未提供 → null（不渲染）
 * - 含未知词性（如 `abbr.`）→ 原样返回
 */
export function formatPosLabel(pos?: string | null): string | null {
  const raw = pos?.trim()
  if (!raw) return null
  const tokens = raw.split(/[&/,，、\s]+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  const labels: string[] = []
  for (const token of tokens) {
    const label = posLabelOf(token)
    if (label == null) return raw // 未知保留原样
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.map((label) => `[${label}]`).join('')
}
