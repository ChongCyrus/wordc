import { Fragment, type ReactNode } from 'react'

/**
 * F10：F8 右页文字安全 Markdown 子集。
 * 支持：段落/换行、**加粗**、*斜体*、`行内代码`、# 标题(1–3)、-/* 无序列表、1. 有序列表。
 * 安全：全部用 React 文本节点构造，不解析/不渲染原始 HTML；链接/图片等保持纯文本。
 */

let inlineKey = 0

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  // 顺序：行内代码优先（内部不再解析），然后加粗、斜体
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${inlineKey++}`
    if (token.startsWith('`') && token.endsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') && token.endsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderLines(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n')
  const nodes: ReactNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(<br key={`${keyPrefix}-br-${index}`} />)
    nodes.push(<Fragment key={`${keyPrefix}-l-${index}`}>{renderInline(line, `${keyPrefix}-${index}`)}</Fragment>)
  })
  return nodes
}

export function MarkdownText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const content = renderInline(heading[2] ?? '', `h-${key}`)
      const Tag = (`h${level}` as 'h1' | 'h2' | 'h3')
      blocks.push(
        <Tag key={`h-${key++}`} className={`derivation-md-heading derivation-md-h${level}`}>
          {content}
        </Tag>,
      )
      index += 1
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        const item = (lines[index] ?? '').replace(/^\s*[-*]\s+/, '')
        items.push(
          <li key={`ul-${key}-${items.length}`}>{renderInline(item, `ul-${key}-${items.length}`)}</li>,
        )
        index += 1
      }
      blocks.push(<ul key={`ul-${key++}`}>{items}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        const item = (lines[index] ?? '').replace(/^\s*\d+\.\s+/, '')
        items.push(
          <li key={`ol-${key}-${items.length}`}>{renderInline(item, `ol-${key}-${items.length}`)}</li>,
        )
        index += 1
      }
      blocks.push(<ol key={`ol-${key++}`}>{items}</ol>)
      continue
    }
    // 段落：连续非空、非标题/列表行合并，行间 <br/>
    const para: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        !current.trim() ||
        /^(#{1,3})\s+/.test(current) ||
        /^\s*[-*]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current)
      ) {
        break
      }
      para.push(current)
      index += 1
    }
    blocks.push(
      <p key={`p-${key++}`} className="derivation-md-p">
        {renderLines(para.join('\n'), `p-${key}`)}
      </p>,
    )
  }
  return <div className="derivation-markdown">{blocks}</div>
}
