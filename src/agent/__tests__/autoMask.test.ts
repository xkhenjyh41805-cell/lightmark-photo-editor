import assert from 'node:assert/strict'
import { automaticMaskLabel, findExistingMaskForTarget, inferAutomaticMaskTarget } from '../autoMask.ts'

let passed = 0
function test(name: string, fn: () => void) { fn(); passed++; console.log(`✓ ${name}`) }

test('明确天空、云层和蓝天指令可路由到本地天空工具', () => {
  assert.equal(inferAutomaticMaskTarget('把天空压暗一点，保留云层细节'), 'sky')
  assert.equal(inferAutomaticMaskTarget('让蓝天更有层次'), 'sky')
  assert.equal(inferAutomaticMaskTarget('reduce sky highlights'), 'sky')
})

test('人物、宠物和笼统局部指令不会误触发尚未支持的自动选区', () => {
  assert.equal(inferAutomaticMaskTarget('提亮人物脸部'), null)
  assert.equal(inferAutomaticMaskTarget('让猫咪毛发更清晰'), null)
  assert.equal(inferAutomaticMaskTarget('压暗这部分背景'), null)
})

test('优先复用已有天空语义蒙版，不重复创建候选', () => {
  const masks = [
    { id: 'background', name: '远处背景' },
    { id: 'sky', name: '天空（AI 候选蒙版）' },
  ]
  assert.equal(findExistingMaskForTarget(masks, 'sky')?.id, 'sky')
  assert.equal(automaticMaskLabel('sky'), '天空')
})

test('不存在天空名称时返回空，由应用端决定是否调用本地分割', () => {
  assert.equal(findExistingMaskForTarget([{ id: 'subject', name: '主体' }], 'sky'), undefined)
})

console.log(`结果：${passed} 项自动选区路由回归测试通过`)
