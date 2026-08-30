import { useCallback, useEffect, useMemo, useState } from 'react'
import { LibraryList } from './components/LibraryList'
import { PreviewArea } from './components/PreviewArea'
import { AdjustPanel } from './components/AdjustPanel'
import { StepNav } from './components/StepNav'
import { AdviceBar } from './components/AdviceBar'
import { ExportDialog } from './components/ExportDialog'
import { usePhotoLibrary } from './store/usePhotoLibrary'
import { useAdjustments } from './store/useAdjustments'
import { useGuidance } from './store/useGuidance'
import { usePresets } from './store/usePresets'
import type { ImageBuf } from '../image'
import { processPhoto, computeHistogram } from '../image'
import { advise, type Advice, type StepId as AdviceStepId } from '../advisor'
import type { StepId, Mastery } from './guidance'
import { STEPS } from './guidance'
import { makeGradientMask, makeRadialMask, makeBrushMask } from './store/useAdjustments'
import { makePresetAdjust, type Preset } from './presets'
import type { ExportOptions } from './export'
import type { Photo } from './types'
import type { BrushStroke, Geometry } from '../image'
import { isDefaultGeometry } from '../image'

// 加载 data URL 为 HTMLImageElement
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

function App() {
  const {
    photos,
    selected,
    selectedId,
    loading,
    setSelectedId,
    importFromDialog,
    removePhoto,
  } = usePhotoLibrary()

  const {
    getParams,
    getMasks,
    getHsl,
    getGeometry,
    getRawAdjust,
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
    appendBrushStroke,
    setBrushSize,
    applyPreset,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useAdjustments()
  const guidance = useGuidance()
  const { presets, savePreset, deletePreset } = usePresets()

  const params = getParams(selectedId)
  const masks = getMasks(selectedId)
  const hsl = getHsl(selectedId)
  const geometry = getGeometry(selectedId)
  const adjust = getRawAdjust(selectedId ?? '')

  // 阶段 5.2：局部调整编辑模式
  const [localMode, setLocalMode] = useState(false)
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null)
  // 阶段 5.6：裁剪旋转编辑模式（与 localMode 互斥）
  const [cropMode, setCropMode] = useState(false)
  // 阶段 5.2b：笔刷绘制/擦除模式
  const [brushErase, setBrushErase] = useState(false)
  const enterLocal = useCallback(() => {
    setCropMode(false)
    setLocalMode(true)
    // 进入时默认选中第一个滤镜（若有）
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

  // ---- 阶段 5.4：修图预设 ----
  // 套用预设：替换 global + hsl，保留 masks（局部滤镜）。applyPreset 在 useAdjustments 里。
  const handleApplyPreset = useCallback(
    (preset: Preset) => {
      if (!selectedId) return
      applyPreset(selectedId, makePresetAdjust(preset.adjust.global, preset.adjust.hsl))
    },
    [selectedId, applyPreset],
  )

  // 保存当前调整为命名预设（只存 global + hsl）
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

  // 选中照片切换时，从 sidecar 加载该照片的历史参数
  useEffect(() => {
    if (selectedId) ensureLoaded(selectedId)
  }, [selectedId, ensureLoaded])

  // ---- 阶段 5.5：撤销/重做 ----
  // Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做。聚焦在输入控件（文本框）时不拦截。
  const handleUndo = useCallback(() => {
    if (selectedId && canUndo(selectedId)) undo(selectedId)
  }, [selectedId, canUndo, undo])
  const handleRedo = useCallback(() => {
    if (selectedId && canRedo(selectedId)) redo(selectedId)
  }, [selectedId, canRedo, redo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const tag = (e.target as HTMLElement | null)?.tagName
      // 文本输入类不拦截快捷键
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

  // 处理后的像素缓冲，PreviewArea 产出 → 直方图 + advisor 消费
  const [processedBuf, setProcessedBuf] = useState<ImageBuf | null>(null)
  const handleProcessed = useCallback((buf: ImageBuf | null) => {
    setProcessedBuf(buf)
  }, [])

  // 直方图 + 建议：在 processedBuf 变化时算。
  // 直方图每帧重算开销可控（代理图 ≤1200px），建议跟随直方图。
  const { advices } = useMemo<{ advices: Advice[] }>(() => {
    if (!processedBuf) return { advices: [] }
    const h = computeHistogram(processedBuf)
    return { advices: advise(h, params) }
  }, [processedBuf, params])

  const goStep = useCallback(
    (id: StepId) => guidance.goStep(id),
    [guidance],
  )
  const gotoAdviceStep = useCallback(
    (s: AdviceStepId | undefined) => {
      if (s) guidance.goStep(s as StepId)
    },
    [guidance],
  )

  const lastStep = STEPS[STEPS.length - 1].id
  const nextStep = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === guidance.step)
    if (idx < STEPS.length - 1) guidance.goStep(STEPS[idx + 1].id)
  }, [guidance])

  // ---- 阶段 4：导出 ----
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportProgress, setExportProgress] = useState<string | null>(null)

  // 批量多选（4.4）。空时"导出"指当前预览那张；非空时可"导出选中"。
  const [multiIds, setMultiIds] = useState<string[]>([])
  const toggleMulti = useCallback((id: string) => {
    setMultiIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])

  // 把一张照片的全分辨率原图解码 + 跑 applyAdjustments，返回 RGBA 像素
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

  // 对话框确认 → 单张或多张导出
  const handleExportConfirm = useCallback(
    async (options: ExportOptions) => {
      // 决定要导出哪些照片：勾选了多张就导出多张，否则导出当前预览张
      const targets = multiIds.length > 0
        ? photos.filter((p) => multiIds.includes(p.id))
        : selected
          ? [selected]
          : []
      if (targets.length === 0) return
      setExportBusy(true)
      setExportProgress(targets.length === 1 ? null : `0 / ${targets.length}`)

      try {
        if (targets.length === 1) {
          // 单张：走 save 对话框路径
          await exportOne(targets[0], options)
        } else {
          // 批量：先选目录，再逐张算完一次性传过去编码写盘
          const dir = await window.lightmark.exportPickDir()
          if (!dir) return // 取消
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
          await window.lightmark.exportBatch({ dir, items })
        }
        setExportOpen(false)
        setMultiIds([]) // 导出完清空多选
      } finally {
        setExportBusy(false)
        setExportProgress(null)
      }
    },
    [multiIds, photos, selected, exportOne, renderFullResolution],
  )

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-medium tracking-wide">光印 LightMark</span>
          <span className="text-xs text-zinc-500">v0.1 · 阶段 5 局部调整</span>
        </div>
        <div className="flex items-center gap-2">
          {selected && (
            <div className="flex items-center gap-0.5 rounded bg-zinc-900/60 p-0.5">
              <button
                onClick={handleUndo}
                disabled={!canUndo(selectedId)}
                aria-label="撤销"
                title="撤销 (Ctrl+Z)"
                className="rounded px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
              >
                ↶
              </button>
              <button
                onClick={handleRedo}
                disabled={!canRedo(selectedId)}
                aria-label="重做"
                title="重做 (Ctrl+Shift+Z)"
                className="rounded px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
              >
                ↷
              </button>
            </div>
          )}
          {selected && guidance.step !== lastStep && (
            <button
              onClick={nextStep}
              className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
            >
              下一步 →
            </button>
          )}
          {selected && (
            <button
              onClick={() => setExportOpen(true)}
              disabled={exportBusy}
              className="rounded bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-50"
            >
              {exportBusy
                ? exportProgress
                  ? `导出中 ${exportProgress}`
                  : '导出中…'
                : multiIds.length > 0
                  ? `导出选中 ${multiIds.length} 张`
                  : '导出'}
            </button>
          )}
        </div>
      </header>

      {/* AI 建议条：紧贴预览区上方，实时 */}
      <AdviceBar advices={advices} onGotoStep={gotoAdviceStep} />

      <div className="flex flex-1 overflow-hidden">
        <LibraryList
          photos={photos}
          selectedId={selectedId}
          selectedIds={multiIds}
          loading={loading}
          onSelect={setSelectedId}
          onToggleMulti={toggleMulti}
          onRemove={removePhoto}
          onImport={importFromDialog}
        />
        <PreviewArea
          photo={selected}
          params={params}
          adjust={adjust}
          onProcessed={handleProcessed}
          localMode={localMode}
          masks={masks}
          selectedMaskId={selectedMaskId}
          onUpdateMaskGeom={handleUpdateMaskGeom}
          onSelectMask={setSelectedMaskId}
          brushErase={brushErase}
          onBrushStroke={handleBrushStroke}
          cropMode={cropMode}
          geometry={geometry}
          onUpdateGeometry={handleUpdateGeometry}
          onExitCrop={exitCrop}
        />
        {selected ? (
          <AdjustPanel
            params={params}
            onChange={(key, value) =>
              selectedId && setParam(selectedId, key, value)
            }
            onResetAll={() => selectedId && resetParams(selectedId)}
            hasAdjustment={isAdjusted(selected)}
            processedBuf={processedBuf}
            step={guidance.step}
            mastery={guidance.mastery}
            hsl={hsl}
            onHslParam={(color, axis, value) =>
              selectedId && setHslParam(selectedId, color, axis, value)
            }
            onResetHsl={() => selectedId && resetHsl(selectedId)}
            presets={presets}
            onApplyPreset={handleApplyPreset}
            onSavePreset={handleSavePreset}
            onDeletePreset={handleDeletePreset}
            localMode={localMode}
            masks={masks}
            selectedMaskId={selectedMaskId}
            onEnterLocal={enterLocal}
            onExitLocal={exitLocal}
            onAddGradient={handleAddGradient}
            onAddRadial={handleAddRadial}
            onAddBrush={handleAddBrush}
            onSelectMask={setSelectedMaskId}
            onToggleMask={handleToggleMask}
            onRemoveMask={handleRemoveMask}
            onMaskParam={handleMaskParam}
            brushErase={brushErase}
            onToggleBrushErase={setBrushErase}
            onClearBrush={handleClearBrush}
            onBrushSize={handleBrushSize}
            geometry={geometry}
            hasGeometry={!isDefaultGeometry(geometry)}
            onEnterCrop={enterCrop}
          />
        ) : null}
      </div>

      <StepNav
        step={guidance.step}
        mastery={guidance.mastery}
        onStep={goStep}
        onMastery={(m: Mastery) => guidance.setMastery(m)}
        disabled={!selected}
      />

      {selected && (
        <ExportDialog
          open={exportOpen}
          photo={selected}
          count={multiIds.length > 0 ? multiIds.length : 1}
          onConfirm={handleExportConfirm}
          onCancel={() => !exportBusy && setExportOpen(false)}
        />
      )}
    </div>
  )
}

export default App
