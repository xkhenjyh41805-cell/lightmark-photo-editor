import { parseRegionHintReply } from '../regionHints.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) pass++
  else {
    fail++
    console.error('  ✗ FAIL:', message)
  }
}
function rejects(run: () => unknown, message: string) {
  try { run(); assert(false, message) } catch { assert(true, message) }
}

const validReply = {
  people_count: 1,
  faces: [{
    bbox: [0.314, 0.212, 0.525, 0.385],
    skin: 'partial',
    hair: 'visible',
    left_eye: 'visible',
    right_eye: 'visible',
    nose: 'visible',
    mouth: 'visible',
    positive_point: [0.403, 0.294],
    negative_point_on_occluding_leaf: [0.562, 0.331],
    confidence: 'high',
  }],
}

console.log('— valid region hints stay unaccepted candidates —')
{
  const parsed = parseRegionHintReply(JSON.stringify(validReply))
  assert(parsed.peopleCount === 1 && parsed.faces.length === 1, 'person and face counts are retained')
  assert(parsed.faces[0].bbox[0] === 0.314 && parsed.faces[0].bbox[3] === 0.385, 'normalized face box is retained')
  assert(parsed.faces[0].positivePoint[0] === 0.403, 'positive prompt point is retained')
  assert(parsed.faces[0].occluderNegativePoint[0] === 0.562, 'occluder negative point is retained')
  assert(parsed.faces[0].status === 'needs_review', 'model output is never treated as accepted')
  assert(parsed.faces[0].reportedConfidence === 'high', 'model confidence is labeled as reported, not trusted')
  assert(parsed.faces[0].reviewReason.includes('不是像素蒙版'), 'result explicitly warns that it is not a pixel mask')
}

console.log('— harmless formatting and no-face replies —')
{
  const fenced = `\`\`\`json\n${JSON.stringify({ people_count: 0, faces: [] })}\n\`\`\``
  const parsed = parseRegionHintReply(fenced)
  assert(parsed.faces.length === 0 && parsed.status === 'needs_review', 'fenced JSON with no face is parsed safely')
}

console.log('— malformed, extra, and out-of-range outputs are rejected —')
{
  rejects(() => parseRegionHintReply('{not json'), 'invalid JSON is rejected')
  rejects(() => parseRegionHintReply(JSON.stringify({ ...validReply, extra: 'unexpected' })), 'unknown top-level keys are rejected')
  rejects(() => parseRegionHintReply(JSON.stringify({ ...validReply, faces: [{ ...validReply.faces[0], bbox: [-0.1, 0.2, 0.5, 0.6] }] })), 'out-of-range box is rejected')
  rejects(() => parseRegionHintReply(JSON.stringify({ ...validReply, faces: [{ ...validReply.faces[0], positive_point: [0.9, 0.9] }] })), 'positive point outside the face box is rejected')
  rejects(() => parseRegionHintReply(JSON.stringify({ ...validReply, faces: [{ ...validReply.faces[0], skin: 'mostly_visible' }] })), 'unknown visibility labels are rejected')
  rejects(() => parseRegionHintReply(JSON.stringify({ ...validReply, faces: [{ ...validReply.faces[0], confidence: 0.99 }] })), 'numeric confidence cannot masquerade as calibrated confidence')
  rejects(() => parseRegionHintReply(JSON.stringify({ people_count: 0, faces: [validReply.faces[0]] })), 'face count cannot exceed reported people count')
  rejects(() => parseRegionHintReply('x'.repeat(12_001)), 'oversized response is rejected')
}

console.log(`区域提示解析测试完成：${pass} 通过，${fail} 失败。`)
if (fail > 0) process.exitCode = 1
