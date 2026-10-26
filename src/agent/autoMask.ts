export type AutomaticMaskTarget = 'sky'

export interface SemanticMaskDescriptor {
  id: string
  name: string
}

const SKY_TARGET_PATTERN = /(天空|蓝天|云层|云彩|云朵|sky)/i
const SKY_MASK_NAME_PATTERN = /(天空|蓝天|sky)/i

/**
 * 仅识别已有本地分割工具实际支持的明确目标。
 * 其他局部目标仍必须复用用户已有蒙版或向用户澄清，不能假装可以自动选区。
 */
export function inferAutomaticMaskTarget(prompt: string): AutomaticMaskTarget | null {
  return SKY_TARGET_PATTERN.test(prompt) ? 'sky' : null
}

export function findExistingMaskForTarget<T extends SemanticMaskDescriptor>(
  masks: readonly T[],
  target: AutomaticMaskTarget,
): T | undefined {
  if (target === 'sky') return masks.find((mask) => SKY_MASK_NAME_PATTERN.test(mask.name.trim()))
  return undefined
}

export function automaticMaskLabel(target: AutomaticMaskTarget): string {
  return target === 'sky' ? '天空' : target
}
