/**
 * 通用线性图标（24×24 视框、1.5px 描边、圆头圆角；不用 emoji 当图标）。
 * 参考 docs/research/03-ui.md §2.4。
 */
import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function iconBase({ size = 24, ...rest }: IconProps) {
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
  } as const
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z" />
    </svg>
  )
}

export function BookIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3z" />
      <path d="M5 17a3 3 0 013-3h9" />
    </svg>
  )
}

export function DecksIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <rect x="4" y="5" width="12" height="15" rx="2" />
      <path d="M8 3h10a2 2 0 012 2v13" />
    </svg>
  )
}

export function ChartIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 19h16" />
      <path d="M7 16V11M12 16V6M17 16v-3" />
    </svg>
  )
}

export function MeIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.8-3.4 3.6-5.5 7-5.5s6.2 2.1 7 5.5" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.9 7.6l1.7 1M17.4 15.4l1.7 1M4.9 16.4l1.7-1M17.4 8.6l1.7-1" />
    </svg>
  )
}

export function AboutIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M9.5 5.5L16 12l-6.5 6.5" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  )
}

export function UploadIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 16V5M8 9l4-4 4 4" />
      <path d="M5 15v3a2 2 0 002 2h10a2 2 0 002-2v-3" />
    </svg>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 5v11M8 12l4 4 4-4" />
      <path d="M5 15v3a2 2 0 002 2h10a2 2 0 002-2v-3" />
    </svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M20 12a8 8 0 11-2.3-5.6" />
      <path d="M20 4v4h-4" />
    </svg>
  )
}

export function EditIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  )
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...iconBase(props)}>
      <path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.7.9 5.2-4.6-2.4-4.6 2.4.9-5.2L4.5 10l5.2-.8z" />
    </svg>
  )
}

/** 完成页/空状态用的单色猫头鹰（墨墨吉祥物简化轮廓，纯装饰） */
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
      <path d="M24 48c0-14 10.7-24 24-24s24 10 24 24v18c0 8-4.5 14-11 14H35c-6.5 0-11-6-11-14V48z" />
      <path d="M30 43c-2-8-1-13 1-15 2 5 5 8 8 9" />
      <path d="M66 43c2-8 1-13-1-15-2 5-5 8-8 9" />
      <circle cx="39" cy="49" r="7" />
      <circle cx="57" cy="49" r="7" />
      <circle cx="39" cy="49" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="57" cy="49" r="1.6" fill="currentColor" stroke="none" />
      <path d="M48 54l-3.4 5h6.8z" />
      <path d="M22 58c-3 6-2 12 2 16" />
      <path d="M74 58c3 6 2 12-2 16" />
    </svg>
  )
}
