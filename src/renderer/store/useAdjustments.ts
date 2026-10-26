import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AdjustParams,
  DEFAULT_PARAMS,
  DEFAULT_PHOTO_ADJUST,
  DEFAULT_HSL,
  DEFAULT_GEOMETRY,
  clonePhotoAdjust,
  isDefaultParams,
  isDefaultHsl,
  isDefaultGeometry,
  normalizeMaskName,
  normalizePhotoAdjust,
  type LocalMask,
  type PhotoAdjust,
  type BrushStroke,
  type HslParams,
  type HslColorId,
  type Geometry,
} from '../../image'
import type { Photo } from '../types'
import type { PresetAdjust } from '../presets'
import { commitEdit, emptyHistory, undoEdit, redoEdit, transactionStatus, canUndoTransaction, canRedoTransaction, type EditHistory } from '../../agent/history'

// 每张照片独立保存一组调整 = 全局参数 + 局部滤镜列表。
// 非破坏性：原图不动，只存参数。以 photoId 为键。
// 阶段 4：全局参数通过 .sidecar JSON 落盘。
// 阶段 5.2：扩展为 PhotoAdjust（global + masks），向后兼容老 sidecar。

// 加载状态：未加载 / 已加载 / 加载中。避免默认值被误存。
type LoadState = 'pending' | 'loaded'

// 生成新局部滤镜 id
let maskSeq = 0
function newMaskId(): string {
  maskSeq += 1
  return `mask-${Date.now().toString(36)}-${maskSeq}`
}

// 创建一个默认渐变滤镜（上半压暗用，半透明天空渐变）
export function makeGradientMask(): LocalMask {
  return {
    id: newMaskId(),
    name: '',
    enabled: true,
    geom: {
      type: 'gradient',
      cx: 0.5,
      cy: 0.4,
      angle: 0,
      range: 0.4,
      feather: 0.5,
    },
    adjust: { ...DEFAULT_PARAMS },
  }
}

// 创建一个默认径向滤镜（中心提亮用）
export function makeRadialMask(): LocalMask {
  return {
    id: newMaskId(),
    name: '',
    enabled: true,
    geom: {
      type: 'radial',
      cx: 0.5,
      cy: 0.5,
      rx: 0.3,
      ry: 0.3,
      rotation: 0,
      feather: 0.3,
      invert: false,
    },
    adjust: { ...DEFAULT_PARAMS },
  }
}

// 创建一个空笔刷滤镜（用户进入局部调整后手动涂出来）
// 初始无笔触，size/feather 是新建笔刷时的默认粗细和软度。
export function makeBrushMask(): LocalMask {
  return {
    id: newMaskId(),
    name: '',
    enabled: true,
    geom: {
      type: 'brush',
      strokes: [],
      size: 0.05,
      feather: 0.4,
    },
    adjust: { ...DEFAULT_PARAMS },
  }
}

export function makeSkyCandidateMask(width: number, height: number, data: string, modelId: string): LocalMask {
  return {
    id: newMaskId(),
    name: '天空（候选）',
    enabled: false,
    candidate: { source: 'local-semantic-sky-v1', target: 'sky', status: 'pending', modelId },
    geom: {
      type: 'raster',
      width,
      height,
      data,
      strokes: [],
      size: 0.04,
      feather: 0.45,
    },
    adjust: { ...DEFAULT_PARAMS },
  }
}

