// 阶段 5.5 历史撤销/重做验证脚本（不依赖测试框架，node --experimental-strip-types 跑）
// 跑法：node --experimental-strip-types src/image/__tests__/history.test.ts
//
// 直接测 clonePhotoAdjust 的深拷贝独立性（这是撤销栈正确性的基础）。
// undo/redo 的 React 状态机在 node 环境跑不了 hook，靠手动 + electron 验证。

import {
  clonePhotoAdjust,
  DEFAULT_PHOTO_ADJUST,
  type PhotoAdjust,
  type LocalMask,
  type BrushStroke,
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

// 构造一个含全局 + HSL 非默认 + 一个笔刷滤镜（带笔触）的 PhotoAdjust
function sampleAdjust(): PhotoAdjust {
  const stroke: BrushStroke = {
    points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }],
    size: 0.05,
    feather: 0.4,
    erase: false,
  }
  const mask: LocalMask = {
    id: 'm1',
    enabled: true,
    geom: { type: 'brush', strokes: [stroke], size: 0.05, feather: 0.4 },
    adjust: { ...DEFAULT_PHOTO_ADJUST.global, exposure: 20 },
  }
  return {
    geometry: { ...DEFAULT_PHOTO_ADJUST.geometry },
    global: { ...DEFAULT_PHOTO_ADJUST.global, exposure: 10, contrast: -5 },
    hsl: {
      ...DEFAULT_PHOTO_ADJUST.hsl,
      red: { hue: 5, saturation: -10, luminance: 0 },
    },
    masks: [mask],
  }
}

console.log('— clonePhotoAdjust 深拷贝独立性 —')
{
  const a = sampleAdjust()
  const b = clonePhotoAdjust(a)
  // 改 b 的各层，a 不应受影响
  b.global.exposure = 99
  b.hsl.red.saturation = 99
  b.masks[0].adjust.exposure = 99
  b.masks[0].geom
  const bg = b.masks[0].geom
  if (bg.type === 'brush') {
    bg.strokes[0].points[0].x = 0.99
    bg.size = 0.99
  }
  assert(a.global.exposure === 10, 'global 不被克隆体修改影响')
  assert(a.hsl.red.saturation === -10, 'hsl 不被克隆体修改影响')
  const am = a.masks[0].geom
  assert(am.type === 'brush' && am.strokes[0].points[0].x === 0.1, '笔触点不被克隆体修改影响')
  assert(am.type === 'brush' && am.size === 0.05, '笔刷 size 不被克隆体修改影响')
  assert(a.masks[0].adjust.exposure === 20, 'mask adjust 不被克隆体修改影响')
}

console.log('— clonePhotoAdjust 结构完整 —')
{
  const a = sampleAdjust()
  const b = clonePhotoAdjust(a)
  assert(b.global.exposure === 10, 'global 值拷贝正确')
  assert(b.hsl.red.hue === 5, 'hsl 值拷贝正确')
  const bm = b.masks[0].geom
  assert(bm.type === 'brush' && bm.strokes.length === 1, '笔刷笔触数量正确')
  assert(bm.type === 'brush' && bm.strokes[0].points.length === 2, '笔触点数量正确')
  assert(b.masks[0].adjust.exposure === 20, 'mask adjust 值拷贝正确')
}

console.log('— clonePhotoAdjust 空结构 —')
{
  const a: PhotoAdjust = { ...DEFAULT_PHOTO_ADJUST }
  const b = clonePhotoAdjust(a)
  assert(b.masks.length === 0, '空 masks 拷贝正确')
  assert(b.global.exposure === 0, '默认 global 拷贝正确')
}

console.log('')
console.log(`结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
