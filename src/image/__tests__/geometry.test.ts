// 阶段 5.6 几何变换验证脚本（不依赖测试框架，node --experimental-strip-types 跑）
// 跑法：node --experimental-strip-types src/image/__tests__/geometry.test.ts
//
// 测 transformGeometry / processPhoto / normalizeGeometry / clonePhotoAdjust(geometry)。

import {
  transformGeometry,
  processPhoto,
  normalizeGeometry,
  normalizePhotoAdjust,
  clonePhotoAdjust,
  cropInteriorRect,
  isDefaultGeometry,
  DEFAULT_GEOMETRY,
  DEFAULT_PHOTO_ADJUST,
  DEFAULT_PARAMS,
  type Geometry,
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

// 造一张 4x3 的测试图：左上角红 (255,0,0)，右上角绿 (0,255,0)，
// 左下角蓝 (0,0,255)，右下角白 (255,255,255)，中间渐变。
function makeTestImg(w = 4, h = 3): ImageBuf {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = Math.round((x / (w - 1)) * 255)     // R 随 x 增
      data[i + 1] = Math.round((y / (h - 1)) * 255) // G 随 y 增
      data[i + 2] = 0
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

function geo(overrides: Partial<Geometry> = {}): Geometry {
  const g: Geometry = { ...DEFAULT_GEOMETRY, ...overrides }
  g.enabled = !isDefaultGeometry(g)
  return g
}

console.log('— 默认 geometry 恒等 —')
{
  const img = makeTestImg()
  const out = transformGeometry(img, DEFAULT_GEOMETRY)
  assert(out.width === img.width && out.height === img.height, '默认 geometry 尺寸不变')
  assert(out.data === img.data, '默认 geometry 返回原图引用（短路）')
}

console.log('— rotation90=90 顺时针：宽高交换、像素位置正确 —')
{
  const img = makeTestImg(4, 3)
  // R 通道原图：每列同值，列 x 的 R = x/(w-1)*255。
  // 顺时针 90 后输出宽=h=3、高=w=4，原图左列(x=0,R=0)变成输出顶行。
  const out = transformGeometry(img, geo({ rotation90: 90 }))
  assert(out.width === 3 && out.height === 4, '90 旋转宽高交换 (4x3 -> 3x4)')
  // 顶行 (y=0) 三个像素 R 都应是 0（来自原图 x=0 列）
  assert(out.data[(0 * out.width + 0) * 4] === 0, '90 旋转：顶行左 R=0')
  assert(out.data[(0 * out.width + 2) * 4] === 0, '90 旋转：顶行右 R=0')
  // 底行 (y=3) 应是 255（原图 x=3 列）
  assert(out.data[(3 * out.width + 0) * 4] === 255, '90 旋转：底行左 R=255')
  assert(out.data[(3 * out.width + 2) * 4] === 255, '90 旋转：底行右 R=255')
}

console.log('— rotation90=180 等于两次翻转 —')
{
  const img = makeTestImg(4, 3)
  const out = transformGeometry(img, geo({ rotation90: 180 }))
  assert(out.width === 4 && out.height === 3, '180 旋转尺寸不变')
  // 原 (0,0) → (w-1,h-1)=(3,2)
  const di = (2 * out.width + 3) * 4
  assert(out.data[di] === 0, '180 旋转：左上去到右下')
}

console.log('— flipH 水平镜像 —')
{
  const img = makeTestImg(4, 3)
  const out = transformGeometry(img, geo({ flipH: true }))
  assert(out.width === 4 && out.height === 3, 'flipH 尺寸不变')
  // 原 (0,0) R=0 → 镜像后 (3,0)
  assert(out.data[(0 * 4 + 3) * 4] === 0, 'flipH：左上去到右')
  // 原 (3,0) R=255 → (0,0)
  assert(out.data[0] === 255, 'flipH：右去到左')
}

console.log('— flipV 垂直镜像 —')
{
  const img = makeTestImg(4, 3)
  const out = transformGeometry(img, geo({ flipV: true }))
  assert(out.width === 4 && out.height === 3, 'flipV 尺寸不变')
  // 原 (0,0) G=0 → (0,h-1)=(0,2)
  assert(out.data[((2 * 4 + 0) * 4) + 1] === 0, 'flipV：左上去到左下')
}

console.log('— crop 取子区域 —')
{
  const img = makeTestImg(4, 3)
  // 取左上 1/4：x=0,y=0,w=0.5,h=0.5 → 2x2（4*0.5=2, 3*0.5=1.5→2）
  const out = transformGeometry(img, geo({ crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }))
  assert(out.width === 2 && out.height === 2, 'crop 取左上 2x2')
  // 左上角 (0,0) 不变
  assert(out.data[0] === 0, 'crop 左上角像素正确')
}

console.log('— fineAngle 微调旋转留黑角、尺寸变大 —')
{
  const img = makeTestImg(4, 3)
  const out = transformGeometry(img, geo({ fineAngle: 10 }))
  // 旋转后包围盒尺寸应 ≥ 原尺寸
  assert(out.width >= 4 && out.height >= 3, 'fineAngle 后包围盒不小于原图')
  // alpha 全 255（黑角也填实）
  let allOpaque = true
  for (let i = 3; i < out.data.length; i += 4) {
    if (out.data[i] !== 255) { allOpaque = false; break }
  }
  assert(allOpaque, 'fineAngle 黑角 alpha=255')
}

console.log('— fineAngle=0 内接矩形 = 全图 —')
{
  const r = cropInteriorRect(0)
  assert(r.x === 0 && r.y === 0 && r.w === 1 && r.h === 1, 'fineAngle=0 内接矩形全图')
  const r2 = cropInteriorRect(30)
  assert(r2.w < 1 && r2.h < 1, 'fineAngle=30 内接矩形小于全图')
  assert(r2.w > 0 && r2.h > 0, 'fineAngle=30 内接矩形非空')
}

console.log('— fineAngle 非正方形图中心不偏移（cyIn bug 回归） —')
{
  // 造一张 6x2 的图，唯一标记：中心列(2,3)、中心行(第0行)放一个亮黄像素，
  // 其余黑。微调旋转后，原图中心像素应映射到输出中心附近，而不是上下偏移。
  const w = 6, h = 2
  const data = new Uint8ClampedArray(w * h * 4)
  const markX = Math.floor(w / 2) // 3
  const markY = Math.floor(h / 2) // 1
  const mi = (markY * w + markX) * 4
  data[mi] = 255; data[mi + 1] = 255; data[mi + 2] = 0; data[mi + 3] = 255
  const img: ImageBuf = { width: w, height: h, data }
  const out = transformGeometry(img, geo({ fineAngle: 20 }))
  // 找输出图里所有非黑像素，应集中在输出中心附近（容差 1px），
  // 若 cyIn bug 复现，标记会偏到中心上方/下方多个像素。
  const cxOut = out.width / 2
  const cyOut = out.height / 2
  let off = 0
  let count = 0
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 4
      if (out.data[i] > 0 || out.data[i + 1] > 0) {
        off += Math.abs(y - cyOut) + Math.abs(x - cxOut)
        count++
      }
    }
  }
  assert(count > 0, 'fineAngle 非正方形图有非黑像素')
  // 标记像素经旋转扩散，重心应贴近输出中心。cyIn bug 会让 y 方向整体偏移 (w-h)/2=2px。
  const avgDist = off / count
  assert(avgDist < 1.2, `fineAngle 非正方形图标记重心贴近输出中心 (avgDist=${avgDist.toFixed(2)})`)
}

