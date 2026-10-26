import {
  clonePhotoAdjust,
  HSL_COLOR_IDS,
  isMaskAgentAvailable,
  localMaskDisplayName,
  type AdjustParams,
  type HslColorId,
  type PhotoAdjust,
} from '../image/index.ts'

export const MAX_PLAN_STEPS = 8
export const MAX_PARAMETER_WRITES = 12

const GLOBAL_PARAM_KEYS: readonly (keyof AdjustParams)[] = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'saturation',
  'vibrance',
  'sharpness',
  'noiseReduction',
  'temperature',
  'tint',
]

const GLOBAL_PARAM_LABELS: Record<keyof AdjustParams, string> = {
  exposure: '曝光',
  contrast: '对比度',
  highlights: '高光',
  shadows: '阴影',
  whites: '白色',
  blacks: '黑色',
  saturation: '饱和度',
  vibrance: '自然饱和度',
  sharpness: '锐化',
  noiseReduction: '降噪',
  temperature: '色温',
  tint: '色调',
}

/** 当前局部像素管线不会做局部锐化／降噪，不能将这些无效参数暴露给 Agent。 */
const LOCAL_MASK_PARAM_KEYS: readonly (keyof AdjustParams)[] = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'saturation', 'vibrance', 'temperature', 'tint',
]

const HSL_COLOR_LABELS: Record<HslColorId, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  green: '绿色',
  cyan: '青色',
  blue: '蓝色',
  purple: '紫色',
  magenta: '洋红',
}

const HSL_AXIS_LABELS = {
  hue: '色相',
  saturation: '饱和度',
  luminance: '明度',
} as const

export interface AdjustGlobalStep {
  tool: 'adjust_global'
  args: Partial<AdjustParams>
  reason: string
}

export interface SetHslStep {
  tool: 'set_hsl'
  args: {
    color: HslColorId
    axis: 'hue' | 'saturation' | 'luminance'
    value: number
  }
  reason: string
}

export interface AdjustMaskStep {
  tool: 'adjust_mask'
  args: { maskId: string } & Partial<Pick<AdjustParams, (typeof LOCAL_MASK_PARAM_KEYS)[number]>>
  reason: string
}

export type EditStep = AdjustGlobalStep | SetHslStep | AdjustMaskStep

export interface EditPlan {
  version: 1
  summary: string
  steps: EditStep[]
}

export type PlanIntent = 'explicit_request' | 'proactive_suggestion'
export type PlanScope = 'any' | 'local_only'

export type EditPlanValidation =
  | { ok: true; plan: EditPlan }
  | { ok: false; error: string }

export type ParameterChange = {
  path: string
  label: string
  before: number
  after: number
  reason: string
}

export type PlanPreparation =
  | { status: 'invalid'; error: string }
  | { status: 'awaiting_confirmation'; plan: EditPlan }
  | {
      status: 'ready'
      plan: EditPlan
      next: PhotoAdjust
      changes: ParameterChange[]
    }

export interface PlanGate {
  intent: PlanIntent
  confirmed?: boolean
  scope?: PlanScope
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function validMaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
}

function parameterRange(key: keyof AdjustParams): { min: number; max: number } {
  if (key === 'sharpness' || key === 'noiseReduction') return { min: 0, max: 100 }
  return { min: -100, max: 100 }
}

/**
 * Validate untrusted JSON as a tiny allowlisted EditPlan.
 * The selected photo id is deliberately not part of the model-facing schema;
 * the application chooses the target photo outside the plan.
 */
