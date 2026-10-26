import {
  clonePhotoAdjustV3,
  isRegionAgentAvailable,
  normalizePhotoAdjustV3,
  normalizeRegionSet,
  type RegionSet,
  type SemanticRegion,
} from '../regions.ts'
import { DEFAULT_PARAMS, type LocalMask } from '../index.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) pass++
  else {
    fail++
    console.error('  ✗ FAIL:', message)
  }
}

function makeRegion(overrides: Partial<SemanticRegion> = {}): SemanticRegion {
  return {
    id: 'region-person-1',
    kind: 'person',
    label: '人物 1',
    parentId: null,
    instanceIndex: 0,
    status: 'accepted',
    visible: true,
    mask: {
      type: 'raster',
      width: 2,
      height: 2,
      data: 'AAAAAA==',
      strokes: [],
      size: 0.04,
      feather: 0.4,
    },
    source: { providerId: 'local-provider', modelId: 'person-segmenter', execution: 'local' },
    confidence: 0.92,
    reviewReasons: [],
    ...overrides,
  }
}

function makeRegionSet(regions: SemanticRegion[]): RegionSet {
  return {
    version: 1,
    generationId: 'generation-1',
    requestedMode: 'detailed',
    effectiveMode: 'detailed',
    status: 'ready',
    regions,
    createdAt: 100,
    updatedAt: 200,
  }
}

console.log('— legacy adjustments migrate without losing or duplicating masks —')
{
  const legacyMask: LocalMask = {
    id: 'old-mask-1',
    name: '手工天空',
    enabled: true,
    geom: { type: 'gradient', cx: 0.5, cy: 0.4, angle: 0, range: 0.4, feather: 0.5 },
    adjust: { ...DEFAULT_PARAMS, exposure: -12 },
  }
  const v2 = normalizePhotoAdjustV3({
    global: { ...DEFAULT_PARAMS, contrast: 7 },
    hsl: undefined,
    masks: [legacyMask],
  })
  assert(v2.schemaVersion === 3, 'v2-like adjustment gets the v3 in-memory marker')
  assert(v2.global.contrast === 7, 'global parameter remains intact')
  assert(v2.masks.length === 1 && v2.masks[0].id === 'old-mask-1', 'legacy mask remains intact')
  assert(v2.adjustmentLayers.length === 0, 'old mask is not copied into new layers and cannot double-apply')
  assert(v2.regionSet.regions.length === 0, 'legacy data receives an empty semantic region set')

  const oldGlobalOnly = normalizePhotoAdjustV3({ exposure: 21 })
  assert(oldGlobalOnly.global.exposure === 21, 'bare legacy global parameters remain supported')
  assert(oldGlobalOnly.masks.length === 0, 'bare legacy data stays mask-free')
}

console.log('— hierarchical regions normalize safely —')
{
  const person = makeRegion()
  const face = makeRegion({
    id: 'region-face-1',
    kind: 'face',
    label: '人脸 1',
    parentId: person.id,
    instanceIndex: 0,
  })
  const normalized = normalizeRegionSet(makeRegionSet([person, face]))
  assert(normalized?.regions.length === 2, 'valid person and child face are retained')
  assert(normalized?.regions[1].parentId === person.id, 'parent/child relationship is preserved')
  assert(normalized ? isRegionAgentAvailable(normalized.regions[0]) : false, 'accepted, named region can be exposed to Agent')

  const candidate = makeRegion({ status: 'candidate' })
  assert(!isRegionAgentAvailable(candidate), 'unaccepted candidate is not Agent-available')
  const needsReview = makeRegion({ status: 'needs_review' })
  assert(!isRegionAgentAvailable(needsReview), 'region needing review is not Agent-available')
}

