import {
  DEFAULT_PARAMS,
  clonePhotoAdjust,
  normalizeMaskName,
  normalizePhotoAdjust,
  type AdjustParams,
  type BrushStroke,
  type PhotoAdjust,
  type RasterGeom,
} from './index.ts'

/**
 * Region schema v1 is deliberately additive. Existing PhotoAdjust.masks remain
 * authoritative for the legacy renderer; new semantic regions and region-bound
 * adjustment layers are stored separately to avoid double-applying old edits.
 */
export type RegionMode = 'none' | 'coarse' | 'detailed' | 'recommended'
export type EffectiveRegionMode = Exclude<RegionMode, 'recommended'>
export type RegionSetStatus = 'empty' | 'processing' | 'ready' | 'partial' | 'failed'
export type SemanticRegionStatus = 'candidate' | 'accepted' | 'needs_review'
export type RegionExecutionMode = 'local' | 'cloud' | 'manual'

export type RegionKind =
  | 'person'
  | 'face'
  | 'skin'
  | 'hair'
  | 'eyebrow'
  | 'eye'
  | 'lips'
  | 'teeth'
  | 'body'
  | 'clothing'
  | 'pet'
  | 'background'
  | 'sky'
  | 'object'
  | 'unknown'

export interface RegionSource {
  providerId: string
  modelId: string
  modelVersion?: string
  execution: RegionExecutionMode
}

/** A semantic, reusable selection. It does not itself alter photo pixels. */
export interface SemanticRegion {
  id: string
  kind: RegionKind
  label: string
  parentId: string | null
  instanceIndex: number | null
  status: SemanticRegionStatus
  visible: boolean
  mask: RasterGeom
  source: RegionSource
  /** Provider-reported confidence only; it is not a calibrated quality score. */
  confidence: number | null
  reviewReasons: string[]
}

export interface RegionSet {
  version: 1
  generationId: string | null
  requestedMode: RegionMode
  effectiveMode: EffectiveRegionMode | null
  status: RegionSetStatus
  regions: SemanticRegion[]
  createdAt: number
  updatedAt: number
}

export type AdjustmentLayerTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'legacy-mask'; maskId: string }

/** A non-destructive parameter operation, bound to a selection or old mask. */
export interface RegionAdjustmentLayer {
  id: string
  name: string
  enabled: boolean
  target: AdjustmentLayerTarget
  adjust: AdjustParams
}

/** Additive v3 model. The existing PhotoAdjust fields remain unchanged. */
export interface PhotoAdjustV3 extends PhotoAdjust {
  schemaVersion: 3
  regionSet: RegionSet
  adjustmentLayers: RegionAdjustmentLayer[]
}

export const MAX_SEMANTIC_REGIONS = 256
export const MAX_REGION_MASK_EDGE = 2048
export const MAX_REGION_MASK_PIXELS = 4_194_304
export const MAX_REGION_MASK_BYTES_PER_SET = 16 * 1024 * 1024
export const MAX_REGION_REVIEW_REASONS = 12
export const MAX_REGION_STROKES = 2_000
export const MAX_REGION_STROKE_POINTS = 10_000

const EMPTY_REGION_SET: RegionSet = {
  version: 1,
  generationId: null,
  requestedMode: 'none',
  effectiveMode: 'none',
  status: 'empty',
  regions: [],
  createdAt: 0,
  updatedAt: 0,
}

const REGION_KINDS: readonly RegionKind[] = [
  'person', 'face', 'skin', 'hair', 'eyebrow', 'eye', 'lips', 'teeth',
  'body', 'clothing', 'pet', 'background', 'sky', 'object', 'unknown',
]
const REGION_MODES: readonly RegionMode[] = ['none', 'coarse', 'detailed', 'recommended']
const EFFECTIVE_REGION_MODES: readonly EffectiveRegionMode[] = ['none', 'coarse', 'detailed']
const REGION_SET_STATUSES: readonly RegionSetStatus[] = ['empty', 'processing', 'ready', 'partial', 'failed']
const REGION_STATUSES: readonly SemanticRegionStatus[] = ['candidate', 'accepted', 'needs_review']
const EXECUTION_MODES: readonly RegionExecutionMode[] = ['local', 'cloud', 'manual']
const ADJUST_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof AdjustParams)[]
const REGION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && REGION_ID_PATTERN.test(value)
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function finiteTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0
}