export function useAdjustments() {
  // photoId -> 完整调整（global + masks）
  const [adjustMap, publishAdjustMap] = useState<Record<string, PhotoAdjust>>({})
  const adjustMapRef = useRef<Record<string, PhotoAdjust>>({})
  // Run the update exactly once, outside React's repeatable state updater.
  const setAdjustMap = useCallback((update: (current: Record<string, PhotoAdjust>) => Record<string, PhotoAdjust>) => {
    const next = update(adjustMapRef.current)
    adjustMapRef.current = next
    publishAdjustMap(next)
  }, [])
  const [loadedIds, setLoadedIds] = useState<Record<string, LoadState>>({})
  const dirtyRef = useRef<Set<string>>(new Set())
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleSave = useCallback((photoId: string) => {
    dirtyRef.current.add(photoId)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const ids = Array.from(dirtyRef.current)
      dirtyRef.current.clear()
      for (const id of ids) {
        const a = adjustMapRef.current[id]
        if (a) window.lightmark.saveSidecar(id, a).catch(() => {})
      }
    }, 600)
  }, [])

  // ---- 阶段 5.5：历史撤销/重做 ----
  // 每张照片独立的历史栈：past[] 存「更早的状态」，future[] 存「被 undo 掉的状态」。
  // 当前状态在 adjustMap[photoId]，不在栈里。
  // 上限 MAX_HISTORY：超出丢弃最旧，防止笔刷涂抹刷爆。
  // 合并窗口：同张照片 800ms 内的连续变更合并成一步历史。
  // 一次滑块拖动会触发几十次 setParam，没窗口的话一次拖动就吃掉几十格历史。
  const MERGE_WINDOW_MS = 800
  const [historyMap, publishHistoryMap] = useState<Record<string, EditHistory>>({})
  const historyMapRef = useRef<Record<string, EditHistory>>({})
  const transactionSeqRef = useRef(0)
  const newTransactionId = useCallback(() => `edit-${Date.now()}-${++transactionSeqRef.current}`, [])
  const setHistory = useCallback((photoId: string, history: EditHistory) => {
    const next = { ...historyMapRef.current, [photoId]: history }
    historyMapRef.current = next
    publishHistoryMap(next)
  }, [])
  // 每张照片「上一次落历史的时间戳 + 上一次落历史前的状态快照」。
  // 用于判断本次变更是否落在合并窗口内：窗口内不新增历史项，而是让旧项的「起点」继续生效。
  const lastCommitRef = useRef<Record<string, { ts: number; before: PhotoAdjust }>>({})

  // 暴露给 UI 的撤销/重做可用性。state 派生，不另存。
  const canUndo = useCallback(
    (photoId: string | null): boolean => !!photoId && (historyMap[photoId]?.past.length ?? 0) > 0,
    [historyMap],
  )
  const canRedo = useCallback(
    (photoId: string | null): boolean => !!photoId && (historyMap[photoId]?.future.length ?? 0) > 0,
    [historyMap],
  )

  const isLoaded = useCallback(
    (photoId: string | null): boolean => !!photoId && loadedIds[photoId] === 'loaded',
    [loadedIds],
  )

  // 把一次变更落进历史。
  // before = 变更前的快照（调用方在 setAdjustMap 之前用 clonePhotoAdjust 取）。
  // forceCoalesce=true 时无视时间窗口，一定与上一项合并（笔刷一条笔触内强制合并）。
  const commitHistory = useCallback(
    (photoId: string, before: PhotoAdjust, forceCoalesce = false) => {
      const now = Date.now()
      const last = lastCommitRef.current[photoId]
      const inWindow = last && now - last.ts < MERGE_WINDOW_MS
      const coalesce = Boolean((inWindow || forceCoalesce) && last)
      setHistory(photoId, commitEdit(historyMapRef.current[photoId] ?? emptyHistory(), before, newTransactionId(), coalesce))
      lastCommitRef.current[photoId] = { ts: now, before: coalesce ? last.before : clonePhotoAdjust(before) }
    },
    [setHistory, newTransactionId],
  )

  // 撤销：把 past 栈顶还原到 adjustMap，被覆盖的当前状态推进 future。
  const undo = useCallback((photoId: string) => {
    const current = adjustMapRef.current[photoId] ?? DEFAULT_PHOTO_ADJUST
    const result = undoEdit(historyMapRef.current[photoId] ?? emptyHistory(), current)
    if (!result) return
    setHistory(photoId, result.history)
    setAdjustMap((am) => ({ ...am, [photoId]: result.adjust }))
    delete lastCommitRef.current[photoId]
    scheduleSave(photoId)
  }, [setHistory, setAdjustMap, scheduleSave])

  // 重做：把 future 栈顶还原到 adjustMap，被覆盖的当前状态推进 past。
  const redo = useCallback((photoId: string) => {
    const current = adjustMapRef.current[photoId] ?? DEFAULT_PHOTO_ADJUST
    const result = redoEdit(historyMapRef.current[photoId] ?? emptyHistory(), current)
    if (!result) return
    setHistory(photoId, result.history)
    setAdjustMap((am) => ({ ...am, [photoId]: result.adjust }))
    delete lastCommitRef.current[photoId]
    scheduleSave(photoId)
  }, [setHistory, setAdjustMap, scheduleSave])

  const getTransactionState = useCallback((photoId: string, transactionId: string) => {
    const h = historyMapRef.current[photoId] ?? emptyHistory()
    return { status: transactionStatus(h, transactionId), canUndo: canUndoTransaction(h, transactionId), canRedo: canRedoTransaction(h, transactionId) }
  }, [])

  const getAdjust = useCallback(
    (photoId: string | null): PhotoAdjust => {
      if (!photoId) return DEFAULT_PHOTO_ADJUST
      return adjustMap[photoId] ?? DEFAULT_PHOTO_ADJUST
    },
    [adjustMap],
  )

  const getParams = useCallback(
    (photoId: string | null): AdjustParams => getAdjust(photoId).global,
    [getAdjust],
  )

  const getMasks = useCallback(
    (photoId: string | null): LocalMask[] => getAdjust(photoId).masks,
    [getAdjust],
  )

  // 阶段 5.3：HSL 分色（global-only）
  const getHsl = useCallback(
    (photoId: string | null): HslParams => getAdjust(photoId).hsl ?? DEFAULT_HSL,
    [getAdjust],
  )

  // 阶段 5.6：几何变换（裁剪/旋转/翻转）
  const getGeometry = useCallback(
    (photoId: string | null): Geometry => getAdjust(photoId).geometry ?? DEFAULT_GEOMETRY,
    [getAdjust],
  )

  // 从 sidecar 加载（只加载一次）
  const ensureLoaded = useCallback(
    async (photoId: string) => {
      if (loadedIds[photoId] === 'loaded' || loadedIds[photoId] === 'pending') return
      setLoadedIds((prev) => ({ ...prev, [photoId]: 'pending' }))
      try {
        const raw = await window.lightmark.loadSidecar(photoId)
        const adjust = normalizePhotoAdjust(raw)
        setAdjustMap((prev) => ({ ...prev, [photoId]: adjust }))
      } catch {
        // 读不到就用默认，不报错
      } finally {
        setLoadedIds((prev) => ({ ...prev, [photoId]: 'loaded' }))
      }
    },
    [loadedIds],
  )

  // 改单个全局滑块
  const setParam = useCallback(
    (photoId: string, key: keyof AdjustParams, value: number) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, global: { ...cur.global, [key]: value } } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 整组全局参数替换（重置用）
  const setParams = useCallback(
    (photoId: string, params: AdjustParams) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, global: params } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 重置全局参数（不动 masks，也不动 hsl）
  const resetParams = useCallback(
    (photoId: string) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, global: { ...DEFAULT_PARAMS } } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // ---- 阶段 5.3：HSL 分色操作（global-only）----
  const setHslParam = useCallback(
    (photoId: string, color: HslColorId, axis: 'hue' | 'saturation' | 'luminance', value: number) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        const hsl = cur.hsl ?? DEFAULT_HSL
        return {
          ...prev,
          [photoId]: {
            ...cur,
            hsl: { ...hsl, [color]: { ...hsl[color], [axis]: value } },
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 重置 HSL（不动 global 和 masks）
  const resetHsl = useCallback(
    (photoId: string) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, hsl: { ...DEFAULT_HSL } } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // ---- 阶段 5.6：几何变换操作 ----
  // 改几何参数（旋转/翻转/裁剪）。patch 浅合并进 geometry，自动重算 enabled。
  // 裁剪框拖拽高频触发，靠 commitHistory 的 800ms 合并窗口收敛成一步。
  const setGeometryParam = useCallback(
    (photoId: string, patch: Partial<Geometry>) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        const merged: Geometry = { ...DEFAULT_GEOMETRY, ...cur.geometry, ...patch }
        merged.enabled = !isDefaultGeometry(merged)
        return { ...prev, [photoId]: { ...cur, geometry: merged } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 重置几何（不动 global/hsl/masks）
  const resetGeometry = useCallback(
    (photoId: string) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, geometry: { ...DEFAULT_GEOMETRY } } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 阶段 5.4：套用预设。只覆盖 global + hsl，保留当前照片已有的 masks（局部滤镜）。
  // 深拷贝 preset 的 adjust，避免引用共享导致后续修改互相污染。
  const applyPreset = useCallback(
    (photoId: string, adjust: PresetAdjust) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            global: { ...adjust.global },
            hsl: {
              red: { ...adjust.hsl.red },
              orange: { ...adjust.hsl.orange },
              yellow: { ...adjust.hsl.yellow },
              green: { ...adjust.hsl.green },
              cyan: { ...adjust.hsl.cyan },
              blue: { ...adjust.hsl.blue },
              purple: { ...adjust.hsl.purple },
              magenta: { ...adjust.hsl.magenta },
            },
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 拿某张的全局参数（含默认），给导出用
  const getRawParams = useCallback(
    (photoId: string): AdjustParams => adjustMap[photoId]?.global ?? DEFAULT_PARAMS,
    [adjustMap],
  )

  // 拿某张的完整调整（导出全分辨率走 applyWithMasks 用）
  const getRawAdjust = useCallback(
    (photoId: string): PhotoAdjust => adjustMapRef.current[photoId] ?? DEFAULT_PHOTO_ADJUST,
    [],
  )

  // 将 Agent 的整份候选状态作为一个独立事务提交，不与临近的滑杆历史合并。
  // expectedBefore 用对象身份做 compare-and-swap，防止过期计划覆盖更晚的编辑。
  const applyAgentTransaction = useCallback(
    (photoId: string, expectedBefore: PhotoAdjust, next: PhotoAdjust): string | false => {
      if (loadedIds[photoId] !== 'loaded') return false
      const current = adjustMapRef.current[photoId] ?? DEFAULT_PHOTO_ADJUST
      if (current !== expectedBefore) return false

      const before = clonePhotoAdjust(current)
      const after = clonePhotoAdjust(next)
      const id = newTransactionId()
      setHistory(photoId, commitEdit(historyMapRef.current[photoId] ?? emptyHistory(), before, id))
      setAdjustMap((prev) => ({ ...prev, [photoId]: after }))
      // 让下一次手动滑杆操作开启自己的历史记录，而非并入 Agent 事务。
      lastCommitRef.current[photoId] = {
        ts: Date.now() - MERGE_WINDOW_MS - 1,
        before: clonePhotoAdjust(after),
      }
      scheduleSave(photoId)
      return id
    },
    [loadedIds, scheduleSave, setAdjustMap, setHistory, newTransactionId],
  )

  // ---- 局部滤镜操作 ----
  const addMask = useCallback(
    (photoId: string, mask: LocalMask) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, masks: [...cur.masks, { ...mask, name: normalizeMaskName(mask.name) }] } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  const updateMask = useCallback(
    (photoId: string, maskId: string, patch: Partial<LocalMask>) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((m) => (m.id === maskId ? { ...m, ...patch, ...(patch.name === undefined ? {} : { name: normalizeMaskName(patch.name) }) } : m)),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 更新某滤镜的几何（patch 到 geom）。控制点拖拽会高频触发，靠时间窗口合并。
  const updateMaskGeom = useCallback(
    (photoId: string, maskId: string, geomPatch: Record<string, number | boolean>) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((m) =>
              m.id === maskId ? { ...m, geom: { ...m.geom, ...geomPatch } as LocalMask['geom'] } : m,
            ),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 更新某滤镜的局部调整参数（单个滑块）
  const setMaskParam = useCallback(
    (photoId: string, maskId: string, key: keyof AdjustParams, value: number) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((m) =>
              m.id === maskId
                ? { ...m, adjust: { ...m.adjust, [key]: value } }
                : m,
            ),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  const removeMask = useCallback(
    (photoId: string, maskId: string) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return { ...prev, [photoId]: { ...cur, masks: cur.masks.filter((m) => m.id !== maskId) } }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  const acceptMaskCandidate = useCallback(
    (photoId: string, maskId: string) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        const candidate = cur.masks.find((mask) => mask.id === maskId)?.candidate
        if (!candidate) return prev
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((mask) => {
              if (mask.id !== maskId) return mask
              const currentName = normalizeMaskName(mask.name)
              return {
                ...mask,
                enabled: true,
                candidate: undefined,
                name: currentName === '天空（候选）' ? '天空' : currentName || '天空',
              }
            }),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // ---- 笔刷专属操作 ----
  // 给某笔刷滤镜追加一条笔触（绘制或擦除）。传 null 则清空所有笔触。
  // 一条笔触 = 一次 pointerdown→pointerup，由调用方在 pointerup 时调一次，
  // 所以天然就是一步历史，无需额外合并。
  const appendBrushStroke = useCallback(
    (photoId: string, maskId: string, stroke: BrushStroke | null) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        commitHistory(photoId, cur)
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((m) => {
              if (m.id !== maskId || (m.geom.type !== 'brush' && m.geom.type !== 'raster')) return m
              const strokes = stroke ? [...m.geom.strokes, stroke] : []
              return { ...m, geom: { ...m.geom, strokes } }
            }),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave, commitHistory],
  )

  // 改笔刷默认 size/feather（影响新建笔触粗细）
  const setBrushSize = useCallback(
    (photoId: string, maskId: string, size: number, feather: number) => {
      setAdjustMap((prev) => {
        const cur = prev[photoId] ?? DEFAULT_PHOTO_ADJUST
        return {
          ...prev,
          [photoId]: {
            ...cur,
            masks: cur.masks.map((m) =>
              m.id === maskId && (m.geom.type === 'brush' || m.geom.type === 'raster')
                ? { ...m, geom: { ...m.geom, size, feather } }
                : m,
            ),
          },
        }
      })
      scheduleSave(photoId)
    },
    [scheduleSave],
  )

  // 判断某张是否被调过（全局或局部任一非默认）
  const isAdjusted = useCallback(
    (photo: Photo | null): boolean => {
      if (!photo) return false
      const a = adjustMap[photo.id]
      if (!a) return false
      if (!isDefaultParams(a.global)) return true
      if (a.hsl && !isDefaultHsl(a.hsl)) return true
      if (a.geometry && !isDefaultGeometry(a.geometry)) return true
      return a.masks.some((m) => m.enabled && !isDefaultParams(m.adjust))
    },
    [adjustMap],
  )

  // 覆盖原图把当前效果烘焙进像素后，清掉旧调整和历史，避免打开后重复套用。
  const clearPhotoAdjustments = useCallback((photoId: string) => {
    const reset = clonePhotoAdjust(DEFAULT_PHOTO_ADJUST)
    setAdjustMap((current) => ({ ...current, [photoId]: reset }))
    setHistory(photoId, emptyHistory())
    delete lastCommitRef.current[photoId]
    dirtyRef.current.delete(photoId)
    void window.lightmark.saveSidecar(photoId, reset).catch(() => {})
  }, [setAdjustMap, setHistory])

  // 卸载时把还没写盘的 flush 掉
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      for (const id of dirtyRef.current) {
        const a = adjustMapRef.current[id]
        if (a) window.lightmark.saveSidecar(id, a).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    getParams,
    getMasks,
    getAdjust,
    getHsl,
    getGeometry,
    getRawParams,
    getRawAdjust,
    isLoaded,
    applyAgentTransaction,
    setParam,
    setParams,
    getTransactionState,
    resetParams,
    resetHsl,
    resetGeometry,
    setHslParam,
    setGeometryParam,
    isAdjusted,
    ensureLoaded,
    addMask,
    updateMask,
    updateMaskGeom,
    setMaskParam,
    removeMask,
    acceptMaskCandidate,
    appendBrushStroke,
    setBrushSize,
    applyPreset,
    undo,
    redo,
    canUndo,
    canRedo,
    clearPhotoAdjustments,
  }
}
