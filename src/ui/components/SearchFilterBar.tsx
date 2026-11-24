import { useEffect, useState } from 'react'

/** 0.11.1：页面内本地搜索（按 label/hint 文本过滤 .mm-row；空结果显示提示） */
export function SearchFilterBar({ placeholder = '搜索设置' }: { placeholder?: string }) {
  const [query, setQuery] = useState('')
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.mm-page')
    if (!root) return
    const q = query.trim().toLowerCase()
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.mm-row'))
    let visible = 0
    for (const row of rows) {
      const match = q === '' || (row.textContent ?? '').toLowerCase().includes(q)
      // 用内联 display 而不是 hidden：.mm-row { display:flex } 会覆盖 [hidden]
      row.style.display = match ? '' : 'none'
      if (match) visible += 1
    }
    // 清空时恢复全部容器；有查询时隐藏没有可见行的卡片/列表与对应分组标题
    const lists = Array.from(root.querySelectorAll<HTMLElement>('.mm-list, .mm-card'))
    for (const list of lists) {
      if (list.querySelector('.mm-list-search')) continue
      const rowEls = Array.from(list.querySelectorAll<HTMLElement>('.mm-row'))
      const anyVisible = rowEls.some((row) => row.style.display !== 'none')
      // 没有 row 的卡片（学习者/使用说明/原理等）在搜索时也隐藏，避免空壳
      list.style.display = q !== '' && !anyVisible ? 'none' : ''
    }
    const bands = Array.from(root.querySelectorAll<HTMLElement>('.mm-section-band'))
    for (let i = 0; i < bands.length; i += 1) {
      const band = bands[i]!
      let sibling = band.nextElementSibling
      let hasVisible = false
      while (sibling && sibling !== bands[i + 1]) {
        if (!(sibling as HTMLElement).style || (sibling as HTMLElement).style.display !== 'none') {
          const rowEls = Array.from((sibling as HTMLElement).querySelectorAll<HTMLElement>('.mm-row'))
          if (rowEls.length === 0 || rowEls.some((row) => row.style.display !== 'none')) {
            hasVisible = true
            break
          }
        }
        sibling = sibling.nextElementSibling
      }
      band.style.display = q !== '' && !hasVisible ? 'none' : ''
    }
    setEmpty(q !== '' && visible === 0)
  }, [query])

  return (
    <div className="mm-list-search">
      <input
        className="mm-input"
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {empty ? <div className="mm-caption">没有匹配的设置项</div> : null}
    </div>
  )
}