export function validateEditPlan(raw: unknown): EditPlanValidation {
  if (!isPlainRecord(raw)) return { ok: false, error: '计划必须是 JSON 对象。' }
  if (!hasOnlyKeys(raw, ['version', 'summary', 'steps'])) {
    return { ok: false, error: '计划包含未允许的顶层字段。' }
  }
  if (raw.version !== 1) return { ok: false, error: '不支持的计划版本。' }
  if (!validText(raw.summary, 160)) return { ok: false, error: '计划摘要不能为空且不能超过 160 个字符。' }
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_PLAN_STEPS) {
    return { ok: false, error: `计划步骤必须为 1 到 ${MAX_PLAN_STEPS} 步。` }
  }

  const seenWrites = new Set<string>()
  const steps: EditStep[] = []
  let writeCount = 0

  for (let index = 0; index < raw.steps.length; index++) {
    const step = raw.steps[index]
    if (!isPlainRecord(step) || !hasOnlyKeys(step, ['tool', 'args', 'reason'])) {
      return { ok: false, error: `第 ${index + 1} 步包含未允许的字段或格式无效。` }
    }
    if (!validText(step.reason, 240)) {
      return { ok: false, error: `第 ${index + 1} 步必须提供不超过 240 个字符的原因。` }
    }
    if (!isPlainRecord(step.args)) {
      return { ok: false, error: `第 ${index + 1} 步参数必须是 JSON 对象。` }
    }

    if (step.tool === 'adjust_global') {
      if (!hasOnlyKeys(step.args, GLOBAL_PARAM_KEYS) || Object.keys(step.args).length === 0) {
        const unknown = Object.keys(step.args).filter((key) => !GLOBAL_PARAM_KEYS.includes(key as keyof AdjustParams))
        return { ok: false, error: unknown.length
          ? `第 ${index + 1} 步含有未支持的全局参数：${unknown.join('、')}。分色调整请使用 set_hsl；未执行任何修改。`
          : `第 ${index + 1} 步全局参数为空；未执行任何修改。` }
      }
      const args: Partial<AdjustParams> = {}
      for (const rawKey of Object.keys(step.args)) {
        const key = rawKey as keyof AdjustParams
        const value = step.args[rawKey]
        const range = parameterRange(key)
        if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
          return {
            ok: false,
            error: `${GLOBAL_PARAM_LABELS[key]}必须是 ${range.min} 到 ${range.max} 之间的有限数值。`,
          }
        }
        const writeKey = `global.${key}`
        if (seenWrites.has(writeKey)) return { ok: false, error: `计划重复修改了${GLOBAL_PARAM_LABELS[key]}。` }
        seenWrites.add(writeKey)
        args[key] = value
        writeCount++
      }
      steps.push({ tool: 'adjust_global', args, reason: step.reason.trim() })
    } else if (step.tool === 'set_hsl') {
      if (!hasOnlyKeys(step.args, ['color', 'axis', 'value']) || Object.keys(step.args).length !== 3) {
        return { ok: false, error: `第 ${index + 1} 步的 HSL 参数格式无效。` }
      }
      const color = step.args.color
      const axis = step.args.axis
      const value = step.args.value
      if (typeof color !== 'string' || !HSL_COLOR_IDS.includes(color as HslColorId)) {
        return { ok: false, error: `第 ${index + 1} 步的 HSL 颜色段无效。` }
      }
      if (axis !== 'hue' && axis !== 'saturation' && axis !== 'luminance') {
        return { ok: false, error: `第 ${index + 1} 步的 HSL 轴无效。` }
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100) {
        return { ok: false, error: 'HSL 参数必须是 -100 到 100 之间的有限数值。' }
      }
      const writeKey = `hsl.${color}.${axis}`
      if (seenWrites.has(writeKey)) {
        return { ok: false, error: `计划重复修改了${HSL_COLOR_LABELS[color as HslColorId]}${HSL_AXIS_LABELS[axis]}。` }
      }
      seenWrites.add(writeKey)
      writeCount++
      steps.push({
        tool: 'set_hsl',
        args: { color: color as HslColorId, axis, value },
        reason: step.reason.trim(),
      })
    } else if (step.tool === 'adjust_mask') {
      if (!hasOnlyKeys(step.args, ['maskId', ...LOCAL_MASK_PARAM_KEYS]) || Object.keys(step.args).length < 2) {
        const unknown = Object.keys(step.args).filter((key) => key !== 'maskId' && !LOCAL_MASK_PARAM_KEYS.includes(key as keyof AdjustParams))
        return {
          ok: false,
          error: unknown.length
            ? `第 ${index + 1} 步含有未支持的局部参数：${unknown.join('、')}。局部锐化和降噪暂不支持。`
            : `第 ${index + 1} 步必须指定蒙版 ID 和至少一个局部参数。`,
        }
      }
      const maskId = step.args.maskId
      if (!validMaskId(maskId)) return { ok: false, error: `第 ${index + 1} 步的蒙版 ID 无效。` }
      const args: AdjustMaskStep['args'] = { maskId }
      for (const rawKey of Object.keys(step.args)) {
        if (rawKey === 'maskId') continue
        const key = rawKey as (typeof LOCAL_MASK_PARAM_KEYS)[number]
        const value = step.args[rawKey]
        const range = parameterRange(key)
        if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
          return { ok: false, error: `局部${GLOBAL_PARAM_LABELS[key]}必须是 ${range.min} 到 ${range.max} 之间的有限数值。` }
        }
        const writeKey = `mask.${maskId}.${key}`
        if (seenWrites.has(writeKey)) return { ok: false, error: `计划重复修改了同一蒙版的${GLOBAL_PARAM_LABELS[key]}。` }
        seenWrites.add(writeKey)
        args[key] = value
        writeCount++
      }
      steps.push({ tool: 'adjust_mask', args, reason: step.reason.trim() })
    } else {
      return { ok: false, error: `不允许调用工具“${String(step.tool)}”。` }
    }

    if (writeCount > MAX_PARAMETER_WRITES) {
      return { ok: false, error: `单次计划最多修改 ${MAX_PARAMETER_WRITES} 个参数。` }
    }
  }

  return {
    ok: true,
    plan: { version: 1, summary: raw.summary.trim(), steps },
  }
}

