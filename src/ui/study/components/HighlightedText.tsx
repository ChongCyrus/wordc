/**
 * 英文例句中的目标词高亮（只用颜色，不加粗/下划线，见 03-ui §4.2）。
 * 无目标词时原样输出；高亮不区分大小写、支持多词短语。
 */
export function HighlightedText({ text, word }: { text: string; word: string }) {
  const target = word.trim()
  if (!target) return <>{text}</>

  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  if (parts.length === 1) return <>{text}</>

  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === target.toLowerCase() ? (
          <span className="hl" key={`hl-${index}`}>
            {part}
          </span>
        ) : (
          <span key={`tx-${index}`}>{part}</span>
        ),
      )}
    </>
  )
}
