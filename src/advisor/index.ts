// 规则建议引擎 —— 阶段 3 用写死的规则给提示。
// 将来换真 AI 只改这里，UI 不动。
// 阶段 5.3：HSL 分色建议暂未接入，可选后续（如肤色偏红→降红饱和）。
//
// 输入：调整后图像的直方图 + 当前参数
// 输出：按优先级排序的建议列表（每条一句话 + 严重程度）
//
// 这是对"AI 给建议、人来调"理念的第一次落地：
// 引擎只判断"出了什么问题"，不给具体参数值，让人决定怎么改。

import type { AdjustParams, Histogram } from '../image'

export type AdviceLevel = 'warn' | 'tip' | 'ok'

export interface Advice {
  id: string
  level: AdviceLevel      // warn=红、tip=黄、ok=绿
  text: string            // 一句话
  step?: StepId           // 关联到哪一步（用于"去这里调"导航）
}

export type StepId =
  | 'basic'
  | 'tone'
  | 'color'
  | 'detail'
  | 'wb'

// 判断直方图左端是否死黑堆积
function endClip(hist: Uint32Array, total: number, buckets = 3): number {
  if (total === 0) return 0
  let sum = 0
  for (let i = 0; i < buckets; i++) sum += hist[i]
  return sum / total
}
// 判断直方图右端是否高光裁切
function startClip(hist: Uint32Array, total: number, buckets = 3): number {
  if (total === 0) return 0
  let sum = 0
  for (let i = 256 - buckets; i < 256; i++) sum += hist[i]
  return sum / total
}

function totalOf(h: Histogram): number {
  let s = 0
  for (let i = 0; i < 256; i++) s += h.g[i]
  return s
}

// 主入口：综合直方图 + 参数给建议
export function advise(
  hist: Histogram | null,
  params: AdjustParams,
): Advice[] {
  if (!hist) return []

  const total = totalOf(hist)
  const advices: Advice[] = []

  // 高光裁切：最右 3 桶占比 > 5% 算溢出
  const hiClip = startClip(hist.g, total)
  if (hiClip > 0.05) {
    advices.push({
      id: 'highlight-clip',
      level: 'warn',
      text: '高光溢出，亮部细节丢失。试试降低高光或白色。',
      step: 'tone',
    })
  }

  // 死黑：最左 3 桶占比过高
  const loClip = endClip(hist.g, total)
  if (loClip > 0.05) {
    advices.push({
      id: 'shadow-clip',
      level: 'warn',
      text: '暗部死黑，阴影细节丢失。试试提亮阴影或黑色。',
      step: 'tone',
    })
  }

  // 整体偏暗/偏亮（均值）
  let mean = 0
  for (let i = 0; i < 256; i++) mean += i * hist.g[i]
  mean = total > 0 ? mean / total : 128
  if (mean < 60) {
    advices.push({
      id: 'too-dark',
      level: 'tip',
      text: '画面整体偏暗，可以适当加曝光。',
      step: 'basic',
    })
  } else if (mean > 200) {
    advices.push({
      id: 'too-bright',
      level: 'tip',
      text: '画面整体偏亮，可以适当减曝光。',
      step: 'basic',
    })
  }

  // 饱和度过高（看参数本身）
  if (params.saturation > 70) {
    advices.push({
      id: 'over-saturated',
      level: 'tip',
      text: '饱和度偏高，色彩可能失真。自然饱和度对肤色更友好。',
      step: 'color',
    })
  }

  // 锐化过度
  if (params.sharpness > 80) {
    advices.push({
      id: 'over-sharpened',
      level: 'tip',
      text: '锐化偏强，可能出现噪点或边缘发硬。',
      step: 'detail',
    })
  }

  // 色温极端
  if (Math.abs(params.temperature) > 70) {
    advices.push({
      id: 'extreme-temp',
      level: 'tip',
      text: '色温偏移较大，确认是不是你想要的冷暖效果。',
      step: 'wb',
    })
  }

  // 没问题时的正向反馈
  if (advices.length === 0) {
    advices.push({
      id: 'all-good',
      level: 'ok',
      text: '影调分布均衡，没有明显溢出。继续下一步。',
    })
  }

  const order: Record<AdviceLevel, number> = { warn: 0, tip: 1, ok: 2 }
  advices.sort((a, b) => order[a.level] - order[b.level])
  return advices
}
