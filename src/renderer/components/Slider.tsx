import { useRef } from 'react'

interface SliderProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  help?: string        // 悬停说明（3.5）
  onChange: (v: number) => void
  onDoubleClick?: () => void
}

// 单个调整滑块。
// 双击归零（回到 defaultValue）。中点刻度线让 0 的位置可见。
// 满足触控目标 ≥44px 高度要求。
// 悬停 label 显示 help（title 属性，原生 tooltip，无需 JS）。
export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  defaultValue = 0,
  help,
  onChange,
  onDoubleClick,
}: SliderProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // 中点位置百分比，画一条竖线
  const zeroPct = ((0 - min) / (max - min)) * 100
  const valPct = ((value - min) / (max - min)) * 100

  return (
    <div className="select-text">
      <div className="mb-1 flex items-center justify-between">
        <label
          className="text-xs text-zinc-400"
          title={help ? `${label}：${help}` : undefined}
        >
          {label}
        </label>
        <span
          className={[
            'font-mono text-[11px] tabular-nums',
            value === defaultValue ? 'text-zinc-500' : 'text-zinc-200',
          ].join(' ')}
        >
          {value > 0 ? '+' : ''}
          {value}
        </span>
      </div>
      <div className="relative flex h-8 items-center">
        {/* 轨道 */}
        <div className="absolute inset-x-0 h-1 rounded-full bg-zinc-800" />
        {/* 0 点刻度 */}
        <div
          className="absolute h-2 w-px -translate-y-1/2 top-1/2 bg-zinc-600"
          style={{ left: `${zeroPct}%` }}
        />
        {/* 已填充段（从 0 点向当前值） */}
        <div
          className="absolute h-1 rounded-full bg-zinc-400"
          style={{
            left: `${Math.min(zeroPct, valPct)}%`,
            width: `${Math.abs(valPct - zeroPct)}%`,
          }}
        />
        <input
          ref={inputRef}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => {
            if (onDoubleClick) onDoubleClick()
            else onChange(defaultValue)
          }}
          aria-label={label}
          aria-valuenow={value}
          className="lm-range relative z-10 h-8 w-full cursor-pointer appearance-none bg-transparent"
        />
      </div>
    </div>
  )
}