function normalizeStroke(raw: unknown): BrushStroke | null {
  if (!isRecord(raw) || !Array.isArray(raw.points) || raw.points.length < 1 ||
      raw.points.length > MAX_REGION_STROKE_POINTS || typeof raw.size !== 'number' ||
      !Number.isFinite(raw.size) || raw.size <= 0 || raw.size > 1 ||
      typeof raw.feather !== 'number' || !Number.isFinite(raw.feather) ||
      raw.feather < 0 || raw.feather > 1 || typeof raw.erase !== 'boolean') return null

  const points: BrushStroke['points'] = []
  for (const rawPoint of raw.points) {
    if (!isRecord(rawPoint) || typeof rawPoint.x !== 'number' || !Number.isFinite(rawPoint.x) ||
        typeof rawPoint.y !== 'number' || !Number.isFinite(rawPoint.y) ||
        rawPoint.x < 0 || rawPoint.x > 1 || rawPoint.y < 0 || rawPoint.y > 1) return null
    points.push({ x: rawPoint.x, y: rawPoint.y })
  }
  return { points, size: raw.size, feather: raw.feather, erase: raw.erase }
}

function normalizeRasterMask(raw: unknown): RasterGeom | null {
  if (!isRecord(raw) || raw.type !== 'raster' || !Number.isInteger(raw.width) ||
      !Number.isInteger(raw.height) || (raw.width as number) < 1 || (raw.height as number) < 1 ||
      (raw.width as number) > MAX_REGION_MASK_EDGE || (raw.height as number) > MAX_REGION_MASK_EDGE ||
      (raw.width as number) * (raw.height as number) > MAX_REGION_MASK_PIXELS ||
      typeof raw.data !== 'string' || !Array.isArray(raw.strokes) ||
      raw.strokes.length > MAX_REGION_STROKES || typeof raw.size !== 'number' ||
      !Number.isFinite(raw.size) || raw.size <= 0 || raw.size > 1 ||
      typeof raw.feather !== 'number' || !Number.isFinite(raw.feather) ||
      raw.feather < 0 || raw.feather > 1) return null

  const expectedBytes = (raw.width as number) * (raw.height as number)
  if (raw.data.length > Math.ceil(expectedBytes * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) return null
  try {
    if (atob(raw.data).length !== expectedBytes) return null
  } catch {
    return null
  }

  const strokes: BrushStroke[] = []
  for (const item of raw.strokes) {
    const stroke = normalizeStroke(item)
    if (!stroke) return null
    strokes.push(stroke)
  }

  return {
    type: 'raster',
    width: raw.width as number,
    height: raw.height as number,
    data: raw.data,
    strokes,
    size: raw.size,
    feather: raw.feather,
  }
}

function normalizeRegionSource(raw: unknown): RegionSource | null {
  if (!isRecord(raw) || typeof raw.execution !== 'string' ||
      !EXECUTION_MODES.includes(raw.execution as RegionExecutionMode)) return null
  const providerId = cleanText(raw.providerId, 120)
  const modelId = cleanText(raw.modelId, 160)
  if (!providerId || !modelId) return null
  const modelVersion = cleanText(raw.modelVersion, 80)
  return {
    providerId,
    modelId,
    ...(modelVersion ? { modelVersion } : {}),
    execution: raw.execution as RegionExecutionMode,
  }
}

function normalizeSemanticRegion(raw: unknown): SemanticRegion | null {
  if (!isRecord(raw) || !validId(raw.id) || typeof raw.kind !== 'string' ||
      !REGION_KINDS.includes(raw.kind as RegionKind) || typeof raw.status !== 'string' ||
      !REGION_STATUSES.includes(raw.status as SemanticRegionStatus) || typeof raw.visible !== 'boolean') return null

  const label = normalizeMaskName(raw.label)
  if (!label) return null
  const parentId = raw.parentId === null || raw.parentId === undefined
    ? null
    : validId(raw.parentId) ? raw.parentId : undefined
  if (parentId === undefined || parentId === raw.id) return null

  const instanceIndex = raw.instanceIndex === null || raw.instanceIndex === undefined
    ? null
    : Number.isInteger(raw.instanceIndex) && (raw.instanceIndex as number) >= 0 && (raw.instanceIndex as number) < MAX_SEMANTIC_REGIONS
      ? raw.instanceIndex as number
      : undefined
  if (instanceIndex === undefined) return null

  const mask = normalizeRasterMask(raw.mask)
  const source = normalizeRegionSource(raw.source)
  if (!mask || !source) return null

  const confidence = raw.confidence === null || raw.confidence === undefined
    ? null
    : typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1
      ? raw.confidence
      : undefined
  if (confidence === undefined) return null

  const reviewReasons = Array.isArray(raw.reviewReasons)
    ? raw.reviewReasons.slice(0, MAX_REGION_REVIEW_REASONS).map((reason) => cleanText(reason, 200)).filter(Boolean)
    : []

  return {
    id: raw.id,
    kind: raw.kind as RegionKind,
    label,
    parentId,
    instanceIndex,
    status: raw.status as SemanticRegionStatus,
    visible: raw.visible,
    mask,
    source,
    confidence,
    reviewReasons,
  }
}

function hasParentCycle(region: SemanticRegion, byId: Map<string, SemanticRegion>): boolean {
  const seen = new Set<string>([region.id])
  let parentId = region.parentId
  while (parentId) {
    if (seen.has(parentId)) return true
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId ?? null
  }
  return false
}

/**
 * Returns null for an invalid region-set envelope. Invalid individual regions,
 * duplicate IDs, orphaned parent links and cycles are excluded safely.
 */
export function normalizeRegionSet(raw: unknown): RegionSet | null {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.requestedMode !== 'string' ||
      !REGION_MODES.includes(raw.requestedMode as RegionMode) || typeof raw.status !== 'string' ||
      !REGION_SET_STATUSES.includes(raw.status as RegionSetStatus) || !Array.isArray(raw.regions) ||
      raw.regions.length > MAX_SEMANTIC_REGIONS) return null

  const effectiveMode = raw.effectiveMode === null || raw.effectiveMode === undefined
    ? null
    : typeof raw.effectiveMode === 'string' && EFFECTIVE_REGION_MODES.includes(raw.effectiveMode as EffectiveRegionMode)
      ? raw.effectiveMode as EffectiveRegionMode
      : undefined
  if (effectiveMode === undefined) return null

  const generationId = raw.generationId === null || raw.generationId === undefined
    ? null
    : validId(raw.generationId) ? raw.generationId : undefined
  if (generationId === undefined) return null

  const regions: SemanticRegion[] = []
  const ids = new Set<string>()
  let totalMaskBytes = 0
  for (const item of raw.regions) {
    const region = normalizeSemanticRegion(item)
    if (!region || ids.has(region.id)) continue
    const maskBytes = region.mask.width * region.mask.height
    if (totalMaskBytes + maskBytes > MAX_REGION_MASK_BYTES_PER_SET) continue
    totalMaskBytes += maskBytes
    ids.add(region.id)
    regions.push(region)
  }

  let linked = regions.filter((region) => region.parentId === null || ids.has(region.parentId))
  const linkedById = new Map(linked.map((region) => [region.id, region]))
  linked = linked.filter((region) => !hasParentCycle(region, linkedById))
  let validIds = new Set(linked.map((region) => region.id))
  let previousSize = -1
  while (previousSize !== linked.length) {
    previousSize = linked.length
    linked = linked.filter((region) => region.parentId === null || validIds.has(region.parentId))
    validIds = new Set(linked.map((region) => region.id))
  }

  return {
    version: 1,
    generationId,
    requestedMode: raw.requestedMode as RegionMode,
    effectiveMode,
    status: raw.status as RegionSetStatus,
    regions: linked,
    createdAt: finiteTimestamp(raw.createdAt),
    updatedAt: finiteTimestamp(raw.updatedAt),
  }
}

