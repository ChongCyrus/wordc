/**
 * 纯 SVG/CSS 图表（不引图表库）：
 * - BarChart：近 14 天学习量柱状图
 * - StackedBar：今日反馈分布（认识/模糊/不认识）水平堆叠条
 * - Legend：文字图例（颜色之外必须同时有文字，03-ui §9 色盲要求）
 */

export interface BarPoint {
  label: string
  value: number
}

export interface BarChartProps {
  data: BarPoint[]
  height?: number
  color?: string
  ariaLabel?: string
}

/** 柱状图：SVG 柱 + HTML 横轴标签（柱上 <title> 可看具体数值） */
export function BarChart({ data, height = 120, color = 'var(--mm-chart-known)', ariaLabel }: BarChartProps) {
  const max = Math.max(1, ...data.map((point) => point.value))
  const slot = 20
  const barWidth = 10
  const width = Math.max(1, data.length) * slot
  const chartHeight = 88
  const labelStep = Math.max(1, Math.ceil(data.length / 7))

  return (
    <div>
      <svg
        className="mm-chart"
        viewBox={`0 0 ${width} ${chartHeight + 8}`}
        role="img"
        aria-label={ariaLabel ?? '学习量柱状图'}
        style={{ height }}
        preserveAspectRatio="none"
      >
        {data.map((point, index) => {
          const barHeight = point.value === 0 ? 0 : Math.max(3, (point.value / max) * (chartHeight - 6))
          const x = index * slot + (slot - barWidth) / 2
          const y = chartHeight - barHeight
          return (
            <g key={`${point.label}-${index}`}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={color}
                opacity={point.value === 0 ? 0.25 : 1}
              >
                <title>{`${point.label}：${point.value}`}</title>
              </rect>
            </g>
          )
        })}
        <line x1={0} y1={chartHeight} x2={width} y2={chartHeight} stroke="var(--mm-divider)" strokeWidth={1} />
      </svg>
      <div style={{ display: 'flex', marginTop: 4 }} aria-hidden="true">
        {data.map((point, index) => (
          <span
            key={`${point.label}-label-${index}`}
            style={{
              flex: '1 1 0',
              textAlign: 'center',
              fontSize: 10,
              color: 'var(--mm-text-3)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {index % labelStep === 0 ? point.label : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface StackSegment {
  label: string
  value: number
  color: string
}

export interface StackedBarProps {
  segments: StackSegment[]
  height?: number
  ariaLabel?: string
}

/** 水平堆叠条（今日反馈分布 12px 高） */
export function StackedBar({ segments, height = 12, ariaLabel }: StackedBarProps) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0)
  return (
    <div
      style={{
        display: 'flex',
        height,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: 'var(--mm-surface-3)',
      }}
      role="img"
      aria-label={ariaLabel ?? '分布堆叠条'}
    >
      {total === 0
        ? null
        : segments
            .filter((segment) => segment.value > 0)
            .map((segment) => (
              <div
                key={segment.label}
                title={`${segment.label} ${segment.value}`}
                style={{
                  width: `${(segment.value / total) * 100}%`,
                  backgroundColor: segment.color,
                }}
              />
            ))}
    </div>
  )
}

export interface LegendItem {
  label: string
  color: string
  value?: string | number
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="mm-legend">
      {items.map((item) => (
        <span key={item.label}>
          <span className="mm-legend-dot" style={{ backgroundColor: item.color }} />
          {item.label}
          {item.value != null ? ` ${item.value}` : ''}
        </span>
      ))}
    </div>
  )
}
