import { useEffect, useState } from 'react'
import { localMaskDisplayName, localMaskTypeLabel, normalizeMaskName, type AdjustParams, type LocalMask, type HslParams, type HslColorId, type Geometry } from '../../image'
import { Slider } from './Slider'
import { HistogramView } from './HistogramView'
import { PresetPanel } from './PresetPanel'
import { StepNav } from './StepNav'
import type { Preset } from '../presets'
import type { StepId } from '../guidance'

interface AdjustPanelProps {
  params: AdjustParams
  onChange: (key: keyof AdjustParams, value: number) => void
  onResetAll: () => void
  hasAdjustment: boolean
  processedBuf: import('../../image').ImageBuf | null
  step: StepId
  onStep: (id: StepId) => void

  // 阶段 5.3：HSL 分色（global-only）
  hsl: HslParams
  onHslParam: (color: HslColorId, axis: 'hue' | 'saturation' | 'luminance', value: number) => void
  onResetHsl: () => void

  // 阶段 5.4：修图预设
  presets: Preset[]
  onApplyPreset: (preset: Preset) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (presetId: string) => void

  // 阶段 5.2：局部调整编辑模式
  localMode: boolean
  masks: LocalMask[]
  selectedMaskId: string | null
  onEnterLocal: () => void
  onExitLocal: () => void
  onAddGradient: () => void
  onAddRadial: () => void
  onAddBrush: () => void
  onSelectMask: (id: string) => void
  onRenameMask: (id: string, name: string) => void
  onToggleMask: (id: string, enabled: boolean) => void
  onRemoveMask: (id: string) => void
  onMaskParam: (key: keyof AdjustParams, value: number) => void
  // P1b POC：本地语义分割的天空候选，候选必须由用户采纳后才能启用／供 Agent 使用。
  canGenerateSkyCandidate: boolean
  skyCandidateStatus: import('../store/useSkyMaskCandidate').SkyCandidateStatus
  skyCandidateDetail: string
  skyCandidateProgress: number | null
  onGenerateSkyCandidate: () => void
  onCancelSkyCandidate: () => void
  onAcceptMaskCandidate: (id: string) => void
  // 阶段 5.2b：笔刷
  brushErase: boolean
  onToggleBrushErase: (erase: boolean) => void
  onClearBrush: () => void
  onBrushSize: (size: number, feather: number) => void
  // 阶段 5.6：裁剪旋转
  geometry: Geometry
  hasGeometry: boolean
  onEnterCrop: () => void
}

// 手动调整滑块的统一定义，不再按新手/专业模式隐藏参数。
interface SliderDef {
  key: keyof AdjustParams
  label: string
  min: number
  max: number
  help: string
}

const GROUPS: { step: StepId; title: string; hint: string; items: SliderDef[] }[] = [
  {
    step: 'basic',
    title: '基础校正',
    hint: '先定整体明暗',
    items: [
      { key: 'exposure', label: '曝光', min: -100, max: 100, help: '整体提亮或压暗。每 100 大约相当于 1 档光圈。' },
      { key: 'contrast', label: '对比度', min: -100, max: 100, help: '拉大明暗差距。正值更硬朗，负值更平淡。' },
    ],
  },
  {
    step: 'tone',
    title: '影调',
    hint: '分区域调亮度',
    items: [
      { key: 'highlights', label: '高光', min: -100, max: 100, help: '只动亮部。压高光能救回天空细节。' },
      { key: 'shadows', label: '阴影', min: -100, max: 100, help: '只动暗部。提阴影能救回暗处细节。' },
      { key: 'whites', label: '白色', min: -100, max: 100, help: '影响最亮端，微调画面最亮区域。' },
      { key: 'blacks', label: '黑色', min: -100, max: 100, help: '影响最暗端，微调整体黑场。' },
    ],
  },
  {
    step: 'wb',
    title: '白平衡',
    hint: '调冷暖',
    items: [
      { key: 'temperature', label: '色温', min: -100, max: 100, help: '负值偏冷蓝，正值偏暖黄。' },
      { key: 'tint', label: '色调', min: -100, max: 100, help: '补偿偏绿或偏品红。' },
    ],
  },
  {
    step: 'color',
    title: '色彩',
    hint: '调浓淡',
    items: [
      { key: 'saturation', label: '饱和度', min: -100, max: 100, help: '所有颜色一起加浓或变淡。' },
      { key: 'vibrance', label: '自然饱和度', min: -100, max: 100, help: '只加浓不够饱和的颜色，肤色更安全。' },
    ],
  },
  {
    step: 'detail',
    title: '细节',
    hint: '清与糊',
    items: [
      { key: 'sharpness', label: '锐化', min: 0, max: 100, help: '增强边缘清晰度。过头会出现噪点。' },
      { key: 'noiseReduction', label: '降噪', min: 0, max: 100, help: '抹平噪点。过头会丢失细节发糊。' },
    ],
  },
]