function normalizeAdjustParams(raw: unknown): AdjustParams {
  const result = { ...DEFAULT_PARAMS }
  if (!isRecord(raw)) return result
  for (const key of ADJUST_KEYS) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const min = key === 'sharpness' || key === 'noiseReduction' ? 0 : -100
    result[key] = Math.max(min, Math.min(100, value))
  }
  return result
}

function normalizeAdjustmentLayer(
  raw: unknown,
  regionSet: RegionSet,
  legacyMasks: PhotoAdjust['masks'],
): RegionAdjustmentLayer | null {
  if (!isRecord(raw) || !validId(raw.id) || typeof raw.enabled !== 'boolean' || !isRecord(raw.target)) return null
  const name = normalizeMaskName(raw.name)
  if (!name) return null

  const targetRaw = raw.target
  let target: AdjustmentLayerTarget
  if (targetRaw.kind === 'region' && validId(targetRaw.regionId)) {
    const regionId = targetRaw.regionId
    const region = regionSet.regions.find((item) => item.id === regionId)
    if (!region || region.status !== 'accepted') return null
    target = { kind: 'region', regionId }
  } else if (targetRaw.kind === 'legacy-mask' && validId(targetRaw.maskId)) {
    const maskId = targetRaw.maskId
    if (!legacyMasks.some((mask) => mask.id === maskId)) return null
    target = { kind: 'legacy-mask', maskId }
  } else {
    return null
  }

  return {
    id: raw.id,
    name,
    enabled: raw.enabled,
    target,
    adjust: normalizeAdjustParams(raw.adjust),
  }
}

