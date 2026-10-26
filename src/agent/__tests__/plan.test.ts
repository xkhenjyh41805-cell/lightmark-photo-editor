import { DEFAULT_PHOTO_ADJUST, type PhotoAdjust } from '../../image/index.ts'
import { prepareEditPlan, validateEditPlan, type EditPlan } from '../plan.ts'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++
  } else {
    failed++
    console.error('  ✗ FAIL:', message)
  }
}

function validPlan(overrides: Partial<EditPlan> = {}): EditPlan {
  return {
    version: 1,
    summary: '整体提亮并恢复暗部',
    steps: [
      {
        tool: 'adjust_global',
        args: { exposure: 12, shadows: 18 },
        reason: '演示计划：用户明确要求提高整体亮度。',
      },
    ],
    ...overrides,
  }
}

function photoWithNamedSkyMask(): PhotoAdjust {
  const photo = structuredClone(DEFAULT_PHOTO_ADJUST)
  photo.masks = [{
    id: 'mask-sky-1',
    name: '天空',
    enabled: true,
    geom: { type: 'gradient', cx: 0.5, cy: 0.3, angle: 0, range: 0.4, feather: 0.5 },
    adjust: { ...DEFAULT_PHOTO_ADJUST.global },
  }]
  return photo
}

console.log('— EditPlan schema 与工具白名单 —')
{
  const result = validateEditPlan(validPlan())
  assert(result.ok, '合法 adjust_global 计划通过校验')

  const unknownTool = validateEditPlan({
    version: 1,
    summary: '非法工具',
    steps: [{ tool: 'run_shell', args: { command: 'whoami' }, reason: '不应执行' }],
  })
  assert(!unknownTool.ok, '未知工具被拒绝')

  const pathPayload = validateEditPlan({ ...validPlan(), photoPath: 'C:/secret.jpg' })
  assert(!pathPayload.ok, '模型不能传入路径或未允许的根字段')

  const codePayload = validateEditPlan({
    version: 1,
    summary: '执行代码',
    steps: [{ tool: 'adjust_global', args: { exposure: 10, code: 'process.exit()' }, reason: '恶意字段' }],
  })
  assert(!codePayload.ok, '工具参数中的代码／未知字段被拒绝')

  const missingReason = validateEditPlan({
    version: 1,
    summary: '缺少理由',
    steps: [{ tool: 'adjust_global', args: { exposure: 10 }, reason: ' ' }],
  })
  assert(!missingReason.ok, '缺少可读理由的操作被拒绝')
}

console.log('— 参数边界与计划完整性 —')
{
  assert(!validateEditPlan(validPlan({ steps: [{
    tool: 'adjust_global', args: { exposure: 100.01 }, reason: '越界测试',
  }] })).ok, '超出全局参数范围被拒绝')

  assert(!validateEditPlan(validPlan({ steps: [{
    tool: 'adjust_global', args: { exposure: Number.NaN }, reason: '非有限值测试',
  }] })).ok, 'NaN 参数被拒绝')

  assert(!validateEditPlan(validPlan({ steps: [{
    tool: 'adjust_global', args: { sharpness: -1 }, reason: '负锐化测试',
  }] })).ok, '锐化负值被拒绝')

  assert(!validateEditPlan(validPlan({ steps: [
    { tool: 'adjust_global', args: { exposure: 10 }, reason: '第一步' },
    { tool: 'adjust_global', args: { exposure: 20 }, reason: '重复写同一参数' },
  ] })).ok, '重复写同一参数被拒绝')

  assert(!validateEditPlan(validPlan({ steps: [] })).ok, '空计划被拒绝')
  assert(!validateEditPlan({ ...validPlan(), version: 2 }).ok, '未知 schema 版本被拒绝')
}

console.log('— 安全预演、建议确认与原状态隔离 —')
{
  const before = DEFAULT_PHOTO_ADJUST
  const direct = prepareEditPlan(validPlan(), before, { intent: 'explicit_request' })
  assert(direct.status === 'ready', '用户明确请求可进入安全执行准备')
  if (direct.status === 'ready') {
    assert(direct.next.global.exposure === 12, '计划值映射到现有全局参数')
    assert(direct.next.global.shadows === 18, '同一计划的多个参数完整应用')
    assert(direct.changes.length === 2, '参数变更有 before/after 记录')
    assert(before.global.exposure === 0, '预演不修改当前 PhotoAdjust')
    assert(direct.next.masks === before.masks || direct.next.masks.length === before.masks.length, '未触碰局部蒙版')
  }

  const suggestionPlan: EditPlan = {
    version: 1,
    summary: '建议压低高光',
    steps: [{ tool: 'adjust_global', args: { highlights: -15 }, reason: '固定演示建议，不代表当前照片已被分析。' }],
  }
  const pending = prepareEditPlan(suggestionPlan, before, {
    intent: 'proactive_suggestion',
    confirmed: false,
  })
  assert(pending.status === 'awaiting_confirmation', '主动建议在确认前保持待执行状态')
  assert(before.global.highlights === 0, '待确认建议没有修改当前参数')

  const missingApproval = prepareEditPlan(suggestionPlan, before, { intent: 'proactive_suggestion' })
  assert(missingApproval.status === 'awaiting_confirmation', '未提供确认也不能执行主动建议')

  const approved = prepareEditPlan(suggestionPlan, before, {
    intent: 'proactive_suggestion',
    confirmed: true,
  })
  assert(approved.status === 'ready', '用户明确确认后建议才进入执行准备')
  if (approved.status === 'ready') assert(approved.next.global.highlights === -15, '确认后应用建议参数')
}

