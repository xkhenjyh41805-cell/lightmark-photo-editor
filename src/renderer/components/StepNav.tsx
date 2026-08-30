import type { StepId, Mastery } from '../guidance'
import { STEPS } from '../guidance'

interface StepNavProps {
  step: StepId
  mastery: Mastery
  onStep: (id: StepId) => void
  onMastery: (m: Mastery) => void
  disabled?: boolean
}

// 底部步骤导航栏 + 新手/专业切换。
// 流程感是这个软件的核心：导入→基础校正→影调→白平衡→色彩→细节。
// 点步骤切换右侧滑块组，不丢参数。
export function StepNav({ step, mastery, onStep, onMastery, disabled }: StepNavProps) {
  const currentIdx = STEPS.findIndex((s) => s.id === step)

  return (
    <footer className="flex h-12 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-950 px-3">
      {/* 步骤条 */}
      <nav aria-label="修图步骤" className="flex items-center gap-1">
        {STEPS.map((s, idx) => {
          const active = s.id === step
          const done = idx < currentIdx
          return (
            <button
              key={s.id}
              onClick={() => onStep(s.id)}
              disabled={disabled}
              aria-current={active ? 'step' : undefined}
              className={[
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 disabled:opacity-40',
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300',
              ].join(' ')}
            >
              {/* 序号圆点：已完成实心、当前高亮、未来空心 */}
              <span
                className={[
                  'flex h-4 w-4 items-center justify-center rounded-full text-[9px]',
                  active
                    ? 'bg-zinc-200 text-zinc-900'
                    : done
                      ? 'bg-zinc-600 text-zinc-100'
                      : 'border border-zinc-700 text-zinc-600',
                ].join(' ')}
              >
                {done ? '✓' : idx + 1}
              </span>
              {s.label}
            </button>
          )
        })}
      </nav>

      {/* 新手/专业切换 */}
      <div
        role="group"
        aria-label="模式切换"
        className="flex items-center rounded bg-zinc-900 p-0.5"
      >
        {(['novice', 'pro'] as Mastery[]).map((m) => (
          <button
            key={m}
            onClick={() => onMastery(m)}
            disabled={disabled}
            aria-pressed={mastery === m}
            className={[
              'rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 disabled:opacity-40',
              mastery === m
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300',
            ].join(' ')}
          >
            {m === 'novice' ? '新手' : '专业'}
          </button>
        ))}
      </div>
    </footer>
  )
}
