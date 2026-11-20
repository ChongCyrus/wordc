import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
  info: string
}

function remember(error: Error, info: string) {
  const payload = { message: error.message, stack: error.stack ?? '', info, at: Date.now() }
  ;(window as unknown as { __mmLastError?: typeof payload }).__mmLastError = payload
  try {
    localStorage.setItem('mm.lastError', JSON.stringify(payload))
  } catch {
    undefined
  }
  console.error('[mm] render error', error, info)
}

/** P0 hotfix：渲染错误不再黑屏；记录 message/stack 供真机诊断 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const detail = `${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`
    this.setState({ info: detail })
    remember(error, detail)
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div style={{ minHeight: '100vh', padding: 24, background: '#fff', color: '#1f2937', boxSizing: 'border-box' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>页面渲染出错</h1>
        <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 12px' }}>
          已记录错误信息，未退出应用。可先重试或回首页；如重复出现请把下方错误发给开发者。
        </p>
        <pre
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: '#f3f4f6',
            padding: 10,
            borderRadius: 8,
            maxHeight: '45vh',
            overflow: 'auto',
            margin: '0 0 12px',
          }}
        >
          {error.message}
          {info ? `\n\n${info}` : ''}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 16px', borderRadius: 8 }}>
            重试
          </button>
          <button
            type="button"
            onClick={() => { window.location.hash = '#/' }}
            style={{ padding: '10px 16px', borderRadius: 8 }}
          >
            回首页
          </button>
        </div>
      </div>
    )
  }
}

/** 全局错误记录（错误边界外的事件/异步错误） */
export function installGlobalErrorLogging() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    const payload = {
      message: event.message || 'window error',
      stack: event.error instanceof Error ? event.error.stack ?? '' : '',
      info: 'window.error',
      at: Date.now(),
    }
    ;(window as unknown as { __mmLastError?: typeof payload }).__mmLastError = payload
    try {
      localStorage.setItem('mm.lastError', JSON.stringify(payload))
    } catch {
      undefined
    }
    console.error('[mm] window error', payload.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const payload = {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack ?? '' : '',
      info: 'unhandledrejection',
      at: Date.now(),
    }
    ;(window as unknown as { __mmLastError?: typeof payload }).__mmLastError = payload
    try {
      localStorage.setItem('mm.lastError', JSON.stringify(payload))
    } catch {
      undefined
    }
    console.error('[mm] unhandled rejection', payload.message)
  })
}