console.log('— HSL 工具与整份计划拒绝 —')
{
  const hslPlan: EditPlan = {
    version: 1,
    summary: '降低橙色饱和度',
    steps: [{ tool: 'set_hsl', args: { color: 'orange', axis: 'saturation', value: -20 }, reason: '固定参数工具验证。' }],
  }
  const hslResult = prepareEditPlan(hslPlan, DEFAULT_PHOTO_ADJUST, { intent: 'explicit_request' })
  assert(hslResult.status === 'ready', '合法 HSL 操作通过校验')
  if (hslResult.status === 'ready') {
    assert(hslResult.next.hsl.orange.saturation === -20, 'HSL 值映射到对应色段')
    assert(hslResult.changes[0]?.path === 'hsl.orange.saturation', 'HSL 变化有结构化路径')
  }

  const invalidWholePlan = prepareEditPlan({
    version: 1,
    summary: '前一步合法，后一步非法',
    steps: [
      { tool: 'adjust_global', args: { exposure: 25 }, reason: '合法但不得部分生效' },
      { tool: 'adjust_global', args: { unknownSlider: 50 }, reason: '后续非法字段' },
    ],
  }, DEFAULT_PHOTO_ADJUST, { intent: 'explicit_request' })
  assert(invalidWholePlan.status === 'invalid', '计划任一步非法则整份拒绝')
  assert(DEFAULT_PHOTO_ADJUST.global.exposure === 0, '整份计划被拒绝时没有部分修改')
}

console.log('— 已命名蒙版局部工具与局部意图门禁 —')
{
  const localPlan: EditPlan = {
    version: 1,
    summary: '压暗天空保留云层细节',
    steps: [{ tool: 'adjust_mask', args: { maskId: 'mask-sky-1', highlights: -22, exposure: -8 }, reason: '天空亮部偏强，只在已命名天空蒙版内压低高光和曝光。' }],
  }
  const prepared = prepareEditPlan(localPlan, photoWithNamedSkyMask(), { intent: 'explicit_request', scope: 'local_only' })
  assert(prepared.status === 'ready', '已命名且启用的蒙版可执行局部计划')
  if (prepared.status === 'ready') {
    assert(prepared.next.masks[0].adjust.highlights === -22, '局部高光写入对应蒙版')
    assert(prepared.next.masks[0].adjust.exposure === -8, '局部曝光写入对应蒙版')
    assert(prepared.next.global.exposure === 0, '局部计划不修改全图曝光')
    assert(prepared.changes[0]?.label.includes('天空'), '局部变更记录包含用户命名的区域')
  }

  assert(!validateEditPlan({
    version: 1,
    summary: '局部锐化',
    steps: [{ tool: 'adjust_mask', args: { maskId: 'mask-sky-1', sharpness: 10 }, reason: '局部锐化并未进入像素管线。' }],
  }).ok, '局部锐化被拒绝，避免显示执行但无画面效果')

  assert(!validateEditPlan({
    version: 1,
    summary: '伪造区域',
    steps: [{ tool: 'adjust_mask', args: { maskId: 'mask sky/../1', exposure: -10 }, reason: '非法 ID。' }],
  }).ok, '非白名单格式的蒙版 ID 被拒绝')

  const missing = prepareEditPlan({ ...localPlan, steps: [{ ...localPlan.steps[0], args: { maskId: 'mask-other', exposure: -10 } }] }, photoWithNamedSkyMask(), { intent: 'explicit_request' })
  assert(missing.status === 'invalid', '其他照片或不存在的蒙版 ID 被拒绝')

  const disabledPhoto = photoWithNamedSkyMask()
  disabledPhoto.masks[0].enabled = false
  assert(prepareEditPlan(localPlan, disabledPhoto, { intent: 'explicit_request' }).status === 'invalid', '已关闭蒙版不能被 Agent 修改')

  const unnamedPhoto = photoWithNamedSkyMask()
  unnamedPhoto.masks[0].name = ''
  assert(prepareEditPlan(localPlan, unnamedPhoto, { intent: 'explicit_request' }).status === 'invalid', '未命名蒙版不能被 Agent 修改')

  const pendingCandidate = photoWithNamedSkyMask()
  pendingCandidate.masks[0].candidate = { source: 'local-semantic-sky-v1', target: 'sky', status: 'pending', modelId: 'test-local-model' }
  assert(prepareEditPlan(localPlan, pendingCandidate, { intent: 'explicit_request' }).status === 'invalid', '待确认自动候选不能被 Agent 修改')

  assert(prepareEditPlan(validPlan(), photoWithNamedSkyMask(), { intent: 'explicit_request', scope: 'local_only' }).status === 'invalid', '明确局部指令不能降级为全图计划')
}

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
