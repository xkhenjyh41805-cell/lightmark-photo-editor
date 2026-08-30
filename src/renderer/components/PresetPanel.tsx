import { useState } from 'react'
import type { Preset } from '../presets'

interface PresetPanelProps {
  presets: Preset[]
  canSave: boolean            // 当前是否有调整可存（无选中照片或全是默认时禁用保存）
  onApply: (preset: Preset) => void
  onSave: (name: string) => void
  onDelete: (presetId: string) => void
}

// 阶段 5.4：修图预设面板。
// 在调整面板里作为独立区块，普通模式下与「局部调整」入口并列。
// 内容：保存当前为预设（命名输入 + 保存按钮）、预设列表（内置 + 用户，点应用/用户项可删）。
//
// 设计取舍：
// - 内置预设不可删，列表项右侧只对 user 预设出现 × 删除。
// - 套用是「替换 global + hsl、保留 masks」，文案提示「保留局部滤镜」。
// - 保存输入框默认隐藏，点「存当前」展开，避免常驻占地方。
export function PresetPanel({
  presets,
  canSave,
  onApply,
  onSave,
  onDelete,
}: PresetPanelProps) {
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  const submitSave = () => {
    const n = name.trim()
    if (!n) return
    onSave(n)
    setName('')
    setSaving(false)
  }

  return (
    <section className="mt-6 border-t border-zinc-800 pt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-zinc-300">修图预设</h3>
        {!saving && (
          <button
            onClick={() => setSaving(true)}
            disabled={!canSave}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
          >
            存当前
          </button>
        )}
      </div>

      {/* 保存输入区（展开式） */}
      {saving && (
        <div className="mb-3 rounded border border-zinc-800 bg-zinc-900/50 p-2.5">
          <input
            type="text"
            value={name}
            autoFocus
            maxLength={20}
            placeholder="预设名称"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSave()
              if (e.key === 'Escape') {
                setName('')
                setSaving(false)
              }
            }}
            className="w-full rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:ring-zinc-500"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={submitSave}
              disabled={!name.trim()}
              className="flex-1 rounded bg-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
            >
              保存
            </button>
            <button
              onClick={() => {
                setName('')
                setSaving(false)
              }}
              className="rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 预设列表 */}
      <ul className="space-y-1">
        {presets.map((p) => (
          <li key={p.id}>
            <div className="group flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] transition-colors hover:bg-zinc-900">
              <button
                onClick={() => onApply(p)}
                title={p.desc ?? p.name}
                className="flex-1 truncate text-left text-zinc-300 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 rounded"
              >
                <span className="text-zinc-300">{p.name}</span>
                {p.kind === 'builtin' && (
                  <span className="ml-1.5 text-[9px] text-zinc-600">内置</span>
                )}
              </button>
              {p.kind === 'user' && (
                <button
                  onClick={() => onDelete(p.id)}
                  aria-label={`删除预设 ${p.name}`}
                  className="shrink-0 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 group-hover:opacity-100"
                >
                  ×
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
        点击套用：替换全局与分色，保留局部滤镜。
      </p>
    </section>
  )
}
