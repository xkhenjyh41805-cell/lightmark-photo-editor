// 阶段 5.4：修图预设
//
// 设计要点（与用户确认）：
// - 预设只存 global（12 滑块）+ hsl（8 色分色），不存 masks（局部滤镜）。
//   套用预设时保留目标照片已有的局部滤镜，符合「风格预设」直觉，
//   不会用一张图的蒙版去盖另一张图（蒙版是针对具体画面的，不该跨照片复用）。
// - 预设分两类：
//   · builtin：写死在代码里的常见风格，不可删除，不写入磁盘。
//   · user：用户把当前调整存成的命名预设，落盘到 presets.json，可删除。
// - 复用 image 模块的类型（AdjustParams / HslParams），不重复定义。

import type { AdjustParams, HslParams } from '../image'
import { DEFAULT_PARAMS, DEFAULT_HSL } from '../image'

// 一个预设的「调图内容」：global + hsl（不含 masks）
export interface PresetAdjust {
  global: AdjustParams
  hsl: HslParams
}

export type PresetKind = 'builtin' | 'user'

export interface Preset {
  id: string          // builtin 用固定 id；user 用 'user-<时间戳36>-<序号>'
  name: string
  kind: PresetKind
  desc?: string
  adjust: PresetAdjust
}

// ---- 内置预设：3 个常见风格，写死参数 ----
// 参数是凭经验定的「大致像那么回事」的起点，用户套上后还会自己微调。
// id 用 'builtin-' 前缀，与 user 预设 id 永不冲突。

// 日系低饱和：轻微提亮、降对比、降饱和、稍偏青冷
const BUILTIN_JAPANESE: Preset = {
  id: 'builtin-japanese',
  name: '日系低饱和',
  kind: 'builtin',
  desc: '提亮、降对比、降饱和，偏清淡',
  adjust: {
    global: {
      exposure: 8,
      contrast: -18,
      highlights: -10,
      shadows: 15,
      whites: 0,
      blacks: 5,
      saturation: -22,
      vibrance: -8,
      sharpness: 10,
      noiseReduction: 8,
      temperature: -8,
      tint: 0,
    },
    hsl: { ...DEFAULT_HSL },
  },
}

// 胶片暖色：压高光、提阴影、暖色温、略加饱和
const BUILTIN_FILM: Preset = {
  id: 'builtin-film',
  name: '胶片暖色',
  kind: 'builtin',
  desc: '影调柔和、偏暖、有质感',
  adjust: {
    global: {
      exposure: 4,
      contrast: -8,
      highlights: -20,
      shadows: 22,
      whites: -6,
      blacks: -8,
      saturation: 6,
      vibrance: 12,
      sharpness: 6,
      noiseReduction: 6,
      temperature: 16,
      tint: 4,
    },
    hsl: { ...DEFAULT_HSL },
  },
}

// 黑白：去饱和到 0（用 saturation 全降），稍提对比
const BUILTIN_MONO: Preset = {
  id: 'builtin-mono',
  name: '黑白',
  kind: 'builtin',
  desc: '全去饱和 + 提对比',
  adjust: {
    global: {
      exposure: 0,
      contrast: 18,
      highlights: -12,
      shadows: 14,
      whites: 0,
      blacks: -6,
      saturation: -100,
      vibrance: 0,
      sharpness: 12,
      noiseReduction: 6,
      temperature: 0,
      tint: 0,
    },
    hsl: { ...DEFAULT_HSL },
  },
}

// 清新提亮：整体提亮提饱和，适合阴天发灰的照片
const BUILTIN_FRESH: Preset = {
  id: 'builtin-fresh',
  name: '清新提亮',
  kind: 'builtin',
  desc: '提亮、提饱和，去灰',
  adjust: {
    global: {
      exposure: 12,
      contrast: 10,
      highlights: -8,
      shadows: 18,
      whites: 4,
      blacks: 0,
      saturation: 10,
      vibrance: 18,
      sharpness: 8,
      noiseReduction: 4,
      temperature: 4,
      tint: 0,
    },
    hsl: { ...DEFAULT_HSL },
  },
}

