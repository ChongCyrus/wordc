import { mnemonicKey } from '../../../data/user-content'
import type { MnemonicView } from '../components/types'

/**
 * F6：展示用助记合并：
 * - 过滤 `hiddenMnemonicKeys`（删除/编辑过的 AI 原条目）；
 * - 用户副本（userMnemonics 同 key）优先，原 AI/内置不重复展示。
 */
export interface VisibleMnemonicSource {
  mnemonics?: Array<{ type: string; text: string; meaningId?: string }>
  userMnemonics?: Array<{ type: string; text: string; meaningId?: string }>
  hiddenMnemonicKeys?: string[]
}

export function visibleMnemonics(word: VisibleMnemonicSource | null | undefined): MnemonicView[] {
  if (!word) return []
  const hidden = new Set(word.hiddenMnemonicKeys ?? [])
  const userKeys = new Set(
    (word.userMnemonics ?? []).map((item) => mnemonicKey(item.meaningId, item.type, item.text)),
  )
  return (word.mnemonics ?? [])
    .filter((mnemonic) => {
      const key = mnemonicKey(mnemonic.meaningId, mnemonic.type, mnemonic.text)
      return !hidden.has(key) && !userKeys.has(key)
    })
    .map((mnemonic) => ({
      type: mnemonic.type,
      text: mnemonic.text,
      ...(mnemonic.meaningId ? { meaningId: mnemonic.meaningId } : {}),
    }))
}
