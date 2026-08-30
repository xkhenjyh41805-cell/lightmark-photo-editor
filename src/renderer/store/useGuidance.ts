import { useCallback, useMemo, useState } from 'react'
import type { StepId, Mastery } from '../guidance'

// 引导状态：当前步骤 + 模式 + 已完成步骤（用于导航打勾）。
// 步骤切换不改参数（参数在 useAdjustments 里独立保存）。
export function useGuidance() {
  const [step, setStep] = useState<StepId>('basic')
  const [mastery, setMastery] = useState<Mastery>('novice')
  const [done, setDone] = useState<Set<StepId>>(new Set())

  const goStep = useCallback(
    (id: StepId) => {
      // 离开当前步骤时标记为已完成（但不标记成"调过"，只是"看过"）
      setDone((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
      setStep(id)
    },
    [],
  )

  const isDone = useCallback((id: StepId) => done.has(id), [done])

  return useMemo(
    () => ({ step, mastery, done, goStep, setMastery, isDone }),
    [step, mastery, done, goStep, isDone],
  )
}