console.log('— rotation90 + crop 顺序：先转再裁 —')
{
  const img = makeTestImg(4, 3)
  // 顺时针90（变 3x4）后取左上 1/4
  const out = transformGeometry(img, geo({
    rotation90: 90,
    crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
  }))
  // 输出应是 3x4 的左上 1/4 = ceil(3*0.5) x ceil(4*0.5) = 2x2
  assert(out.width === 2 && out.height === 2, '先转后裁尺寸正确 (2x2)')
}

console.log('— processPhoto 默认 == applyWithMasks 等价 —')
{
  const img = makeTestImg(4, 3)
  const pa = { ...DEFAULT_PHOTO_ADJUST, global: { ...DEFAULT_PARAMS, exposure: 20 } }
  const out = processPhoto(img, pa)
  assert(out.width === 4 && out.height === 3, 'processPhoto 默认几何尺寸不变')
  // 默认几何短路，走 applyWithMasks。验证它确实应用了调整：
  // 原图 (1,0) R=85，曝光+20 后应 > 85
  assert(out.data[(0 * 4 + 1) * 4] > 85, 'processPhoto 默认几何应用全局调整')
}

console.log('— processPhoto 带几何：变换 + 调整 —')
{
  const img = makeTestImg(4, 3)
  const pa: typeof DEFAULT_PHOTO_ADJUST = {
    ...DEFAULT_PHOTO_ADJUST,
    geometry: geo({ rotation90: 90 }),
    global: { ...DEFAULT_PARAMS, exposure: 0 },
  }
  const out = processPhoto(img, pa)
  assert(out.width === 3 && out.height === 4, 'processPhoto 带几何宽高交换')
}

