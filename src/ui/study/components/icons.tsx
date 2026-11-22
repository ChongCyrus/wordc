/**
 * 学习页内联 SVG 图标（线性风格：24×24 视框、1.5px 描边、圆头圆角）。
 * 参考 docs/research/03-ui.md §2.4：不用 emoji 当图标。
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 24, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  }
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  )
}

export function SpeakerIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9.5h3.2L12 5.8v12.4L7.2 14.5H4z" />
      <path d="M16 9a4.2 4.2 0 010 6" />
      <path d="M18.6 6.4a8 8 0 010 11.2" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

/** 完成页/空状态的单色猫头鹰（墨墨吉祥物简化轮廓，纯装饰） */
export function OwlIcon({ size = 96, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {/* 身体 */}
      <path d="M24 48c0-14 10.7-24 24-24s24 10 24 24v18c0 8-4.5 14-11 14H35c-6.5 0-11-6-11-14V48z" />
      {/* 头顶两簇 */}
      <path d="M30 43c-2-8-1-13 1-15 2 5 5 8 8 9" />
      <path d="M66 43c2-8 1-13-1-15-2 5-5 8-8 9" />
      {/* 眼睛 */}
      <circle cx="39" cy="49" r="7" />
      <circle cx="57" cy="49" r="7" />
      <circle cx="39" cy="49" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="57" cy="49" r="1.6" fill="currentColor" stroke="none" />
      {/* 喙 */}
      <path d="M48 54l-3.4 5h6.8z" />
      {/* 翅膀 */}
      <path d="M22 58c-3 6-2 12 2 16" />
      <path d="M74 58c3 6 2 12-2 16" />
    </svg>
  )
}