// 局部滤镜里可调的滑块（完整版：复用全局 12 个）
const LOCAL_SLIDERS: SliderDef[] = [
  ...GROUPS[0].items,
  ...GROUPS[1].items,
  ...GROUPS[2].items,
  ...GROUPS[3].items,
  ...GROUPS[4].items,
]

// HSL 8 色色块定义（顺序对应 HSL_COLOR_IDS 色相环）
const HSL_SWATCHES: { id: HslColorId; label: string; css: string }[] = [
  { id: 'red', label: '红', css: '#ef4444' },
  { id: 'orange', label: '橙', css: '#f97316' },
  { id: 'yellow', label: '黄', css: '#eab308' },
  { id: 'green', label: '绿', css: '#22c55e' },
  { id: 'cyan', label: '青', css: '#06b6d4' },
  { id: 'blue', label: '蓝', css: '#3b82f6' },
  { id: 'purple', label: '紫', css: '#a855f7' },
  { id: 'magenta', label: '洋红', css: '#ec4899' },
]

export function AdjustPanel(props: AdjustPanelProps) {
  const {
    params, onChange, onResetAll, hasAdjustment, processedBuf, step, onStep,
    hsl, onHslParam, onResetHsl,
    presets, onApplyPreset, onSavePreset, onDeletePreset,
    localMode, masks, selectedMaskId,
    onEnterLocal, onExitLocal, onAddGradient, onAddRadial, onAddBrush,
    onSelectMask, onRenameMask, onToggleMask, onRemoveMask, onMaskParam,
    canGenerateSkyCandidate, skyCandidateStatus, skyCandidateDetail, skyCandidateProgress,
    onGenerateSkyCandidate, onCancelSkyCandidate, onAcceptMaskCandidate,
    brushErase, onToggleBrushErase, onClearBrush, onBrushSize,
    hasGeometry, onEnterCrop,
  } = props

  // 当前选中的 HSL 颜色段
  const [hslColor, setHslColor] = useState<HslColorId>('red')
  const hslColorLabel = HSL_SWATCHES.find((s) => s.id === hslColor)!.label
  const selectedForName = masks.find((m) => m.id === selectedMaskId) ?? null
  const [maskNameDraft, setMaskNameDraft] = useState('')
  useEffect(() => {
    setMaskNameDraft(selectedForName?.name ?? '')
  }, [selectedForName?.id, selectedForName?.name])
  const commitMaskName = () => {
    if (!selectedForName) return
    const name = normalizeMaskName(maskNameDraft)
    if (name !== selectedForName.name) onRenameMask(selectedForName.id, name)
    setMaskNameDraft(name)
  }

  // ---- 局部调整编辑模式 ----
  if (localMode) {
    const selected = selectedForName
    const isCandidate = Boolean(selected?.candidate)
    const generating = skyCandidateStatus === 'preparing' || skyCandidateStatus === 'loading' || skyCandidateStatus === 'downloading' || skyCandidateStatus === 'segmenting'
    return (
      <aside className="flex w-64 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
        <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-3">
          <span className="text-xs font-medium tracking-wide text-zinc-300">局部调整</span>
          <button
            onClick={onExitLocal}
            className="rounded px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            完成
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <section className="mb-4 rounded border border-sky-900/70 bg-sky-950/20 p-2.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-sky-100">自动天空候选 · POC</h3>
              <span className="text-[10px] text-sky-400">本地模型</span>
            </div>
            <p className="text-[10px] leading-relaxed text-zinc-400">
              首次点击会下载并缓存本地分割模型；当前照片不会发送到你的对话模型、中转站或云端分割服务。生成后请按 Alt 检查红色覆盖范围，再决定采纳或删除。
            </p>
            {generating ? (
              <div className="mt-2">
                <div className="flex items-center justify-between gap-2 text-[10px] text-sky-200">
                  <span>{skyCandidateDetail || '正在准备本地模型…'}</span>
                  {skyCandidateProgress !== null && <span>{skyCandidateProgress}%</span>}
                </div>
                <button
                  onClick={onCancelSkyCandidate}
                  className="mt-2 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                >
                  取消本地候选
                </button>
              </div>
            ) : (
              <button
                onClick={onGenerateSkyCandidate}
                disabled={!canGenerateSkyCandidate}
                className="mt-2 w-full rounded bg-sky-800/80 px-2 py-1.5 text-[11px] text-sky-50 transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-sky-800/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
              >
                生成天空候选蒙版
              </button>
            )}
            {skyCandidateDetail && !generating && <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">{skyCandidateDetail}</p>}
          </section>

          {/* 新建滤镜 */}
          <section className="mb-4">
            <h3 className="mb-2 text-xs font-semibold text-zinc-300">新建</h3>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={onAddGradient}
                className="rounded bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              >
                + 渐变
              </button>
              <button
                onClick={onAddRadial}
                className="rounded bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              >
                + 径向
              </button>
              <button
                onClick={onAddBrush}
                className="rounded bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              >
                + 笔刷
              </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
              渐变压暗天空、径向提亮主体、笔刷涂抹任意区域。
            </p>
          </section>

          {/* 滤镜列表 */}
          {masks.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-2 text-xs font-semibold text-zinc-300">滤镜列表</h3>
              <ul className="space-y-1">
                {masks.map((m, i) => (
                  <li key={m.id}>
                    <div
                      className={[
                        'flex items-center gap-2 rounded px-2 py-1.5 text-[11px] transition-colors',
                        m.id === selectedMaskId
                          ? 'bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600'
                          : 'text-zinc-400 hover:bg-zinc-900',
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) => onToggleMask(m.id, e.target.checked)}
                        aria-label={`启用滤镜 ${i + 1}`}
                        disabled={Boolean(m.candidate)}
                        title={m.candidate ? '请先检查候选范围并点击“接受候选并启用”。' : undefined}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-zinc-400 disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <button
                        onClick={() => onSelectMask(m.id)}
                        className="flex-1 truncate text-left"
                        title={localMaskDisplayName(m)}
                      >
                        {i + 1}. {localMaskDisplayName(m)} {m.candidate ? '· 待确认' : ''}
                      </button>
                      <button
                        onClick={() => onRemoveMask(m.id)}
                        aria-label={`删除滤镜 ${i + 1}`}
                        className="shrink-0 text-zinc-600 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 选中滤镜的参数 */}
          {selected ? (
            <section className="mb-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold text-zinc-300">滤镜参数</h3>
                <span className="text-[10px] text-zinc-600">只影响蒙版内</span>
              </div>

              {isCandidate && (
                <div className="mb-3 rounded border border-amber-800/80 bg-amber-950/30 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-amber-100">天空候选 · 等待你检查</span>
                    <span className="text-[10px] text-amber-400">未启用</span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-100/70">
                    按住 Alt 查看红色范围。可以先用下方笔刷补充或擦除，再采纳。采纳前不会影响照片，也不会发送给 Agent。
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onAcceptMaskCandidate(selected.id)}
                      className="rounded bg-amber-500/80 px-2 py-1.5 text-[11px] font-medium text-zinc-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
                    >
                      接受候选并启用
                    </button>
                    <button
                      onClick={() => onRemoveMask(selected.id)}
                      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                    >
                      拒绝并删除
                    </button>
                  </div>
                </div>
              )}

              <label className="mb-3 block text-[10px] text-zinc-400">
                蒙版名称（给 Agent 识别区域）
                <input
                  aria-label="蒙版名称"
                  value={maskNameDraft}
                  maxLength={32}
                  placeholder={`例如：天空、主体、背景（${localMaskTypeLabel(selected)}）`}
                  onChange={(e) => setMaskNameDraft(e.target.value)}
                  onBlur={commitMaskName}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-700"
                />
                <span className="mt-1 block leading-relaxed text-zinc-600">仅“已采纳、已启用且有名称”的蒙版会发给 Agent；Agent 只能改参数，不能画新区域、改几何或笔触。</span>
              </label>

              {/* 笔刷专属工具：粗细、软度、绘制/擦除切换、清空 */}
              {(selected.geom.type === 'brush' || selected.geom.type === 'raster') && (() => {
                const bg = selected.geom
                return (
                <div className="mb-3 rounded border border-zinc-800 bg-zinc-900/50 p-2.5">
                  <div className="mb-2 flex gap-1">
                    <button
                      onClick={() => onToggleBrushErase(false)}
                      aria-pressed={!brushErase}
                      className={[
                        'flex-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
                        !brushErase
                          ? 'bg-red-900/60 text-red-100 ring-1 ring-red-700'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
                      ].join(' ')}
                    >
                      绘制
                    </button>
                    <button
                      onClick={() => onToggleBrushErase(true)}
                      aria-pressed={brushErase}
                      className={[
                        'flex-1 rounded px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500',
                        brushErase
                          ? 'bg-zinc-200 text-zinc-900'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
                      ].join(' ')}
                    >
                      擦除
                    </button>
                  </div>
                  <Slider
                    label="笔刷大小"
                    help="涂抹区域粗细。数值越大笔触越宽。"
                    value={Math.round(bg.size * 100)}
                    min={1}
                    max={40}
                    onChange={(v) => onBrushSize(v / 100, bg.feather)}
                  />
                  <div className="mt-2">
                    <Slider
                      label="边缘软度"
                      help="笔刷边缘的羽化程度。0=硬边，100=全程软过渡。"
                      value={Math.round(bg.feather * 100)}
                      min={0}
                      max={100}
                      onChange={(v) => onBrushSize(bg.size, v / 100)}
                    />
                  </div>
                  <button
                    onClick={onClearBrush}
                    disabled={bg.strokes.length === 0}
                    className="mt-2 w-full rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                  >
                    {selected.geom.type === 'raster' ? '清空手动修正' : '清空笔触'}
                  </button>
                  <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                    {selected.geom.type === 'raster' ? '在候选范围上补画或擦除。候选本身不会被清空。' : '在预览图上涂抹。绘制加深影响区，擦除挖掉。'}
                  </p>
                </div>
                )
              })()}

              {isCandidate && <p className="mb-2 text-[10px] text-zinc-500">采纳候选后才可调整局部参数并交给 Agent 使用。</p>}
              <div className={isCandidate ? 'pointer-events-none space-y-3 opacity-40' : 'space-y-3'}>
                {LOCAL_SLIDERS.map((item) => (
                  <Slider
                    key={item.key as string}
                    label={item.label}
                    help={item.help}
                    value={selected.adjust[item.key]}
                    min={item.min}
                    max={item.max}
                    onChange={(v) => onMaskParam(item.key, v)}
                  />
                ))}
              </div>
            </section>
          ) : (
            <p className="text-[11px] leading-relaxed text-zinc-600">
              {masks.length === 0
                ? '点上方「+ 渐变」「+ 径向」或「+ 笔刷」新建一个局部滤镜。'
                : '从列表点选一个滤镜来调它的参数。'}
            </p>
          )}

          <p className="mt-4 text-[10px] leading-relaxed text-zinc-600">
            在预览区拖动控制点改范围。按住 Alt 查看红色蒙版。
          </p>
        </div>
      </aside>
    )
  }

  // ---- 普通全图调整模式 ----
  const group = GROUPS.find((g) => g.step === step) ?? GROUPS[0]
  const visibleItems = group.items

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium tracking-wide text-zinc-400">调整</span>
        </div>
        <button
          onClick={onResetAll}
          disabled={!hasAdjustment}
          aria-label="重置全部参数"
          className="rounded px-2 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >
          重置
        </button>
      </div>

      <StepNav step={step} onStep={onStep} />

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <section className="mb-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold text-zinc-300">直方图</h3>
            <span className="text-[10px] text-zinc-600">实时</span>
          </div>
          <HistogramView imageBuf={processedBuf} />
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold text-zinc-300">{group.title}</h3>
            <span className="text-[10px] text-zinc-600">{group.hint}</span>
          </div>
          <div className="space-y-3">
            {visibleItems.map((item) => (
              <Slider
                key={item.key as string}
                label={item.label}
                help={item.help}
                value={params[item.key]}
                min={item.min}
                max={item.max}
                onChange={(v) => onChange(item.key, v)}
              />
            ))}
          </div>
          {/* 阶段 5.3：HSL 分色。仅色彩步骤显示，global-only。 */}
          {group.step === 'color' && (
            <section className="mt-4 border-t border-zinc-800 pt-3">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-semibold text-zinc-300">HSL 分色</h3>
                <button
                  onClick={onResetHsl}
                  aria-label="重置 HSL 分色"
                  className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
                >
                  重置
                </button>
              </div>

              {/* 8 色选择器 */}
              <div className="mb-3 grid grid-cols-8 gap-1">
                {HSL_SWATCHES.map((sw) => (
                  <button
                    key={sw.id}
                    onClick={() => setHslColor(sw.id)}
                    aria-label={sw.label}
                    aria-pressed={hslColor === sw.id}
                    title={sw.label}
                    className={[
                      'h-6 rounded transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
                      hslColor === sw.id ? 'ring-2 ring-zinc-200 scale-105' : 'hover:scale-105',
                    ].join(' ')}
                    style={{ backgroundColor: sw.css }}
                  />
                ))}
              </div>

              {/* 所有 HSL 轴均可直接访问，不再按模式隐藏。 */}
              <div className="space-y-3">
                <Slider
                  label="色相"
                  help={`调整${hslColorLabel}色的色相偏移。正值偏暖一侧，负值偏冷一侧。`}
                  value={hsl[hslColor].hue}
                  min={-100}
                  max={100}
                  onChange={(v) => onHslParam(hslColor, 'hue', v)}
                />
                <Slider
                  label="饱和度"
                  help={`调整${hslColorLabel}色的浓淡。负值变灰，正值更鲜艳。`}
                  value={hsl[hslColor].saturation}
                  min={-100}
                  max={100}
                  onChange={(v) => onHslParam(hslColor, 'saturation', v)}
                />
                <Slider
                  label="明度"
                  help={`调整${hslColorLabel}色的明暗。负值压暗，正值提亮。`}
                  value={hsl[hslColor].luminance}
                  min={-100}
                  max={100}
                  onChange={(v) => onHslParam(hslColor, 'luminance', v)}
                />
              </div>
            </section>
          )}
        </section>

        {/* 修图预设 */}
        <PresetPanel
          presets={presets}
          canSave={hasAdjustment}
          onApply={onApplyPreset}
          onSave={onSavePreset}
          onDelete={onDeletePreset}
        />

        {/* 局部调整入口 */}
        <section className="mt-6 border-t border-zinc-800 pt-4">
          <button
            onClick={onEnterLocal}
            className="w-full rounded bg-zinc-800 px-2 py-2 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            局部调整 {masks.length > 0 ? `(${masks.length})` : ''}
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
            渐变压暗天空、径向提亮主体，只调局部区域。
          </p>
        </section>

        {/* 裁剪旋转入口 */}
        <section className="mt-4 border-t border-zinc-800 pt-4">
          <button
            onClick={onEnterCrop}
            className="w-full rounded bg-zinc-800 px-2 py-2 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            裁剪旋转 {hasGeometry ? '·' : ''}
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
            旋转方向、拉直水平线、按比例二次构图、水平垂直翻转。
          </p>
        </section>
      </div>
    </aside>
  )
}
