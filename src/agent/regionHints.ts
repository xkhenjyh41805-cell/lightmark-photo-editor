export type RegionHintVisibility = 'visible' | 'partial' | 'uncertain'
export type RegionHintConfidence = 'high' | 'medium' | 'low'
export type NormalizedRegionPoint = readonly [number, number]
export type NormalizedRegionBox = readonly [number, number, number, number]

export type RegionHintPart = 'skin' | 'hair' | 'left_eye' | 'right_eye' | 'nose' | 'mouth'

/**
 * A model-suggested location for a downstream segmentation tool. This is not a
 * pixel mask and must never be treated as an accepted SemanticRegion.
 */
export interface FaceRegionHint {
  id: string
  kind: 'face'
  label: string
  status: 'needs_review'
  bbox: NormalizedRegionBox
  parts: Record<RegionHintPart, RegionHintVisibility>
  positivePoint: NormalizedRegionPoint
  occluderNegativePoint: NormalizedRegionPoint
  /** Model-reported only; not calibrated and never used as an acceptance score. */
  reportedConfidence: RegionHintConfidence
  reviewReason: string
}

export interface RegionHintReply {
  status: 'needs_review'
  source: 'multimodal-llm'
  peopleCount: number
  faces: FaceRegionHint[]
}

export const MAX_REGION_HINT_FACES = 16
const MAX_REPLY_CHARS = 12_000
const PARTS: readonly RegionHintPart[] = ['skin', 'hair', 'left_eye', 'right_eye', 'nose', 'mouth']
const VISIBILITIES: readonly RegionHintVisibility[] = ['visible', 'partial', 'uncertain']
const CONFIDENCES: readonly RegionHintConfidence[] = ['high', 'medium', 'low']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function normalizedPoint(value: unknown, label: string): NormalizedRegionPoint {
  if (!Array.isArray(value) || value.length !== 2 ||
      typeof value[0] !== 'number' || !Number.isFinite(value[0]) || value[0] < 0 || value[0] > 1 ||
      typeof value[1] !== 'number' || !Number.isFinite(value[1]) || value[1] < 0 || value[1] > 1) {
    throw new Error(`模型返回的${label}无效或超出图片范围。`)
  }
  return [value[0], value[1]]
}

function normalizedBox(value: unknown): NormalizedRegionBox {
  if (!Array.isArray(value) || value.length !== 4 ||
      value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) {
    throw new Error('模型返回的人脸框无效或超出图片范围。')
  }
  const [x1, y1, x2, y2] = value as number[]
  if (x1 >= x2 || y1 >= y2) throw new Error('模型返回的人脸框宽度或高度为零。')
  return [x1, y1, x2, y2]
}

function parseFace(value: unknown, index: number): FaceRegionHint {
  const expected = ['bbox', ...PARTS, 'positive_point', 'negative_point_on_occluding_leaf', 'confidence']
  if (!isRecord(value) || !hasOnlyKeys(value, expected) || expected.some((key) => !(key in value))) {
    throw new Error(`第 ${index + 1} 张脸的提示字段缺失或包含不允许的字段。`)
  }

  const bbox = normalizedBox(value.bbox)
  const positivePoint = normalizedPoint(value.positive_point, '正提示点')
  const occluderNegativePoint = normalizedPoint(value.negative_point_on_occluding_leaf, '遮挡物负提示点')
  if (positivePoint[0] < bbox[0] || positivePoint[0] > bbox[2] || positivePoint[1] < bbox[1] || positivePoint[1] > bbox[3]) {
    throw new Error(`第 ${index + 1} 张脸的正提示点不在人脸框内。`)
  }
  if (typeof value.confidence !== 'string' || !CONFIDENCES.includes(value.confidence as RegionHintConfidence)) {
    throw new Error(`第 ${index + 1} 张脸的置信度格式无效。`)
  }

  const parts = {} as Record<RegionHintPart, RegionHintVisibility>
  for (const part of PARTS) {
    const visibility = value[part]
    if (typeof visibility !== 'string' || !VISIBILITIES.includes(visibility as RegionHintVisibility)) {
      throw new Error(`第 ${index + 1} 张脸的 ${part} 可见性无效。`)
    }
    parts[part] = visibility as RegionHintVisibility
  }

  return {
    id: `llm-face-hint-${index + 1}`,
    kind: 'face',
    label: `人脸候选 ${index + 1}`,
    status: 'needs_review',
    bbox,
    parts,
    positivePoint,
    occluderNegativePoint,
    reportedConfidence: value.confidence as RegionHintConfidence,
    reviewReason: '大模型只提供位置提示，不是像素蒙版；需由专用分割工具生成边界并经用户检查。',
  }
}

/** Parses the small, strict JSON contract used by the model-assisted region hint test. */
export function parseRegionHintReply(rawContent: unknown): RegionHintReply {
  if (typeof rawContent !== 'string' || !rawContent.trim() || rawContent.length > MAX_REPLY_CHARS) {
    throw new Error('模型区域提示为空或超过长度限制。')
  }
  const jsonText = rawContent.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('模型没有返回有效 JSON；区域提示未采用。')
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['people_count', 'faces']) ||
      !Number.isInteger(parsed.people_count) || (parsed.people_count as number) < 0 || (parsed.people_count as number) > 100 ||
      !Array.isArray(parsed.faces) || parsed.faces.length > MAX_REGION_HINT_FACES || parsed.faces.length > (parsed.people_count as number)) {
    throw new Error('模型区域提示结构无效；区域提示未采用。')
  }
  return {
    status: 'needs_review',
    source: 'multimodal-llm',
    peopleCount: parsed.people_count as number,
    faces: parsed.faces.map(parseFace),
  }
}