/**
 * Prepare a complete candidate without mutating current state.
 * Proactive suggestions remain inert until the application supplies confirmed=true.
 */
export function prepareEditPlan(
  raw: unknown,
  current: PhotoAdjust,
  gate: PlanGate,
): PlanPreparation {
  const validation = validateEditPlan(raw)
  if (!validation.ok) return { status: 'invalid', error: validation.error }

  if (gate.scope === 'local_only' && validation.plan.steps.some((step) => step.tool !== 'adjust_mask')) {
    return { status: 'invalid', error: '当前指令明确要求局部区域；计划只能使用已命名蒙版的 adjust_mask，不能降级为全图调整。请先创建并命名对应蒙版，或明确说明要调全图。' }
  }
  if (gate.scope === 'local_only' && !validation.plan.steps.some((step) => step.tool === 'adjust_mask')) {
    return { status: 'invalid', error: '当前指令明确要求局部区域，但计划没有引用可用蒙版；未执行任何修改。' }
  }

  if (gate.intent === 'proactive_suggestion' && gate.confirmed !== true) {
    return { status: 'awaiting_confirmation', plan: validation.plan }
  }

  const next = clonePhotoAdjust(current)
  const changes: ParameterChange[] = []

  for (const step of validation.plan.steps) {
    if (step.tool === 'adjust_global') {
      for (const key of Object.keys(step.args) as (keyof AdjustParams)[]) {
        const before = next.global[key]
        const after = step.args[key]!
        if (before === after) continue
        next.global[key] = after
        changes.push({
          path: `global.${key}`,
          label: GLOBAL_PARAM_LABELS[key],
          before,
          after,
          reason: step.reason,
        })
      }
    } else if (step.tool === 'set_hsl') {
      const { color, axis, value } = step.args
      const before = next.hsl[color][axis]
      if (before === value) continue
      next.hsl[color] = { ...next.hsl[color], [axis]: value }
      changes.push({
        path: `hsl.${color}.${axis}`,
        label: `${HSL_COLOR_LABELS[color]}${HSL_AXIS_LABELS[axis]}`,
        before,
        after: value,
        reason: step.reason,
      })
    } else {
      const mask = next.masks.find((candidate) => candidate.id === step.args.maskId)
      if (!mask) return { status: 'invalid', error: '计划引用的蒙版不存在或属于其他照片；未执行任何修改。' }
      if (!mask.enabled) return { status: 'invalid', error: `蒙版“${localMaskDisplayName(mask)}”当前已关闭；请启用后重新分析。` }
      if (!mask.name?.trim()) return { status: 'invalid', error: '计划引用的蒙版尚未命名；请在局部调整中命名后重新分析。' }
      if (!isMaskAgentAvailable(mask)) return { status: 'invalid', error: `蒙版“${localMaskDisplayName(mask)}”仍是待确认候选；请先在局部调整中检查并采纳后重新分析。` }
      for (const key of LOCAL_MASK_PARAM_KEYS) {
        const value = step.args[key]
        if (value === undefined) continue
        const before = mask.adjust[key]
        if (before === value) continue
        mask.adjust[key] = value
        changes.push({
          path: `masks.${mask.id}.adjust.${key}`,
          label: `${localMaskDisplayName(mask)} · ${GLOBAL_PARAM_LABELS[key]}`,
          before,
          after: value,
          reason: step.reason,
        })
      }
    }
  }

  return { status: 'ready', plan: validation.plan, next, changes }
}
