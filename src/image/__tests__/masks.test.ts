// 阶段 5.2 局部调整验证脚本（不依赖测试框架，node --experimental-strip-types 跑）
// 跑法：node --experimental-strip-types src/image/__tests__/masks.test.ts
//
// 断言：
// 1. 渐变蒙版：上方权重≈1、下方≈0、中间过渡
// 2. 径向蒙版：圈内≈1、圈外≈0、invert 取反
// 3. applyWithMasks：蒙版区按局部参数变、非蒙版区不变、边界平滑

import {
  buildMask,
  applyWithMasks,
  applyAdjustments,
  DEFAULT_PARAMS,
  encodeRasterMaskData,
  type GradientGeom,
  type RadialGeom,
  type BrushGeom,
  type RasterGeom,
  type BrushStroke,
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

// 构造一张 100x100 的纯灰图（RGB=128）
function grayImg(w: number, h: number, v = 128): ImageBuf {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = 255
  }
  return { width: w, height: h, data }
}

console.log('— 渐变蒙版 —')
{
  // angle=0：从上往下渐变，上方绿(1)下方红(0)，中心在 0.5
  const g: GradientGeom = {
    type: 'gradient',
    cx: 0.5,
    cy: 0.5,
    angle: 0,
    range: 0.5, // 半宽 0.5 倍对角线
    feather: 1,
  }
  const m = buildMask(g, 100, 100)
  // 顶部中间像素权重应接近 1
  assert(approx(m[5], 1, 0.15), `顶部权重应≈1，实际 ${m[5].toFixed(3)}`)
  // 底部中间像素权重应接近 0
  assert(approx(m[99 * 100 + 50], 0, 0.15), `底部权重应≈0，实际 ${m[99 * 100 + 50].toFixed(3)}`)
  // 正中权重应≈0.5
  assert(approx(m[50 * 100 + 50], 0.5, 0.15), `中心权重应≈0.5，实际 ${m[50 * 100 + 50].toFixed(3)}`)
  // 权重在 [0,1]
  let inRange = true
  for (let i = 0; i < m.length; i++) {
    if (m[i] < -0.001 || m[i] > 1.001) { inRange = false; break }
  }
  assert(inRange, '所有权重在 [0,1]')
}

console.log('— 径向蒙版 —')
{
  const r: RadialGeom = {
    type: 'radial',
    cx: 0.5,
    cy: 0.5,
    rx: 0.3,
    ry: 0.3,
    rotation: 0,
    feather: 0.2,
    invert: false,
  }
  const m = buildMask(r, 100, 100)
  // 圆心权重≈1
  assert(approx(m[50 * 100 + 50], 1, 0.05), `圆心权重应≈1，实际 ${m[50 * 100 + 50].toFixed(3)}`)
  // 远离圆心的角点权重≈0
  assert(approx(m[0], 0, 0.05), `角点权重应≈0，实际 ${m[0].toFixed(3)}`)
  // invert 取反
  const rInv = { ...r, invert: true }
  const mInv = buildMask(rInv, 100, 100)
  assert(approx(mInv[50 * 100 + 50], 0, 0.05), `invert 后圆心权重应≈0，实际 ${mInv[50 * 100 + 50].toFixed(3)}`)
  assert(approx(mInv[0], 1, 0.05), `invert 后角点权重应≈1，实际 ${mInv[0].toFixed(3)}`)
}

console.log('— applyWithMasks：无局部滤镜 = 全局结果 —')
{
  const img = grayImg(50, 50)
  const globalParams = { ...DEFAULT_PARAMS, exposure: 30 }
  const base = applyAdjustments(img, globalParams)
  const withMasks = applyWithMasks(img, globalParams, [])
  // 逐像素相等
  let eq = true
  for (let i = 0; i < base.data.length; i++) {
    if (base.data[i] !== withMasks.data[i]) { eq = false; break }
  }
  assert(eq, '空 masks 时 applyWithMasks == applyAdjustments')
}