console.log('— normalizeGeometry 容错 —')
{
  const g1 = normalizeGeometry(undefined)
  assert(isDefaultGeometry(g1), 'undefined → 默认')
  const g2 = normalizeGeometry({ rotation90: 90 })
  assert(g2.rotation90 === 90 && g2.enabled === true, '部分字段补默认 + enabled=true')
  const g3 = normalizeGeometry({ fineAngle: 999, rotation90: 45 })
  assert(g3.fineAngle === 45 && g3.rotation90 === 0, '越界钳制 (fineAngle 999→45, rotation90 45→0)')
  const g4 = normalizeGeometry({ crop: { x: -1, w: 5 } })
  assert(g4.crop.x === 0 && g4.crop.w === 1, 'crop 越界钳制')
}

console.log('— normalizePhotoAdjust 老 sidecar（无 geometry）补默认 —')
{
  const old = { exposure: 10, contrast: 5 } // 老格式裸 AdjustParams
  const pa = normalizePhotoAdjust(old)
  assert(isDefaultGeometry(pa.geometry), '老 sidecar 补默认 geometry')
  assert(pa.global.exposure === 10, '老 sidecar global 正确')
  // 新格式缺 geometry
  const pa2 = normalizePhotoAdjust({ global: { exposure: 5 }, masks: [] })
  assert(isDefaultGeometry(pa2.geometry), '新格式缺 geometry 补默认')
  assert(pa2.global.exposure === 5, '新格式 global 正确')
}

console.log('— clonePhotoAdjust geometry 独立（回归 5.5）—')
{
  const a = { ...DEFAULT_PHOTO_ADJUST, geometry: geo({ rotation90: 90, fineAngle: 10, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }) }
  const b = clonePhotoAdjust(a)
  b.geometry.rotation90 = 180
  b.geometry.fineAngle = 99
  b.geometry.crop.x = 0.99
  b.geometry.enabled = false
  assert(a.geometry.rotation90 === 90, 'geometry.rotation90 不被克隆体影响')
  assert(a.geometry.fineAngle === 10, 'geometry.fineAngle 不被克隆体影响')
  assert(a.geometry.crop.x === 0.1, 'geometry.crop.x 不被克隆体影响')
  assert(a.geometry.enabled === true, 'geometry.enabled 不被克隆体影响')
}

console.log('— isDefaultGeometry —')
{
  assert(isDefaultGeometry(DEFAULT_GEOMETRY) === true, '默认 isDefault=true')
  assert(isDefaultGeometry(undefined) === true, 'undefined isDefault=true')
  assert(isDefaultGeometry(geo({ flipH: true })) === false, 'flipH 后非默认')
  assert(isDefaultGeometry(geo({ crop: { x: 0, y: 0, w: 0.5, h: 1 } })) === false, '裁剪后非默认')
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
