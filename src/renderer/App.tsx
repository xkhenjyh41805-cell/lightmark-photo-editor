import { useCallback, useEffect, useMemo, useState } from 'react'
import { WorkGroupList } from './components/WorkGroupList'
import { PreviewArea } from './components/PreviewArea'
import { AdjustPanel } from './components/AdjustPanel'

import { ExportDialog } from './components/ExportDialog'
import { AgentToolPanel, type AgentToolRunOutcome } from './components/AgentToolPanel'
import { Filmstrip } from './components/Filmstrip'
import { usePhotoLibrary } from './store/usePhotoLibrary'
import { useWorkGroups } from './store/useWorkGroups'
import { useAdjustments } from './store/useAdjustments'
import { useSkyMaskCandidate } from './store/useSkyMaskCandidate'
import { useGuidance } from './store/useGuidance'
import { usePresets } from './store/usePresets'
import type { ImageBuf, LocalMask, PhotoAdjust } from '../image'
import { clonePhotoAdjust, isMaskAgentAvailable, normalizeMaskName, processPhoto } from '../image'
import type { StepId } from './guidance'
import { makeGradientMask, makeRadialMask, makeBrushMask, makeSkyCandidateMask } from './store/useAdjustments'
import { makePresetAdjust, type Preset } from './presets'
import type { ExportFormat, ExportOptions } from './export'
import type { Photo } from './types'
import type { BrushStroke, Geometry } from '../image'
import { encodeRasterMaskData, isDefaultGeometry } from '../image'
import { prepareEditPlan, type PlanIntent, type PlanScope } from '../agent/plan'

// 加载图片数据，并等待浏览器完成解码。
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

function exportFormatForPhotoExtension(ext: string): ExportFormat | null {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg'
  if (normalized === 'png') return 'png'
  if (normalized === 'webp') return 'webp'
  return null
}

