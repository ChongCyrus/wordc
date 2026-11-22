import { forwardRef, useCallback, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, TextareaHTMLAttributes } from 'react'

/** 0.4.6：Android WebView/IME 下 Enter 不插入换行，统一在 keydown 中手动插入 */
export function insertNewlineAt(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { value: string; cursor: number } {
  const start = selectionStart ?? value.length
  const end = selectionEnd ?? start
  return {
    value: `${value.slice(0, start)}\n${value.slice(end)}`,
    cursor: start + 1,
  }
}

export function shouldInsertNewline(input: {
  key: string
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
}): boolean {
  if (input.key !== 'Enter') return false
  if (input.isComposing || input.keyCode === 229) return false
  return !input.shiftKey
}

export type MultilineTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

/**
 * 受控多行输入：Enter 手动插入换行并恢复光标；Shift+Enter 保持默认；
 * 中文输入法 composing 时不插入；其余 props 与 textarea 一致。
 */
export const MultilineTextarea = forwardRef<HTMLTextAreaElement, MultilineTextareaProps>(
  function MultilineTextarea({ value, onChange, onKeyDown, ...rest }, forwardedRef) {
    const localRef = useRef<HTMLTextAreaElement | null>(null)
    const setRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        localRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      },
      [forwardedRef],
    )

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      const native = event.nativeEvent as KeyboardEvent['nativeEvent'] & { isComposing?: boolean; keyCode?: number }
      if (
        !shouldInsertNewline({
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: native.isComposing ?? false,
          keyCode: native.keyCode,
        })
      ) {
        return
      }
      event.preventDefault()
      const element = event.currentTarget
      const next = insertNewlineAt(
        String(value ?? element.value),
        element.selectionStart,
        element.selectionEnd,
      )
      onChange?.({
        target: { value: next.value },
        currentTarget: { value: next.value },
      } as unknown as ChangeEvent<HTMLTextAreaElement>)
      window.requestAnimationFrame(() => {
        const node = localRef.current
        if (!node) return
        node.setSelectionRange(next.cursor, next.cursor)
      })
    }

    return (
      <textarea
        {...rest}
        ref={setRef}
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
      />
    )
  },
)
