import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeftIcon } from './icons'

export interface PageShellProps {
  title: string
  /** 大标题（首页「今日」等） */
  hero?: boolean
  /** 返回目标路径（二级页） */
  backTo?: string
  actions?: ReactNode
  children: ReactNode
  /** 内容区不需要左右 16px 内边距时（如通栏列表） */
  flush?: boolean
}

/**
 * 页面容器：顶栏（返回/标题/右侧操作）+ 内容区（padding 0 16px）。
 * 底部 Tab 由 AppShell 统一渲染；本组件只管页面本身。
 */
export function PageShell({ title, hero = false, backTo, actions, children, flush = false }: PageShellProps) {
  return (
    <div className={`mm-page${flush ? ' mm-page--flush' : ''}`}>
      <div className="mm-topbar">
        {backTo ? (
          <Link to={backTo} className="mm-icon-btn" aria-label="返回">
            <ChevronLeftIcon size={22} />
          </Link>
        ) : null}
        <h1
          className={`mm-topbar-title${hero ? ' mm-topbar-title--hero' : ''}${
            backTo ? ' mm-topbar-title--center' : ''
          }`}
        >
          {title}
        </h1>
        {actions ? <div className="mm-topbar-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** 页内可复用的列表容器（mm-list 的语义别名） */
export function List({ children }: { children: ReactNode }) {
  return <div className="mm-list">{children}</div>
}
