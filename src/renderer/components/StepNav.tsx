import type { StepId } from '../guidance'
import { STEPS } from '../guidance'

interface StepNavProps {
  step: StepId
  onStep: (id: StepId) => void
  disabled?: boolean
}

// 手动调整分类入口，放在左侧手动面板内，不作为底部步骤条。
export function StepNav({ step, onStep, disabled }: StepNavProps) {
  return (
    <nav aria-label="手动修图分类" className="lm-adjust-nav">
        {STEPS.map((s) => {
          const active = s.id === step
          return (
            <button
              key={s.id}
              onClick={() => onStep(s.id)}
              disabled={disabled}
              aria-pressed={active}
              className={[
                'lm-adjust-nav-button',
                active
                  ? 'is-active'
                  : '',
              ].join(' ')}
            >
              {s.label}
            </button>
          )
        })}
    </nav>
  )
}