console.log('— applyWithMasks：局部滤镜只影响蒙版区 —')
{
  const img = grayImg(100, 100, 128)
  const globalParams = { ...DEFAULT_PARAMS } // 全局不调
  // 一个径向滤镜：圆心提亮曝光 +50
  const mask: LocalMask = {
    id: 'm1',
    enabled: true,
    geom: {
      type: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.2,
      ry: 0.2,
      rotation: 0,
      feather: 0.1,
      invert: false,
    } as RadialGeom,
    adjust: { ...DEFAULT_PARAMS, exposure: 50 },
  }
  const result = applyWithMasks(img, globalParams, [mask])

  // 圆心像素应被提亮（>128）
  const centerIdx = (50 * 100 + 50) * 4
  assert(result.data[centerIdx] > 130, `圆心应被提亮，实际 ${result.data[centerIdx]}`)
  // 角点像素应仍是 128（非蒙版区，全局无调整）
  assert(result.data[0] === 128, `角点应不变(128)，实际 ${result.data[0]}`)
}

console.log('— applyWithMasks：disabled 滤镜被忽略 —')
{
  const img = grayImg(40, 40, 128)
  const globalParams = { ...DEFAULT_PARAMS }
  const mask: LocalMask = {
    id: 'm1',
    enabled: false,
    geom: { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, rotation: 0, feather: 0.2, invert: false } as RadialGeom,
    adjust: { ...DEFAULT_PARAMS, exposure: 80 },
  }
  const result = applyWithMasks(img, globalParams, [mask])
  // 没有任何变化（全局不调 + 滤镜禁用）
  let unchanged = true
  for (let i = 0; i < result.data.length; i += 4) {
    if (result.data[i] !== 128) { unchanged = false; break }
  }
  assert(unchanged, 'disabled 滤镜不影响任何像素')
}

console.log('— 笔刷蒙版：绘制笔触盖到权重图 —')
{
  // 一条横跨中心的横向笔触，半径 0.1（相对 100px 图=10px）
  const stroke: BrushStroke = {
    points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
    size: 0.1,
    feather: 0,
    erase: false,
  }
  const g: BrushGeom = { type: 'brush', strokes: [stroke], size: 0.1, feather: 0 }
  const m = buildMask(g, 100, 100)
  // 笔触经过的中心点 (50,50) 权重应≈1
  assert(approx(m[50 * 100 + 50], 1, 0.05), `笔触中心权重应≈1，实际 ${m[50 * 100 + 50].toFixed(3)}`)
  // 离笔触很远的角点 (0,0) 权重应≈0
  assert(approx(m[0], 0, 0.05), `远离笔触的角点权重应≈0，实际 ${m[0].toFixed(3)}`)
  // 笔触正上方一点 (50,30) 距笔触线 20px，半径 10px，应≈0
  assert(approx(m[30 * 100 + 50], 0, 0.05), `笔触外缘上方权重应≈0，实际 ${m[30 * 100 + 50].toFixed(3)}`)
  // 权重在 [0,1]
  let inRange = true
  for (let i = 0; i < m.length; i++) {
    if (m[i] < -0.001 || m[i] > 1.001) { inRange = false; break }
  }
  assert(inRange, '所有权重在 [0,1]')
}

console.log('— 笔刷蒙版：擦除笔触压低权重 —')
{
  // 先画一个大圆盘笔触（覆盖中心），再用擦除笔触挖中间
  const drawStroke: BrushStroke = {
    points: [{ x: 0.5, y: 0.5 }],
    size: 0.4,
    feather: 0,
    erase: false,
  }
  const gDraw: BrushGeom = { type: 'brush', strokes: [drawStroke], size: 0.4, feather: 0 }
  const mDraw = buildMask(gDraw, 100, 100)
  assert(approx(mDraw[50 * 100 + 50], 1, 0.05), `纯绘制中心应≈1，实际 ${mDraw[50 * 100 + 50].toFixed(3)}`)

  // 加一条擦除笔触在中心
  const eraseStroke: BrushStroke = {
    points: [{ x: 0.5, y: 0.5 }],
    size: 0.2,
    feather: 0,
    erase: true,
  }
  const gBoth: BrushGeom = { type: 'brush', strokes: [drawStroke, eraseStroke], size: 0.4, feather: 0 }
  const mBoth = buildMask(gBoth, 100, 100)
  // 中心被擦除后权重应明显低于纯绘制（接近 0）
  assert(mBoth[50 * 100 + 50] < 0.1, `擦除后中心应≈0，实际 ${mBoth[50 * 100 + 50].toFixed(3)}`)
  // 但擦除笔触够不到的边缘（40px 外）应仍是 1
  // (10,10) 距中心约 56px > 40(=0.4*100) → 不在 draw 范围 → 0。换一个：draw 半径 40，(50,15) 距中心 35<40 在draw内，但erase半径20，35>20 不被擦
  assert(approx(mBoth[15 * 100 + 50], 1, 0.1), `擦除范围外的draw区应≈1，实际 ${mBoth[15 * 100 + 50].toFixed(3)}`)
}