export function normalizeAdjustmentLayers(
  raw: unknown,
  regionSet: RegionSet,
  legacyMasks: PhotoAdjust['masks'],
): RegionAdjustmentLayer[] {
  if (!Array.isArray(raw) || raw.length > MAX_SEMANTIC_REGIONS) return []
  const result: RegionAdjustmentLayer[] = []
  const ids = new Set<string>()
  for (const item of raw) {
    const layer = normalizeAdjustmentLayer(item, regionSet, legacyMasks)
    if (!layer || ids.has(layer.id)) continue
    ids.add(layer.id)
    result.push(layer)
  }
  return result
}

/**
 * Upgrade legacy/global-only or v2-like data without moving old LocalMask entries.
 * The renderer must not apply these new layers until it explicitly supports them.
 */
export function normalizePhotoAdjustV3(raw: unknown): PhotoAdjustV3 {
  const envelope = isRecord(raw) && isRecord(raw.adjust) ? raw.adjust : raw
  const base = normalizePhotoAdjust(envelope)
  const object = isRecord(envelope) ? envelope : {}
  const regionSet = normalizeRegionSet(object.regionSet) ?? { ...EMPTY_REGION_SET, regions: [] }
  return {
    ...base,
    schemaVersion: 3,
    regionSet,
    adjustmentLayers: normalizeAdjustmentLayers(object.adjustmentLayers, regionSet, base.masks),
  }
}

export function clonePhotoAdjustV3(adjust: PhotoAdjustV3): PhotoAdjustV3 {
  const base = clonePhotoAdjust(adjust)
  return {
    ...base,
    schemaVersion: 3,
    regionSet: {
      ...adjust.regionSet,
      regions: adjust.regionSet.regions.map((region) => ({
        ...region,
        source: { ...region.source },
        reviewReasons: [...region.reviewReasons],
        mask: {
          ...region.mask,
          strokes: region.mask.strokes.map((stroke) => ({
            ...stroke,
            points: stroke.points.map((point) => ({ ...point })),
          })),
        },
      })),
    },
    adjustmentLayers: adjust.adjustmentLayers.map((layer) => ({
      ...layer,
      target: { ...layer.target },
      adjust: { ...layer.adjust },
    })),
  }
}

/** Only an accepted, named region can be made available to Agent planning. */
export function isRegionAgentAvailable(region: SemanticRegion): boolean {
  return region.status === 'accepted' && Boolean(normalizeMaskName(region.label))
}
