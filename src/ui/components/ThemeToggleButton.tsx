import { useRef } from 'react'
import { useTheme } from '../../app/theme'
import { MoonIcon, SunIcon } from './icons'

/** 0.11.1：点击 light↔dark；长按 650ms / 右键恢复跟随系统 */
export function ThemeToggleButton() {
  const { mode, resolved, setMode } = useTheme()
  const timerRef = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const onPointerDown = () => {
    clearTimer()
    longPressFiredRef.current = false
    timerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true
      timerRef.current = null
      setMode('system')
    }, 650)
  }

  const onPointerEnd = () => {
    clearTimer()
  }

  return (
    <button
      type="button"
      className="mm-icon-btn"
      aria-label={mode === 'system' ? '深浅色跟随系统，点击切换' : `当前${resolved === 'dark' ? '深色' : '浅色'}，点击切换`}
      title="点击切换深浅；长按恢复跟随系统"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClick={() => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false
          return
        }
        setMode(resolved === 'dark' ? 'light' : 'dark')
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        longPressFiredRef.current = true
        setMode('system')
      }}
    >
      {resolved === 'dark' ? <MoonIcon size={22} /> : <SunIcon size={22} />}
    </button>
  )
}