console.log('— invalid masks, duplicate IDs and invalid parent trees are isolated —')
{
  const invalidMask = makeRegion({
    id: 'region-bad-mask',
    mask: { type: 'raster', width: 2, height: 2, data: 'not-base64', strokes: [], size: 0.1, feather: 0.2 },
  })
  const duplicate = makeRegion({ label: '重复 ID' })
  const orphan = makeRegion({ id: 'region-orphan', parentId: 'missing-parent' })
  const cycleA = makeRegion({ id: 'region-cycle-a', parentId: 'region-cycle-b' })
  const cycleB = makeRegion({ id: 'region-cycle-b', parentId: 'region-cycle-a' })
  const normalized = normalizeRegionSet(makeRegionSet([invalidMask, duplicate, orphan, cycleA, cycleB]))
  assert(normalized?.regions.length === 1, 'bad raster, duplicate, orphaned and cyclic nodes are excluded')
  assert(normalized?.regions[0].id === duplicate.id, 'first valid occurrence of a duplicate ID wins')

  const malformedSet = normalizeRegionSet({ version: 9, regions: [] })
  assert(malformedSet === null, 'unsupported region-set version is rejected')
}

console.log('— adjustment layers require accepted targets and clamp parameters —')
{
  const accepted = makeRegion()
  const candidate = makeRegion({ id: 'region-candidate', status: 'candidate' })
  const regionSet = makeRegionSet([accepted, candidate])
  const mask: LocalMask = {
    id: 'legacy-mask-2',
    name: '笔刷区域',
    enabled: true,
    geom: { type: 'brush', strokes: [], size: 0.1, feather: 0.2 },
    adjust: { ...DEFAULT_PARAMS },
  }
  const normalized = normalizePhotoAdjustV3({
    global: { ...DEFAULT_PARAMS },
    masks: [mask],
    regionSet,
    adjustmentLayers: [
      { id: 'layer-face', name: '提亮人脸', enabled: true, target: { kind: 'region', regionId: accepted.id }, adjust: { exposure: 130, sharpness: -5 } },
      { id: 'layer-candidate', name: '候选不应可用', enabled: true, target: { kind: 'region', regionId: candidate.id }, adjust: { exposure: 8 } },
      { id: 'layer-missing', name: '不存在的区域', enabled: true, target: { kind: 'region', regionId: 'missing-region' }, adjust: { exposure: 8 } },
      { id: 'layer-old-mask', name: '旧蒙版兼容层', enabled: true, target: { kind: 'legacy-mask', maskId: mask.id }, adjust: { exposure: -10 } },
      { id: 'layer-missing-mask', name: '不存在的旧蒙版', enabled: true, target: { kind: 'legacy-mask', maskId: 'missing-mask' }, adjust: { exposure: 1 } },
    ],
  })
  assert(normalized.adjustmentLayers.length === 2, 'only accepted region and existing legacy mask targets survive')
  assert(normalized.adjustmentLayers[0].adjust.exposure === 100, 'positive adjustment is clamped to its maximum')
  assert(normalized.adjustmentLayers[0].adjust.sharpness === 0, 'detail parameter is clamped to its minimum')
  assert(normalized.adjustmentLayers[1].target.kind === 'legacy-mask', 'legacy-mask target remains explicit')
}

console.log('— v3 deep clone isolates nested region and layer data —')
{
  const source = normalizePhotoAdjustV3({
    global: { ...DEFAULT_PARAMS },
    regionSet: makeRegionSet([makeRegion()]),
    adjustmentLayers: [{
      id: 'layer-clone', name: '脸部', enabled: true,
      target: { kind: 'region', regionId: 'region-person-1' },
      adjust: { ...DEFAULT_PARAMS, exposure: 5 },
    }],
  })
  const copy = clonePhotoAdjustV3(source)
  copy.regionSet.regions[0].mask.strokes.push({
    points: [{ x: 0.1, y: 0.2 }], size: 0.1, feather: 0.2, erase: false,
  })
  copy.regionSet.regions[0].mask.strokes[0].points[0].x = 0.9
  copy.adjustmentLayers[0].adjust.exposure = 30
  assert(source.regionSet.regions[0].mask.strokes.length === 0, 'region mask stroke list is not shared')
  assert(source.adjustmentLayers[0].adjust.exposure === 5, 'layer parameters are not shared')
}

console.log(`区域 schema 测试完成：${pass} 通过，${fail} 失败。`)
if (fail > 0) process.exitCode = 1
