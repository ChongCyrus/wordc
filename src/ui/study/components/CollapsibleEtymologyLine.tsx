import { useEffect, useRef, useState } from 'react'

/** 0.4.9：词源/组合长段落默认折叠 2 行，仅实际溢出时显示展开按钮 */
export function shouldShowEtymologyExpand(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1
}

export function CollapsibleEtymologyLine({
  label,
  text,
  className,
}: {
  label: string
  text: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      // 折叠态测量；展开后保持按钮存在，避免收起按钮消失
      setOverflow((prev) => (expanded ? prev : shouldShowEtymologyExpand(node.scrollHeight, node.clientHeight)))
    }
    measure()
    const timer = window.setTimeout(measure, 120)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [text, expanded])

  return (
    <div className={`${className ?? ''}${expanded ? ' is-expanded' : ''}`}>
      <div ref={ref} className="wc-root-etymology-line-clamp">
        <span className="wc-root-etymology-line-label">{label}：</span>
        <span>{text}</span>
      </div>
      {overflow || expanded ? (
        <button type="button" className="mm-btn mm-btn--sm wc-root-etymology-expand" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </div>
  )
}