console.log('— applyWithMasks：笔刷滤镜只影响涂抹区 —')
{
  const img = grayImg(100, 100, 128)
  const globalParams = { ...DEFAULT_PARAMS }
  // 笔刷在中心涂一小块，提亮曝光 +60
  const mask: LocalMask = {
    id: 'b1',
    enabled: true,
    geom: {
      type: 'brush',
      strokes: [{ points: [{ x: 0.5, y: 0.5 }], size: 0.15, feather: 0, erase: false }],
      size: 0.15,
      feather: 0,
    } as BrushGeom,
    adjust: { ...DEFAULT_PARAMS, exposure: 60 },
  }
  const result = applyWithMasks(img, globalParams, [mask])
  // 中心被提亮
  const centerIdx = (50 * 100 + 50) * 4
  assert(result.data[centerIdx] > 130, `笔刷中心应被提亮，实际 ${result.data[centerIdx]}`)
  // 角点不受影响
  assert(result.data[0] === 128, `角点应不变(128)，实际 ${result.data[0]}`)
}

console.log('— 空笔刷蒙版 = 全权重 0 = 不影响 —')
{
  const g: BrushGeom = { type: 'brush', strokes: [], size: 0.1, feather: 0 }
  const m = buildMask(g, 50, 50)
  let allZero = true
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== 0) { allZero = false; break }
  }
  assert(allZero, '无笔触时全 0')
}

console.log('— 栅格候选蒙版：缩放、笔刷校正和损坏数据隔离 —')
{
  const raw = new Uint8Array(8 * 8)
  // 上半区作为“天空”候选，下面保持 0。
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) raw[y * 8 + x] = 255
  const raster: RasterGeom = {
    type: 'raster', width: 8, height: 8, data: encodeRasterMaskData(raw),
    strokes: [], size: 0.08, feather: 0,
  }
  const scaled = buildMask(raster, 80, 80)
  assert(scaled[10 * 80 + 40] > 0.9, `候选上半区应≈1，实际 ${scaled[10 * 80 + 40].toFixed(3)}`)
  assert(scaled[70 * 80 + 40] < 0.1, `候选下半区应≈0，实际 ${scaled[70 * 80 + 40].toFixed(3)}`)

  const corrected: RasterGeom = {
    ...raster,
    strokes: [
      { points: [{ x: 0.5, y: 0.15 }], size: 0.1, feather: 0, erase: true },
      { points: [{ x: 0.5, y: 0.8 }], size: 0.1, feather: 0, erase: false },
    ],
  }
  const afterCorrection = buildMask(corrected, 80, 80)
  assert(afterCorrection[12 * 80 + 40] < 0.1, '擦除笔触能从候选天空中挖出范围')
  assert(afterCorrection[64 * 80 + 40] > 0.9, '绘制笔触能补充候选之外的范围')

  const mask: LocalMask = {
    id: 'sky-candidate', name: '天空', enabled: true, geom: raster,
    adjust: { ...DEFAULT_PARAMS, highlights: -50 },
  }
  const source = grayImg(80, 80, 220)
  const base = applyWithMasks(source, { ...DEFAULT_PARAMS }, [])
  const edited = applyWithMasks(source, { ...DEFAULT_PARAMS }, [mask])
  assert(edited.data[(10 * 80 + 40) * 4] !== base.data[(10 * 80 + 40) * 4], '栅格候选区域可应用局部传统参数')
  assert(edited.data[(70 * 80 + 40) * 4] === base.data[(70 * 80 + 40) * 4], '候选外像素不受局部参数影响')

  const invalid: RasterGeom = { ...raster, data: 'not-base64-and-not-a-valid-size' }
  const rejected = buildMask(invalid, 80, 80)
  assert(rejected.every((value) => value === 0), '损坏候选数据被隔离为全 0，不影响照片')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
