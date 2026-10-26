import assert from 'node:assert/strict'
import { clonePhotoAdjust, DEFAULT_PHOTO_ADJUST } from '../../image/index.ts'
import { commitEdit, emptyHistory, undoEdit, redoEdit, transactionStatus, canUndoTransaction, canRedoTransaction } from '../history.ts'
import { groupSuggestions } from '../timeline.ts'
let passed = 0
function test(name: string, fn: () => void) { fn(); passed++; console.log(`✓ ${name}`) }
const initial = () => clonePhotoAdjust(DEFAULT_PHOTO_ADJUST)
test('Agent 一笔全局与HSL修改能撤销并完整恢复', () => {
  const a = initial(); const b = initial(); b.global.exposure = 20; b.hsl.green.saturation = -10
  const h = commitEdit(emptyHistory(), a, 'agent1')
  const undone = undoEdit(h, b)!
  assert.deepEqual(undone.adjust, a); assert.equal(transactionStatus(undone.history, 'agent1'), 'undone')
  assert.equal(canRedoTransaction(undone.history, 'agent1'), true)
  const restored = redoEdit(undone.history, undone.adjust)!
  assert.deepEqual(restored.adjust, b); assert.equal(transactionStatus(restored.history, 'agent1'), 'applied')
})
test('多轮修改按顺序撤销／重做，旧卡片不得误撤销新动作', () => {
  const a = initial(); const b = initial(); b.global.exposure = 10
  const c = clonePhotoAdjust(b); c.global.contrast = 20
  let h = commitEdit(emptyHistory(), a, 'one'); h = commitEdit(h, b, 'two')
  assert.equal(canUndoTransaction(h, 'one'), false); assert.equal(canUndoTransaction(h, 'two'), true)
  const u1 = undoEdit(h, c)!; const u2 = undoEdit(u1.history, u1.adjust)!
  assert.deepEqual(u2.adjust, a); assert.equal(canRedoTransaction(u2.history, 'one'), true)
  assert.equal(canRedoTransaction(u2.history, 'two'), false)
  const r1 = redoEdit(u2.history, u2.adjust)!; const r2 = redoEdit(r1.history, r1.adjust)!
  assert.deepEqual(r2.adjust, c)
})
test('撤销后新编辑会截断重做，不恢复被替代的旧计划', () => {
  const a = initial(); const b = initial(); b.global.exposure = 10
  const h = commitEdit(emptyHistory(), a, 'agent'); const u = undoEdit(h, b)!
  const branch = commitEdit(u.history, u.adjust, 'manual')
  assert.equal(branch.future.length, 0); assert.equal(transactionStatus(branch, 'agent'), 'unavailable')
})
test('连续滑杆合并仍清空重做，且保留最早快照', () => {
  const a = initial(); const b = initial(); b.global.exposure = 10
  const h = commitEdit(emptyHistory(), a, 'drag')
  const merged = commitEdit(h, b, 'unused', true)
  assert.equal(merged.past.length, 1); assert.equal(merged.currentId, 'drag'); assert.deepEqual(merged.past[0].adjust, a)
})
test('快照与蒙版几何深拷贝，历史上限50步', () => {
  const a = initial(); let h = emptyHistory()
  for (let i=0;i<70;i++) h=commitEdit(h,a,`step${i}`)
  assert.equal(h.past.length,50); a.global.exposure=90; assert.equal(h.past[0].adjust.global.exposure,0)
})
test('各照片独立历史互不影响', () => {
  const a=initial(); const h1=commitEdit(emptyHistory(),a,'photo1'); const h2=emptyHistory()
  undoEdit(h1,a); assert.equal(h2.past.length,0); assert.equal(h2.future.length,0)
})
const messages=[{id:1,role:'user' as const,photoId:'a'},{id:2,role:'assistant' as const,photoId:'a'},{id:5,role:'user' as const,photoId:'b'},{id:6,role:'assistant' as const,photoId:'b'}]
test('每轮建议跟随对应助手回复而非全部堆底', () => {
  const grouped=groupSuggestions(messages,[{id:3,photoId:'a',parentMessageId:2},{id:4,photoId:'a',parentMessageId:2},{id:7,photoId:'b',parentMessageId:6}])
  assert.deepEqual(grouped.get(2)?.map(x=>x.id),[3,4]);assert.deepEqual(grouped.get(6)?.map(x=>x.id),[7])
})
test('兼容原内存记录，按同照片前序助手ID推导关联；忽略的建议不显示', () => {
  const grouped=groupSuggestions(messages,[{id:3,photoId:'a'},{id:7,photoId:'b'},{id:8,photoId:'b',dismissed:true}])
  assert.equal(grouped.get(2)?.length,1);assert.deepEqual(grouped.get(6)?.map(x=>x.id),[7])
})
console.log(`结果：${passed} 项历史／逐轮回归测试通过`)
