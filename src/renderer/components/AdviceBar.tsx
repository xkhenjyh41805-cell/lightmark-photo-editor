import type { Advice } from '../../advisor'

interface AdviceBarProps {
  advices: Advice[]
  onGotoStep?: (step: Advice['step']) => void
}

// AI 建议条：实时显示 advisor 给的一句话建议。
// 多条时只显示最高优先级那条，其余可展开看。
// warn 红、tip 黄、ok 绿，颜色之外还有图标和文字，不靠颜色单一传达。
const LEVEL_META = {
  warn: { icon: '!', label: '注意', cls: 'border-amber-600/60 bg-amber-950/40 text-amber-200' },
  tip: { icon: '·', label: '建议', cls: 'border-sky-600/50 bg-sky-950/30 text-sky-200' },
  ok: { icon: '✓', label: '状态', cls: 'border-emerald-700/50 bg-emerald-950/30 text-emerald-200' },
} as const

export function AdviceBar({ advices, onGotoStep }: AdviceBarProps) {
  if (advices.length === 0) {
    return (
      <div className="flex h-9 items-center border-b border-zinc-800 bg-zinc-950 px-3">
        <span className="text-[11px] text-zinc-600">选一张照片开始，建议会自动出现。</span>
      </div>
    )
  }

  const top = advices[0]
  const meta = LEVEL_META[top.level]
  const rest = advices.slice(1)

  return (
    <div className="border-b border-zinc-800 bg-zinc-950">
      <div className={`flex items-center gap-2 px-3 py-1.5 border-l-2 ${meta.cls}`}>
        <span
          aria-hidden="true"
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-current/10 text-[10px] font-bold"
        >
          {meta.icon}
        </span>
        <span className="text-[11px] font-medium opacity-70">{meta.label}</span>
        <span className="flex-1 text-[12px] leading-tight">{top.text}</span>
        {top.step && onGotoStep && (
          <button
            onClick={() => onGotoStep(top.step)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            去调整
          </button>
        )}
      </div>
      {rest.length > 0 && (
        <ul className="px-3 pb-1.5 pt-0.5">
          {rest.map((a) => {
            const m = LEVEL_META[a.level]
            return (
              <li key={a.id} className="flex items-center gap-1.5 py-0.5">
                <span className={`text-[10px] ${m.cls.split(' ').pop()}`} aria-hidden="true">
                  {m.icon}
                </span>
                <span className="text-[11px] text-zinc-500">{a.text}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
