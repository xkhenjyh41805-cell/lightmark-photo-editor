import { useDataUrl } from '../store/useDataUrl'
import type { Photo } from '../types'

interface LibraryListProps {
  photos: Photo[]
  selectedId: string | null
  selectedIds: string[]          // 批量选中的 id（阶段 4 批量导出）
  loading: boolean
  onSelect: (id: string) => void
  onToggleMulti: (id: string) => void  // 点击勾选框
  onRemove: (id: string) => void
  onImport: () => void
}

// 左侧图库列表：导入按钮 + 照片缩略图列表
export function LibraryList({
  photos,
  selectedId,
  selectedIds,
  loading,
  onSelect,
  onToggleMulti,
  onRemove,
  onImport,
}: LibraryListProps) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-xs font-medium tracking-wide text-zinc-400">图库</span>
        <span className="text-[10px] text-zinc-600">
          {photos.length} 张
          {selectedIds.length > 0 && ` · 选 ${selectedIds.length}`}
        </span>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onImport}
          className="w-full rounded bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
        >
          导入照片
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="px-2 py-4 text-xs text-zinc-600">加载中…</p>
        ) : photos.length === 0 ? (
          <p className="px-2 py-4 text-xs leading-relaxed text-zinc-600">
            还没有照片。点上方「导入照片」选几张图试试。
          </p>
        ) : (
          <ul className="space-y-1">
            {photos.map((photo) => (
              <LibraryItem
                key={photo.id}
                photo={photo}
                active={photo.id === selectedId}
                checked={selectedIds.includes(photo.id)}
                onSelect={() => onSelect(photo.id)}
                onToggleMulti={() => onToggleMulti(photo.id)}
                onRemove={() => onRemove(photo.id)}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}

interface LibraryItemProps {
  photo: Photo
  active: boolean
  checked: boolean
  onSelect: () => void
  onToggleMulti: () => void
  onRemove: () => void
}

function LibraryItem({
  photo,
  active,
  checked,
  onSelect,
  onToggleMulti,
  onRemove,
}: LibraryItemProps) {
  const thumbUrl = useDataUrl(photo.thumbPath)

  return (
    <li>
      <div
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        className={[
          'group flex cursor-pointer items-center gap-2 rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500',
          active ? 'bg-zinc-800 ring-1 ring-zinc-700' : 'hover:bg-zinc-900',
        ].join(' ')}
      >
        {/* 批量勾选框：点它只切换多选，不切换预览 */}
        <input
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleMulti}
          aria-label={`选中 ${photo.name} 用于批量导出`}
          className="h-3.5 w-3.5 shrink-0 accent-zinc-400"
        />
        <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-zinc-800">
          {thumbUrl ? (
            <img src={thumbUrl} alt={photo.name} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full animate-pulse bg-zinc-700" />
          )}
        </div>
        <span
          className="flex-1 truncate text-xs text-zinc-300"
          title={photo.name}
        >
          {photo.name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`删除 ${photo.name}`}
          className="shrink-0 rounded px-1 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        >
          ×
        </button>
      </div>
    </li>
  )
}
