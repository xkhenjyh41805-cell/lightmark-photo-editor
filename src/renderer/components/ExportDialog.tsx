import { useEffect, useState } from 'react'
import {
  type ExportOptions,
  type ExportFormat,
  type ResizeMode,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_PRESETS,
  FORMAT_LABELS,
} from '../export'
import type { Photo } from '../types'

interface ExportDialogProps {
  open: boolean
  photo: Photo
  count: number               // 本次导出几张（1=单张，>1=批量）
  mode: 'new-group' | 'overwrite-original'
  overwriteFormat?: ExportFormat
  initialOptions?: ExportOptions
  onConfirm: (options: ExportOptions) => Promise<void>
  onCancel: () => void
}

// 阶段 4 导出对话框（4.1）。
// 内容：预设（4.5）/ 格式 / 尺寸策略 / 画质。
// 确认后把 options 交给 App，App 跑全分辨率算法并通过 IPC 写文件（4.2，批量 4.4）。
export function ExportDialog({
  open,
  photo,
  count,
  mode,
  overwriteFormat,
  initialOptions,
  onConfirm,
  onCancel,
}: ExportDialogProps) {
  const [opts, setOpts] = useState<ExportOptions>(() => mode === 'overwrite-original'
    ? { ...DEFAULT_EXPORT_OPTIONS, format: overwriteFormat ?? 'jpeg', quality: 100, resizeMode: 'original', longEdge: 0 }
    : initialOptions ?? DEFAULT_EXPORT_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false)

  // 每次打开重置为初始选项 + 清状态
  useEffect(() => {
    if (open) {
      setOpts(mode === 'overwrite-original'
        ? { ...DEFAULT_EXPORT_OPTIONS, format: overwriteFormat ?? 'jpeg', quality: 100, resizeMode: 'original', longEdge: 0 }
        : initialOptions ?? DEFAULT_EXPORT_OPTIONS)
      setBusy(false)
      setError(null)
      setOverwriteConfirmed(false)
    }
  }, [open, mode, overwriteFormat, initialOptions])

  if (!open) return null

  const applyPreset = (options: ExportOptions) => setOpts(options)

  const setFormat = (format: ExportFormat) =>
    setOpts((o) => ({ ...o, format }))

  const setResizeMode = (resizeMode: ResizeMode) =>
    setOpts((o) => ({ ...o, resizeMode }))

  const setQuality = (quality: number) =>
    setOpts((o) => ({ ...o, quality }))

  const setLongEdge = (longEdge: number) =>
    setOpts((o) => ({ ...o, longEdge }))

  const isLossy = opts.format === 'jpeg' || opts.format === 'webp'

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm(opts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // Esc 关闭（非导出中）
  useEffect(() => {
    if (!open || busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-title"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-4">
          <h2 id="export-title" className="text-sm font-medium text-zinc-200">
            {mode === 'overwrite-original' ? `覆盖 ${count > 1 ? `${count} 张` : '原图'}` : count > 1 ? `导出 ${count} 张照片为新的一组` : '导出为新的一组'}
          </h2>
          <span className="max-w-[220px] truncate text-[11px] text-zinc-500">
            {count > 1 ? `含 ${photo.name} 等 ${count} 张` : photo.name}
          </span>
        </div>

        <div className="space-y-5 px-4 py-4">
          {/* 预设只适用于导出新组；覆盖必须保持原格式与原尺寸。 */}
          {mode === 'new-group' && <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              预设
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {EXPORT_PRESETS.map((p) => {
                const active = opts.format === p.options.format
                  && opts.quality === p.options.quality
                  && opts.resizeMode === p.options.resizeMode
                  && opts.longEdge === p.options.longEdge
                return (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p.options)}
                    aria-pressed={active}
                    className={[
                      'rounded border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500',
                      active
                        ? 'border-zinc-400 bg-zinc-800'
                        : 'border-zinc-700 bg-zinc-950 hover:border-zinc-600',
                    ].join(' ')}
                  >
                    <div className="text-xs font-medium text-zinc-200">{p.label}</div>
                    <div className="mt-0.5 text-[10px] leading-tight text-zinc-500">
                      {p.desc}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>}

          {/* 格式 */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              格式
            </h3>
            <div className="flex gap-2">
              {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  aria-pressed={opts.format === f}
                  disabled={mode === 'overwrite-original' && f !== overwriteFormat}
                  className={[
                    'flex-1 rounded border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500',
                    opts.format === f
                      ? 'border-zinc-400 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-600',
                    mode === 'overwrite-original' && f !== overwriteFormat ? 'cursor-not-allowed opacity-35' : '',
                  ].join(' ')}
                >
                  {FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
          </section>

          {/* 尺寸 */}
          {mode === 'overwrite-original' ? <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">尺寸</h3>
            <p className="text-xs text-zinc-300">覆盖时保持原图尺寸，避免缩放改变图库原图规格。</p>
          </section> : <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              尺寸
            </h3>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="radio"
                  name="resize"
                  checked={opts.resizeMode === 'original'}
                  onChange={() => setResizeMode('original')}
                  className="accent-zinc-400"
                />
                原图尺寸
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                <input
                  type="radio"
                  name="resize"
                  checked={opts.resizeMode === 'longEdge'}
                  onChange={() => setResizeMode('longEdge')}
                  className="accent-zinc-400"
                />
                按长边缩放到
                <input
                  type="number"
                  min={1}
                  value={opts.longEdge}
                  disabled={opts.resizeMode !== 'longEdge'}
                  onChange={(e) =>
                    setLongEdge(Math.max(1, Number(e.target.value) || 0))
                  }
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-200 focus:border-zinc-500 focus-visible:outline-none disabled:opacity-40"
                />
                px
              </label>
            </div>
          </section>}

          {/* 画质（仅 jpeg/webp） */}
          {isLossy && (
            <section>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  画质
                </h3>
                <span className="text-xs tabular-nums text-zinc-400">
                  {opts.quality}
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={opts.quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full accent-zinc-400"
                aria-label="画质"
              />
              <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
                <span>小体积</span>
                <span>高画质</span>
              </div>
            </section>
          )}

          {error && (
            <p className="rounded bg-red-950/50 px-3 py-2 text-[11px] text-red-300">
              {error}
            </p>
          )}

          {mode === 'overwrite-original' && (
            <section className="space-y-3 rounded border border-amber-700/60 bg-amber-950/30 p-3">
              <p className="text-xs leading-relaxed text-amber-200">这会替换 LightMark 私有图库中的原图副本，并保留覆盖前备份。导入时你电脑上的源文件不会被修改；成功后当前照片的修图参数和撤销历史将重置，避免重复套用。</p>
              <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-amber-100">
                <input type="checkbox" checked={overwriteConfirmed} onChange={(event) => setOverwriteConfirmed(event.target.checked)} className="mt-0.5 accent-amber-500" />
                <span>我确认覆盖 LightMark 图库中的原图副本。</span>
              </label>
            </section>
          )}
        </div>

        {/* 操作 */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy || (mode === 'overwrite-original' && !overwriteConfirmed)}
            className="rounded bg-zinc-200 px-4 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-50"
          >
            {busy ? mode === 'overwrite-original' ? '覆盖中…' : '导出中…' : mode === 'overwrite-original' ? '确认覆盖' : '导出为新的一组'}
          </button>
        </div>
      </div>
    </div>
  )
}