function App() {
  const {
    photos,
    selected,
    selectedId,
    loading,
    setSelectedId,
    importPhotosFromDialog,
    importPhotosFromPaths,
    replacePhoto,
  } = usePhotoLibrary()
  const workGroupState = useWorkGroups(photos, loading, selectedId, setSelectedId)
  const {
    groups, activeGroup, activeGroupId, groupPhotos,
    loading: workGroupsLoading, error: workGroupsError,
    selectGroup, createGroup, renameGroup, rememberPhoto,
  } = workGroupState

  const {
    getParams,
    getMasks,
    getHsl,
    getGeometry,
    getRawAdjust,
    isLoaded,
    applyAgentTransaction,
    setParam,
    resetParams,
    resetHsl,
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
    getTransactionState,
    clearPhotoAdjustments,
  } = useAdjustments()
  const guidance = useGuidance()
  const { presets, savePreset, deletePreset } = usePresets()
  const skyMaskCandidate = useSkyMaskCandidate()
  const [leftPanelTab, setLeftPanelTab] = useState<'library' | 'adjust'>('library')
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [topMenuOpen, setTopMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  useEffect(() => setShowOriginal(false), [selectedId])
  useEffect(() => {
    if (!exportMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.lm-export-anchor')) setExportMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [exportMenuOpen])

  const params = getParams(selectedId)
  const masks = getMasks(selectedId)
  const hsl = getHsl(selectedId)
  const geometry = getGeometry(selectedId)
  const adjust = getRawAdjust(selectedId ?? '')

  // 局部调整编辑模式。
  const [localMode, setLocalMode] = useState(false)
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null)
  // 裁剪与旋转编辑模式，与局部调整互斥。
  const [cropMode, setCropMode] = useState(false)
  // 笔刷绘制／擦除模式。
  const [brushErase, setBrushErase] = useState(false)
  const enterLocal = useCallback(() => {
    setCropMode(false)
    setLocalMode(true)
    // 进入局部模式时，默认选中已有蒙版。
    setSelectedMaskId((cur) => cur ?? (masks[0]?.id ?? null))
  }, [masks])
  const exitLocal = useCallback(() => setLocalMode(false), [])
  const enterCrop = useCallback(() => {
    setLocalMode(false)
    setCropMode(true)
  }, [])
  const exitCrop = useCallback(() => setCropMode(false), [])

  const handleUpdateGeometry = useCallback(
    (patch: Partial<Geometry>) => {
      if (!selectedId) return
      setGeometryParam(selectedId, patch)
    },
    [selectedId, setGeometryParam],
  )

  const handleAddGradient = useCallback(() => {
    if (!selectedId) return
    const m = makeGradientMask()
    addMask(selectedId, m)
    setSelectedMaskId(m.id)
  }, [selectedId, addMask])

  const handleAddRadial = useCallback(() => {
    if (!selectedId) return
    const m = makeRadialMask()
    addMask(selectedId, m)
    setSelectedMaskId(m.id)
  }, [selectedId, addMask])

  const handleAddBrush = useCallback(() => {
    if (!selectedId) return
    const m = makeBrushMask()
    addMask(selectedId, m)
    setSelectedMaskId(m.id)
    setBrushErase(false)
  }, [selectedId, addMask])

  const handleBrushStroke = useCallback(
    (maskId: string, stroke: BrushStroke) => {
      if (!selectedId) return
      appendBrushStroke(selectedId, maskId, stroke)
    },
    [selectedId, appendBrushStroke],
  )

  const handleClearBrush = useCallback(() => {
    if (!selectedId || !selectedMaskId) return
    appendBrushStroke(selectedId, selectedMaskId, null)
  }, [selectedId, selectedMaskId, appendBrushStroke])

  const handleBrushSize = useCallback(
    (size: number, feather: number) => {
      if (!selectedId || !selectedMaskId) return
      setBrushSize(selectedId, selectedMaskId, size, feather)
    },
    [selectedId, selectedMaskId, setBrushSize],
  )

  const handleToggleMask = useCallback(
    (id: string, enabled: boolean) => {
      if (!selectedId) return
      updateMask(selectedId, id, { enabled })
    },
    [selectedId, updateMask],
  )

  const handleRenameMask = useCallback(
    (id: string, name: string) => {
      if (!selectedId) return
      updateMask(selectedId, id, { name })
    },
    [selectedId, updateMask],
  )

  const handleRemoveMask = useCallback(
    (id: string) => {
      if (!selectedId) return
      removeMask(selectedId, id)
      setSelectedMaskId((cur) => (cur === id ? null : cur))
    },
    [selectedId, removeMask],
  )

  const handleMaskParam = useCallback(
    (key: keyof typeof params, value: number) => {
      if (!selectedId || !selectedMaskId) return
      setMaskParam(selectedId, selectedMaskId, key, value)
    },
    [selectedId, selectedMaskId, setMaskParam],
  )

  const handleUpdateMaskGeom = useCallback(
    (maskId: string, patch: Record<string, number | boolean>) => {
      if (!selectedId) return
      updateMaskGeom(selectedId, maskId, patch)
    },
    [selectedId, updateMaskGeom],
  )

  // 阶段 5.4：修图预设。
  // 套用预设时替换全局与 HSL 参数，保留局部蒙版；历史事务由调整存储统一管理。
  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      if (!selectedId) return
      applyPreset(selectedId, makePresetAdjust(preset.adjust.global, preset.adjust.hsl))
    },
    [selectedId, applyPreset],
  )

  // 将当前全局与 HSL 参数保存为命名预设。
  const handleSavePreset = useCallback(
    async (name: string) => {
      if (!selectedId) return
      const adjust = getRawAdjust(selectedId)
      await savePreset(name, makePresetAdjust(adjust.global, adjust.hsl))
    },
    [selectedId, getRawAdjust, savePreset],
  )

  const handleDeletePreset = useCallback(
    (presetId: string) => {
      deletePreset(presetId)
    },
    [deletePreset],
  )

  // 切换照片时，从 sidecar 载入该照片的历史参数。
  useEffect(() => {
    if (selectedId) ensureLoaded(selectedId)
  }, [selectedId, ensureLoaded])

  useEffect(() => {
    setSelectedMaskId(null)
    setLocalMode(false)
    setCropMode(false)
    setBrushErase(false)
  }, [selectedId])

  // 阶段 5.5：撤销与重做。
  // Ctrl+Z 撤销，Ctrl+Shift+Z／Ctrl+Y 重做。
  const handleUndo = useCallback(() => {
    if (selectedId && canUndo(selectedId)) undo(selectedId)
  }, [selectedId, canUndo, undo])
  const handleRedo = useCallback(() => {
    if (selectedId && canRedo(selectedId)) redo(selectedId)
  }, [selectedId, canRedo, redo])

  const handleAgentPlan = useCallback(
    (
      raw: unknown,
      photoId: string,
      intent: PlanIntent,
      confirmed?: boolean,
      expectedRevision?: string,
      scope?: PlanScope,
      autoMask?: LocalMask,
    ): AgentToolRunOutcome => {
      if (!isLoaded(photoId)) {
        return { status: 'failed', message: '照片调整记录尚未载入，计划没有执行。' }
      }
      const before = getRawAdjust(photoId)
      if (expectedRevision && JSON.stringify({ photoId, adjust: before }) !== expectedRevision) {
        return { status: 'failed', message: '照片在 Agent 分析期间已被修改；为避免应用过期计划，请重新发送指令或生成新建议。' }
      }
      const planningBase = clonePhotoAdjust(before)
      if (autoMask) {
        const name = normalizeMaskName(autoMask.name)
        if (autoMask.geom.type !== 'raster' || !isMaskAgentAvailable(autoMask) || name !== '天空') {
          return { status: 'failed', message: '自动天空选区数据未通过应用端校验；没有修改照片。' }
        }
        if (planningBase.masks.some((mask) => mask.id === autoMask.id)) {
          return { status: 'failed', message: '自动天空选区 ID 与当前照片已有蒙版冲突；请重新发送指令。' }
        }
        planningBase.masks.push(structuredClone(autoMask))
      }
      const prepared = prepareEditPlan(raw, planningBase, { intent, confirmed, scope })
      if (prepared.status === 'invalid') {
        return { status: 'failed', message: prepared.error }
      }
      if (prepared.status === 'awaiting_confirmation') {
        return { status: 'awaiting_confirmation', summary: prepared.plan.summary }
      }
      if (prepared.changes.length === 0) {
        return { status: 'no_changes', summary: prepared.plan.summary }
      }
      if (autoMask) {
        const targetPrefix = `masks.${autoMask.id}.adjust.`
        if (!prepared.changes.some((change) => change.path.startsWith(targetPrefix))) {
          return { status: 'failed', message: '模型没有把本次局部计划应用到自动选取的天空区域；为避免误改，临时蒙版没有保存。' }
        }
      }
      const transactionId = applyAgentTransaction(photoId, before, prepared.next)
      if (!transactionId) {
        return { status: 'failed', message: '照片状态已变化；为避免覆盖较新的编辑，计划已停止，请重新检查后再试。' }
      }
      return {
        status: 'applied',
        transactionId,
        summary: autoMask ? `已自动选取“天空”区域；${prepared.plan.summary}` : prepared.plan.summary,
        changes: prepared.changes,
        ...(autoMask ? {
          createdMask: {
            id: autoMask.id,
            name: '天空',
            description: '已由 Agent 在本机选取天空区域。可查看并用笔刷修正范围；撤销此步会同时移除本次自动蒙版和局部参数。',
          },
        } : {}),
      }
    },
    [isLoaded, getRawAdjust, applyAgentTransaction],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const tag = (e.target as HTMLElement | null)?.tagName
      // 输入框与可编辑区域内不拦截快捷键。
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (selectedId && canUndo(selectedId)) undo(selectedId)
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        if (selectedId && canRedo(selectedId)) redo(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, canUndo, canRedo, undo, redo])

  // 处理后的像素缓冲用于直方图和 Agent 当前画布上下文。
  const [processedBuf, setProcessedBuf] = useState<ImageBuf | null>(null)
  const previewAdjustmentKey = useMemo(() => JSON.stringify({ photoId: selectedId, adjust }), [selectedId, adjust])
  const [processedBufferSource, setProcessedBufferSource] = useState<{ photoId: string | null; key: string } | null>(null)
  const handleProcessed = useCallback((buf: ImageBuf | null) => {
    setProcessedBuf(buf)
    setProcessedBufferSource({ photoId: selectedId, key: previewAdjustmentKey })
  }, [selectedId, previewAdjustmentKey])
  const agentPreviewReady = Boolean(
    selectedId && processedBuf && processedBufferSource?.photoId === selectedId && processedBufferSource.key === previewAdjustmentKey,
  )

  const handleGenerateSkyCandidate = useCallback(async () => {
    if (!selectedId || !processedBuf || !agentPreviewReady) return
    const photoId = selectedId
    const revision = previewAdjustmentKey
    try {
      const result = await skyMaskCandidate.generate(processedBuf)
      // 推理期间切换照片或调整参数时，丢弃过期的天空候选。
      if (!result || selectedId !== photoId || previewAdjustmentKey !== revision) return
      const candidate = makeSkyCandidateMask(result.width, result.height, encodeRasterMaskData(result.data), result.modelId)
      addMask(photoId, candidate)
      setCropMode(false)
      setLocalMode(true)
      setSelectedMaskId(candidate.id)
    } catch {
      // 失败状态由 Hook 展示；不创建候选蒙版，也不修改照片参数。
    }
  }, [selectedId, processedBuf, agentPreviewReady, previewAdjustmentKey, skyMaskCandidate, addMask])

  // 自动选区先保留为内存临时蒙版，计划校验通过后才和局部参数一并提交为单次可撤销事务。
  // 计算直方图与修图建议。
  const handleCreateAutoSkyMask = useCallback(async (photoId: string, expectedRevision: string): Promise<LocalMask | null> => {
    if (!isLoaded(photoId) || selectedId !== photoId || !processedBuf || !agentPreviewReady) return null
    if (JSON.stringify({ photoId, adjust: getRawAdjust(photoId) }) !== expectedRevision) return null
    const result = await skyMaskCandidate.generate(processedBuf)
    if (!result) return null
    if (selectedId !== photoId || !agentPreviewReady || JSON.stringify({ photoId, adjust: getRawAdjust(photoId) }) !== expectedRevision) return null
    const pending = makeSkyCandidateMask(result.width, result.height, encodeRasterMaskData(result.data), result.modelId)
    return { ...pending, name: '天空', enabled: true, candidate: undefined }
  }, [selectedId, processedBuf, agentPreviewReady, isLoaded, getRawAdjust, skyMaskCandidate])

  const handleAcceptMaskCandidate = useCallback((maskId: string) => {
    if (!selectedId) return
    acceptMaskCandidate(selectedId, maskId)
  }, [selectedId, acceptMaskCandidate])

  const handleInspectAgentMask = useCallback((photoId: string, maskId: string) => {
    if (selectedId !== photoId || !getMasks(photoId).some((mask) => mask.id === maskId)) return
    setCropMode(false)
    setLeftPanelTab('adjust')
    setLocalMode(true)
    setSelectedMaskId(maskId)
  }, [selectedId, getMasks])

  const goStep = useCallback(
    (id: StepId) => { setLocalMode(false); setCropMode(false); setLeftPanelTab('adjust'); guidance.goStep(id) },
    [guidance],
  )

  // 阶段 4：导出。
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportProgress, setExportProgress] = useState<string | null>(null)
  const [exportMode, setExportMode] = useState<'new-group' | 'overwrite-original'>('new-group')

  // 未勾选批量照片时导出当前预览；勾选后导出选中的照片。
  const [multiIds, setMultiIds] = useState<string[]>([])
  const exportTargets = multiIds.length > 0
    ? groupPhotos.filter((photo) => multiIds.includes(photo.id))
    : selected ? [selected] : []
  const firstOverwriteFormat = exportTargets.length > 0
    ? exportFormatForPhotoExtension(exportTargets[0].ext)
    : null
  const overwriteFormat = firstOverwriteFormat && exportTargets.every(
    (photo) => exportFormatForPhotoExtension(photo.ext) === firstOverwriteFormat,
  ) ? firstOverwriteFormat : null
  const canOverwriteOriginal = Boolean(overwriteFormat && exportTargets.length > 0)
  const toggleMulti = useCallback((id: string) => {
    setMultiIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])

  const handleCreateWorkGroup = useCallback(async () => {
    if (workGroupsLoading || workGroupsError) return
    const imported = await importPhotosFromDialog()
    if (!imported?.length) return
    if (!createGroup(imported)) return
    setMultiIds([])
    setLeftPanelTab('library')
  }, [workGroupsLoading, workGroupsError, importPhotosFromDialog, createGroup])

  const handleSelectWorkGroup = useCallback((id: string) => {
    setMultiIds([])
    selectGroup(id)
  }, [selectGroup])

  useEffect(() => {
    if (activeGroupId && selectedId && activeGroup?.photoIds.includes(selectedId)) {
      rememberPhoto(selectedId)
    }
  }, [activeGroupId, activeGroup, selectedId, rememberPhoto])

  // 解码全分辨率原图，应用非破坏式参数并返回 RGBA 像素。
  const renderFullResolution = useCallback(
    async (photo: Photo): Promise<ImageBuf> => {
      const url = await window.lightmark.readDataUrl(photo.originalPath)
      if (!url) throw new Error('读取原图失败')
      const img = await loadImage(url)
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const imgData = ctx.getImageData(0, 0, img.width, img.height)
      const photoAdjust = getRawAdjust(photo.id)
      return processPhoto(
        { width: img.width, height: img.height, data: imgData.data },
        photoAdjust,
      )
    },
    [getRawAdjust],
  )

  const exportOne = useCallback(
    async (photo: Photo, options: ExportOptions) => {
      const buf = await renderFullResolution(photo)
      const baseName = photo.name.replace(/\.[^.]+$/, '') || '光印导出'
      const saved = await window.lightmark.exportPixels({
        pixels: buf.data,
        width: buf.width,
        height: buf.height,
        options,
        suggestedName: baseName,
      })
      return saved
    },
    [renderFullResolution],
  )

  // 确认单张或批量导出。
  const handleExportConfirm = useCallback(
    async (options: ExportOptions) => {
      // 有多选时导出已勾选照片，否则导出当前预览照片。
      const targets = multiIds.length > 0
        ? groupPhotos.filter((p) => multiIds.includes(p.id))
        : selected
          ? [selected]
          : []
      if (targets.length === 0) return
      setExportBusy(true)
      setExportProgress(targets.length === 1 ? null : `0 / ${targets.length}`)

      try {
        if (exportMode === 'overwrite-original') {
          if (!overwriteFormat || targets.some((photo) => exportFormatForPhotoExtension(photo.ext) !== options.format)) {
            throw new Error('所选照片格式不一致或不支持覆盖；请改用“导出为新的一组”。')
          }
          let completed = 0
          try {
            for (let i = 0; i < targets.length; i++) {
              const photo = targets[i]
              setExportProgress(targets.length === 1 ? null : `${i + 1} / ${targets.length}`)
              const buf = await renderFullResolution(photo)
              const updatedPhoto = await window.lightmark.overwriteOriginal({
                photoId: photo.id,
                pixels: buf.data,
                width: buf.width,
                height: buf.height,
                options,
              })
              replacePhoto(updatedPhoto)
              clearPhotoAdjustments(photo.id)
              completed += 1
            }
          } catch (error) {
            if (completed > 0) {
              const detail = error instanceof Error ? error.message : String(error)
              throw new Error(`已成功覆盖 ${completed} 张照片，其余操作失败：${detail}`)
            }
            throw error
          }
        } else {
          const savedPaths: string[] = []
          if (targets.length === 1) {
            // 单张新组导出使用系统保存对话框。
            const saved = await exportOne(targets[0], options)
            if (!saved) {
              setExportOpen(false)
              return
            }
            savedPaths.push(saved)
          } else {
            // 批量新组导出先选目录，再逐张处理并统一写盘。
            const dir = await window.lightmark.exportPickDir()
            if (!dir) {
              setExportOpen(false)
              return
            }
            const items = []
            for (let i = 0; i < targets.length; i++) {
              setExportProgress(`${i + 1} / ${targets.length}`)
              const photo = targets[i]
              const buf = await renderFullResolution(photo)
              items.push({
                pixels: buf.data,
                width: buf.width,
                height: buf.height,
                options,
                suggestedName: photo.name.replace(/\.[^.]+$/, '') || '光印导出',
              })
            }
            const result = await window.lightmark.exportBatch({ dir, items })
            savedPaths.push(...result.saved)
          }
          if (savedPaths.length === 0) throw new Error('没有照片成功导出，因此未创建新工作组。')
          const imported = await importPhotosFromPaths(savedPaths)
          if (!imported?.length || !createGroup(imported)) {
            throw new Error('照片已导出，但创建新工作组失败。')
          }
        }
        setExportOpen(false)
        setMultiIds([]) // 导出后清空已选照片。
      } finally {
        setExportBusy(false)
        setExportProgress(null)
      }
    },
    [multiIds, groupPhotos, selected, exportOne, renderFullResolution, exportMode, overwriteFormat, replacePhoto, clearPhotoAdjustments, importPhotosFromPaths, createGroup],
  )
  return (
    <div className="lm-app flex h-full w-full flex-col">
      <header className="lm-topbar">
        <div className="lm-topbar-left">
          <div className="lm-brand-mark" aria-hidden="true">光</div>
          <div className="shrink-0 text-sm font-semibold tracking-wide">光印 <span className="font-normal text-zinc-500">LightMark</span></div>
        </div>
        <div className="lm-topbar-actions" role="toolbar" aria-label="照片操作">
          <button type="button" onClick={() => setShowOriginal((current) => !current)} disabled={!selected} aria-pressed={showOriginal} className={`lm-toolbar-button${showOriginal ? ' is-active' : ''}`} title="对比原图">
            <span aria-hidden="true">◫</span><span>{showOriginal ? '正在看原图' : '对比原图'}</span>
          </button>
          <button type="button" onClick={handleUndo} disabled={!selected || !canUndo(selectedId)} aria-label="上一步" title="撤销上一步 (Ctrl+Z)" className="lm-toolbar-button"><span aria-hidden="true">↶</span><span>上一步</span></button>
          <button type="button" onClick={handleRedo} disabled={!selected || !canRedo(selectedId)} aria-label="下一步" title="重做下一步 (Ctrl+Shift+Z)" className="lm-toolbar-button"><span aria-hidden="true">↷</span><span>下一步</span></button>
          <div className="lm-export-anchor">
            <button type="button" onClick={() => { setExportMode('new-group'); setExportMenuOpen(false); setExportOpen(true) }} disabled={!selected || exportBusy} className="lm-primary-button lm-export-main" title="导出为新的一组">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
              <span>{exportBusy ? exportProgress ? `处理中 ${exportProgress}` : '处理中…' : multiIds.length > 0 ? `导出 ${multiIds.length} 张` : '导出'}</span>
            </button>
            <button type="button" className="lm-primary-button lm-export-caret" aria-label="选择导出方式" aria-haspopup="menu" aria-expanded={exportMenuOpen} disabled={!selected || exportBusy} title="选择导出为新的一组或覆盖原图" onClick={() => setExportMenuOpen((open) => !open)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {exportMenuOpen && (
              <div className="lm-export-menu" role="menu" aria-label="导出方式">
                <button type="button" role="menuitem" onClick={() => { setExportMode('new-group'); setExportMenuOpen(false); setExportOpen(true) }}>
                  <span>导出为新的一组</span>
                  <small>保留原组，创建独立工作组</small>
                </button>
                <button type="button" role="menuitem" disabled={!canOverwriteOriginal} title={canOverwriteOriginal ? '覆盖 LightMark 私有图库副本并保留备份' : '所选照片格式不一致或格式暂不支持覆盖'} onClick={() => { setExportMode('overwrite-original'); setExportMenuOpen(false); setExportOpen(true) }}>
                  <span>覆盖原图</span>
                  <small>{canOverwriteOriginal ? '仅覆盖 LightMark 图库副本，先保留备份' : '所选照片格式不一致或暂不支持覆盖'}</small>
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="lm-window-tools">
          <div className="lm-app-menu-anchor">
            <button type="button" className="lm-window-button lm-menu-button" aria-label="应用菜单" aria-expanded={topMenuOpen} onClick={() => setTopMenuOpen((open) => !open)}>☰</button>
            {topMenuOpen && <div className="lm-app-menu" role="menu">
              <button role="menuitem" onClick={() => { setLeftPanelCollapsed((value) => !value); setTopMenuOpen(false) }}>{leftPanelCollapsed ? '显示' : '隐藏'}图库栏</button>
              <button role="menuitem" onClick={() => { setAgentPanelCollapsed((value) => !value); setTopMenuOpen(false) }}>{agentPanelCollapsed ? '显示' : '隐藏'}修图助手</button>
              <div className="lm-menu-divider" />
              <button role="menuitem" onClick={() => void window.lightmark.windowControl('close')}>退出 LightMark</button>
            </div>}
          </div>
          <button type="button" className="lm-window-button" aria-label="最小化" title="最小化" onClick={() => void window.lightmark.windowControl('minimize')}>−</button>
          <button type="button" className="lm-window-button" aria-label="最大化或还原" title="最大化／还原" onClick={() => void window.lightmark.windowControl('toggleMaximize')}>□</button>
          <button type="button" className="lm-window-button lm-window-close" aria-label="关闭" title="关闭" onClick={() => void window.lightmark.windowControl('close')}>×</button>
        </div>
      </header>
      <div className="lm-workspace flex min-h-0 flex-1 overflow-hidden">
        <aside className={`lm-left-sidebar${leftPanelCollapsed ? ' is-collapsed' : ''}`} aria-label="图库与手动修图">
          {leftPanelCollapsed ? <button className="lm-collapsed-toggle" onClick={() => setLeftPanelCollapsed(false)} aria-label="展开左侧面板" title="展开工作组／手动修图">›</button> : <>
            <div className="lm-sidebar-heading"><div role="tablist" aria-label="左侧工作区" className="lm-sidebar-tabs"><button role="tab" aria-selected={leftPanelTab === 'library'} onClick={() => setLeftPanelTab('library')} className={leftPanelTab === 'library' ? 'is-active' : ''}>图库</button><button role="tab" aria-selected={leftPanelTab === 'adjust'} onClick={() => setLeftPanelTab('adjust')} className={leftPanelTab === 'adjust' ? 'is-active' : ''}>手动修图</button></div><button className="lm-collapse-button" onClick={() => setLeftPanelCollapsed(true)} aria-label="收起左侧面板" title="收起图库／手动修图">‹</button></div>
            <div className="lm-sidebar-content">
              {leftPanelTab === 'library' ? <WorkGroupList groups={groups} photos={photos} activeGroupId={activeGroupId} loading={workGroupsLoading || Boolean(workGroupsError)} error={workGroupsError} onCreate={handleCreateWorkGroup} onSelect={handleSelectWorkGroup} onRename={renameGroup} /> : selected ? (
                <AdjustPanel params={params} onChange={(key, value) => selectedId && setParam(selectedId, key, value)} onResetAll={() => selectedId && resetParams(selectedId)} hasAdjustment={isAdjusted(selected)} processedBuf={processedBuf} step={guidance.step} onStep={goStep} hsl={hsl} onHslParam={(color, axis, value) => selectedId && setHslParam(selectedId, color, axis, value)} onResetHsl={() => selectedId && resetHsl(selectedId)} presets={presets} onApplyPreset={handleApplyPreset} onSavePreset={handleSavePreset} onDeletePreset={handleDeletePreset} localMode={localMode} masks={masks} selectedMaskId={selectedMaskId} onEnterLocal={enterLocal} onExitLocal={exitLocal} onAddGradient={handleAddGradient} onAddRadial={handleAddRadial} onAddBrush={handleAddBrush} onSelectMask={setSelectedMaskId} onRenameMask={handleRenameMask} onToggleMask={handleToggleMask} onRemoveMask={handleRemoveMask} onMaskParam={handleMaskParam} canGenerateSkyCandidate={agentPreviewReady && skyMaskCandidate.status !== 'preparing' && skyMaskCandidate.status !== 'loading' && skyMaskCandidate.status !== 'downloading' && skyMaskCandidate.status !== 'segmenting'} skyCandidateStatus={skyMaskCandidate.status} skyCandidateDetail={skyMaskCandidate.detail} skyCandidateProgress={skyMaskCandidate.progress} onGenerateSkyCandidate={handleGenerateSkyCandidate} onCancelSkyCandidate={skyMaskCandidate.cancel} onAcceptMaskCandidate={handleAcceptMaskCandidate} brushErase={brushErase} onToggleBrushErase={setBrushErase} onClearBrush={handleClearBrush} onBrushSize={handleBrushSize} geometry={geometry} hasGeometry={!isDefaultGeometry(geometry)} onEnterCrop={enterCrop} />
              ) : <div className="p-4 text-xs leading-relaxed text-zinc-500">导入并选择照片后，可在这里手动调整。</div>}
            </div>
          </>}
        </aside>
        <div className="lm-canvas-column flex min-h-0 min-w-0 flex-1 flex-col"><PreviewArea photo={selected} params={params} adjust={adjust} onProcessed={handleProcessed} showOriginal={showOriginal} onShowOriginalChange={setShowOriginal} localMode={localMode} masks={masks} selectedMaskId={selectedMaskId} onUpdateMaskGeom={handleUpdateMaskGeom} onSelectMask={setSelectedMaskId} brushErase={brushErase} onBrushStroke={handleBrushStroke} cropMode={cropMode} geometry={geometry} onUpdateGeometry={handleUpdateGeometry} onExitCrop={exitCrop} /></div>
        <aside className={`lm-right-sidebar${agentPanelCollapsed ? ' is-collapsed' : ''}`} aria-label="Agent 对话">
          {agentPanelCollapsed && <button className="lm-collapsed-toggle" onClick={() => setAgentPanelCollapsed(false)} aria-label="展开 Agent 对话" title="展开 Agent 对话">‹</button>}
          <div className={`lm-agent-inner${agentPanelCollapsed ? ' is-hidden' : ''}`}><AgentToolPanel key={activeGroupId ?? 'no-workgroup'} workGroupId={activeGroupId} workGroupName={activeGroup?.name ?? ''} photo={selected} preview={processedBuf} previewReady={agentPreviewReady} adjustmentRevision={previewAdjustmentKey} adjustments={adjust as Pick<PhotoAdjust, 'global' | 'hsl'>} masks={masks} ready={Boolean(selectedId && isLoaded(selectedId))} canUndo={Boolean(selectedId && canUndo(selectedId))} canRedo={Boolean(selectedId && canRedo(selectedId))} getTransactionState={getTransactionState} getAdjustmentRevision={(photoId) => JSON.stringify({ photoId, adjust: getRawAdjust(photoId) })} onRunPlan={handleAgentPlan} onCreateAutoSkyMask={handleCreateAutoSkyMask} onCancelAutoSkyMask={skyMaskCandidate.cancel} onInspectMask={handleInspectAgentMask} onUndo={(photoId, transactionId) => { if (getTransactionState(photoId, transactionId).canUndo) undo(photoId) }} onRedo={(photoId, transactionId) => { if (getTransactionState(photoId, transactionId).canRedo) redo(photoId) }} onUndoLatest={handleUndo} onRedoLatest={handleRedo} /></div>
          {!agentPanelCollapsed && <button className="lm-agent-collapse-edge" onClick={() => setAgentPanelCollapsed(true)} aria-label="收起 Agent 对话" title="收起 Agent 对话">›</button>}
        </aside>
      </div>
      <div className="lm-bottom-area"><Filmstrip groupName={activeGroup?.name ?? '当前工作组'} photos={groupPhotos} selectedId={selectedId} selectedIds={multiIds} onSelect={setSelectedId} onToggleMulti={toggleMulti} /></div>
      {selected && <ExportDialog open={exportOpen} photo={selected} count={multiIds.length > 0 ? multiIds.length : 1} mode={exportMode} overwriteFormat={overwriteFormat ?? undefined} onConfirm={handleExportConfirm} onCancel={() => !exportBusy && setExportOpen(false)} />}
    </div>
  )
}

export default App