export const BUILTIN_PRESETS: Preset[] = [
  BUILTIN_JAPANESE,
  BUILTIN_FILM,
  BUILTIN_MONO,
  BUILTIN_FRESH,
]

// 把「当前照片的 global + hsl」打包成一个可保存的 PresetAdjust。
// 注意：调用方传进来的应该是已经规范化的 AdjustParams / HslParams（深拷贝后存，避免引用共享）。
export function makePresetAdjust(global: AdjustParams, hsl: HslParams): PresetAdjust {
  return {
    global: { ...global },
    hsl: {
      red: { ...hsl.red },
      orange: { ...hsl.orange },
      yellow: { ...hsl.yellow },
      green: { ...hsl.green },
      cyan: { ...hsl.cyan },
      blue: { ...hsl.blue },
      purple: { ...hsl.purple },
      magenta: { ...hsl.magenta },
    },
  }
}

// presets.json 落盘结构：{ version, presets: Preset[] }
export interface PresetsFile {
  version: number
  presets: Preset[]
}

// 生成 user 预设 id（与 useAdjustments 的 maskSeq 风格一致）
let presetSeq = 0
export function newPresetId(): string {
  presetSeq += 1
  // 渲染进程里 new Date() 可用（与 image 模块无关）
  return `user-${Date.now().toString(36)}-${presetSeq}`
}

// 把从磁盘读回的任意 presets.json 规整成 Preset[]（容错：丢掉结构不对的项）
export function normalizePresetList(raw: unknown): Preset[] {
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  const arr = obj.presets
  if (!Array.isArray(arr)) return []
  const out: Preset[] = []
  for (const item of arr) {
    const p = normalizePreset(item)
    if (p) out.push(p)
  }
  return out
}

// 单个预设容错解析：缺字段/类型错返回 null
function normalizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id : null
  const name = typeof obj.name === 'string' ? obj.name : null
  if (!id || !name) return null
  const adjust = normalizePresetAdjust(obj.adjust)
  if (!adjust) return null
  return {
    id,
    name,
    kind: obj.kind === 'builtin' ? 'builtin' : 'user',
    desc: typeof obj.desc === 'string' ? obj.desc : undefined,
    adjust,
  }
}

function normalizePresetAdjust(raw: unknown): PresetAdjust | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const g = obj.global
  const h = obj.hsl
  if (!g || typeof g !== 'object') return null
  // global：逐键取数字，缺失补 0
  const global: AdjustParams = { ...DEFAULT_PARAMS }
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof AdjustParams)[]) {
    const v = (g as Record<string, unknown>)[k]
    if (typeof v === 'number') global[k] = v
  }
  // hsl：用 image 模块的 normalizeHsl 容错
  // 这里不直接 import normalizeHsl 是为了避免循环依赖风险，手写一遍同逻辑。
  // hsl 缺失或结构错时用 DEFAULT_HSL。
  const hsl: HslParams = {
    red: { ...DEFAULT_HSL.red },
    orange: { ...DEFAULT_HSL.orange },
    yellow: { ...DEFAULT_HSL.yellow },
    green: { ...DEFAULT_HSL.green },
    cyan: { ...DEFAULT_HSL.cyan },
    blue: { ...DEFAULT_HSL.blue },
    purple: { ...DEFAULT_HSL.purple },
    magenta: { ...DEFAULT_HSL.magenta },
  }
  if (h && typeof h === 'object') {
    const ho = h as Record<string, unknown>
    const ids: (keyof HslParams)[] = [
      'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta',
    ]
    for (const id of ids) {
      const c = ho[id]
      if (!c || typeof c !== 'object') continue
      const co = c as Record<string, unknown>
      hsl[id] = {
        hue: typeof co.hue === 'number' ? clamp100(co.hue) : 0,
        saturation: typeof co.saturation === 'number' ? clamp100(co.saturation) : 0,
        luminance: typeof co.luminance === 'number' ? clamp100(co.luminance) : 0,
      }
    }
  }
  return { global, hsl }
}

function clamp100(v: number): number {
  return v < -100 ? -100 : v > 100 ? 100 : v
}
