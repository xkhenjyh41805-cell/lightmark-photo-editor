// 阶段 5.3 HSL 分色调色验证脚本（不依赖测试框架，node --experimental-strip-types 跑）
// 跑法：node --experimental-strip-types src/image/__tests__/hsl.test.ts
//
// 断言：
// 1. 默认 HSL = 恒等
// 2. 灰像素不受 HSL 影响
// 3. 纯红 + red.saturation=-100 → 接近灰
// 4. 纯蓝 + blue.hue=+100 → 不再纯蓝
// 5. 纯绿 + green.hue=-100 → 向黄偏（R 升高）
// 6. normalizeHsl 向后兼容
// 7. applyWithMasks 空 masks + hsl == applyAdjustments + hsl
// 8. mask 路径 HSL-free 不变量

import {
  applyAdjustments,
  applyWithMasks,
  DEFAULT_PARAMS,
  DEFAULT_HSL,
  normalizeHsl,
  type HslParams,
  type HslColorAdjust,
  type LocalMask,
  type ImageBuf,
} from '../index.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error('  ✗ FAIL:', msg)
  }
}
function approx(a: number, b: number, eps = 0.02) {
  return Math.abs(a - b) < eps
}

// 纯灰图
function grayImg(w: number, h: number, v = 128): ImageBuf {
  return solidImg(w, h, v, v, v)
}
// 纯色图
function solidImg(w: number, h: number, r: number, g: number, b: number): ImageBuf {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return { width: w, height: h, data }
}

function cloneHsl(patch: Partial<Record<keyof HslParams, Partial<HslColorAdjust>>>): HslParams {
  const out: HslParams = { ...DEFAULT_HSL }
  for (const k of Object.keys(patch) as (keyof HslParams)[]) {
    out[k] = { ...DEFAULT_HSL[k], ...patch[k] }
  }
  return out
}

console.log('— 默认 HSL = 恒等 —')
{
  const img = grayImg(8, 8, 100)
  const a = applyAdjustments(img, DEFAULT_PARAMS)
  const b = applyAdjustments(img, DEFAULT_PARAMS, DEFAULT_HSL)
  let eq = true
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) { eq = false; break }
  }
  assert(eq, '不传 hsl 与传 DEFAULT_HSL 像素相等')
}

console.log('— 灰像素不受 HSL 影响 —')
{
  const img = grayImg(8, 8, 128)
  const hsl = cloneHsl({ red: { hue: 100, saturation: -100, luminance: 50 } })
  const out = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  let all128 = true
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i] !== 128 || out.data[i + 1] !== 128 || out.data[i + 2] !== 128) {
      all128 = false
      break
    }
  }
  assert(all128, '灰像素受 HSL 调整后仍为 128')
}

console.log('— 纯红 + red.saturation=-100 → 接近灰 —')
{
  const img = solidImg(8, 8, 255, 0, 0)
  const hsl = cloneHsl({ red: { saturation: -100 } })
  const out = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  const r = out.data[0], g = out.data[1], b = out.data[2]
  assert(Math.abs(r - g) < 30 && Math.abs(r - b) < 30, `红应明显去饱和，RGB=${r},${g},${b}`)
  // 强约束：饱和度应大幅下降。纯红 s=1，去饱和后 s 应降到 0.15 以下
  assert(g > r * 0.6, `红去饱和后 G 应接近 R，G=${g} R=${r}`)
}

console.log('— 纯蓝 + blue.hue=+100 → 不再纯蓝 —')
{
  const img = solidImg(8, 8, 0, 0, 255)
  const hsl = cloneHsl({ blue: { hue: 100 } })
  const out = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  const r = out.data[0], g = out.data[1], b = out.data[2]
  assert(b < 255 || r > 20 || g > 20, `蓝应偏移色相，RGB=${r},${g},${b}`)
}

console.log('— 纯绿 + green.hue=-100 → R 升高（向黄偏）—')
{
  const img = solidImg(8, 8, 0, 255, 0)
  const hsl = cloneHsl({ green: { hue: -100 } })
  const out = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  const r = out.data[0]
  assert(r > 30, `绿向黄偏后 R 应升高，R=${r}`)
}

console.log('— normalizeHsl 向后兼容 —')
{
  const d = normalizeHsl(undefined)
  let allZero = true
  for (const id of Object.keys(d) as (keyof HslParams)[]) {
    if (d[id].hue !== 0 || d[id].saturation !== 0 || d[id].luminance !== 0) {
      allZero = false
      break
    }
  }
  assert(allZero, 'undefined → DEFAULT_HSL')

  const part = normalizeHsl({ red: { hue: 50 } })
  assert(
    part.red.hue === 50 && part.red.saturation === 0 && part.red.luminance === 0,
    '部分字段补 0',
  )

  const unk = normalizeHsl({ bogus: { hue: 99 } })
  assert(unk.red.hue === 0, '未知 key 被忽略')

  const clamped = normalizeHsl({ red: { hue: 999 } })
  assert(clamped.red.hue === 100, '超范围 clamp 到 100')
}

console.log('— applyWithMasks 空 masks + hsl == applyAdjustments + hsl —')
{
  const img = solidImg(10, 10, 200, 80, 40)
  const hsl = cloneHsl({ orange: { saturation: -50, hue: 20 } })
  const a = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  const b = applyWithMasks(img, DEFAULT_PARAMS, [], hsl)
  let eq = true
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) { eq = false; break }
  }
  assert(eq, '空 masks 时 applyWithMasks == applyAdjustments（含 hsl）')
}

console.log('— mask 路径 HSL-free 不变量 —')
{
  const img = solidImg(100, 100, 180, 60, 60) // 偏红
  const hsl = cloneHsl({ red: { saturation: -80 } })
  const mask: LocalMask = {
    id: 'm1',
    enabled: true,
    geom: {
      type: 'radial',
      cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3,
      rotation: 0, feather: 0.1, invert: false,
    },
    adjust: { ...DEFAULT_PARAMS, exposure: 50 },
  }
  const result = applyWithMasks(img, DEFAULT_PARAMS, [mask], hsl)

  // 手算圆心像素：base（含 hsl）按权重 w 与 局部结果（applyPixel 原图，无 hsl）混合
  const w = 1 // 圆心权重≈1（圈内）
  // base 像素 = applyAdjustments 全局+hsl 在该像素的值
  const baseBuf = applyAdjustments(img, DEFAULT_PARAMS, hsl)
  const baseIdx = (50 * 100 + 50) * 4
  const baseR = baseBuf.data[baseIdx]

  // 局部结果 = 原图像素套 mask.adjust（applyPixel，无 hsl）
  const localBuf = applyAdjustments(img, mask.adjust)
  const localR = localBuf.data[baseIdx]

  const expectR = baseR * (1 - w) + localR * w
  const r = result.data[baseIdx]
  assert(approx(r, expectR, 2), `mask 圆心混合值=base*(1-w)+local*w，实际 ${r} 期望 ${expectR.toFixed(2)}`)

  // 关键不变量：mask 路径不碰 hsl。w=1 时圆心 == 局部结果（无 hsl），与是否传 hsl 无关。
  const noHslResult = applyWithMasks(img, DEFAULT_PARAMS, [mask])
  const noHslR = noHslResult.data[baseIdx]
  assert(approx(noHslR, localR, 2), '不传 hsl 时 mask 圆心 == 局部结果（无 hsl）')
  assert(approx(r, localR, 2), `带 hsl 时 mask 圆心(w=1)仍 == 局部结果，实际 ${r} 局部 ${localR}`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
