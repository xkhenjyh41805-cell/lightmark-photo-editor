import { useEffect, useRef, useState } from 'react'
import type { Photo, WorkGroup } from '../types'
import { useDataUrl } from '../store/useDataUrl'

interface WorkGroupListProps {
  groups: WorkGroup[]
  photos: Photo[]
  activeGroupId: string | null
  loading: boolean
  error: string
  onCreate: () => void
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function WorkGroupList({
  groups,
  photos,
  activeGroupId,
  loading,
  error,
  onCreate,
  onSelect,
  onRename,
}: WorkGroupListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.focus()
  }, [editingId])

  const startRename = (group: WorkGroup) => {
    setEditingId(group.id)
    setDraft(group.name)
  }

  const saveRename = () => {
    if (!editingId) return
    onRename(editingId, draft)
    setEditingId(null)
    setDraft('')
  }

  return (
    <div className="lm-workgroup-list flex min-h-0 flex-1 flex-col">
      <div className="px-3 py-3">
        <button type="button" onClick={onCreate} disabled={loading} className="lm-workgroup-add">
          <span aria-hidden="true">＋</span> 导入照片
        </button>
      </div>

      {error && <p role="alert" className="mx-3 mb-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 text-[10px] leading-relaxed text-rose-700">{error}</p>}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="持续工作组">
        {loading ? (
            <p className="px-2 py-4 text-xs text-zinc-500">正在载入图库…</p>
        ) : groups.length === 0 ? (
          <div className="lm-workgroup-empty">
            <span className="lm-workgroup-empty-icon" aria-hidden="true">▧</span>
            <p>还没有照片</p>
          <span>导入单张或一组照片，即可开始持续修图。组内切换照片会保留同一段对话。</span>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {groups.map((group) => (
              <li key={group.id} className={`lm-workgroup-card${activeGroupId === group.id ? ' is-active' : ''}`}>
                {editingId === group.id ? (
                  <form className="lm-workgroup-rename" onSubmit={(event) => { event.preventDefault(); saveRename() }}>
                    <input
                      ref={inputRef}
                      value={draft}
                      maxLength={80}
                      aria-label="工作组名称"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Escape') { setEditingId(null); setDraft('') } }}
                    />
                    <button type="submit" aria-label="保存工作组名称" title="保存">✓</button>
                  </form>
                ) : (
                  <>
                    <button type="button" className="lm-workgroup-select" onClick={() => onSelect(group.id)} aria-current={activeGroupId === group.id ? 'true' : undefined}>
                      <WorkGroupCover photo={photos.find((photo) => photo.id === group.photoIds[0]) ?? null} />
                      <span className="min-w-0 flex-1">
                        <span className="lm-workgroup-name">{group.name}</span>
                        <span className="lm-workgroup-meta">{group.photoIds.length} 张照片 <span aria-hidden="true">·</span> 1 段对话</span>
                      </span>
                    </button>
                    <button type="button" className="lm-workgroup-rename-button" onClick={() => startRename(group)} aria-label={`重命名 ${group.name}`} title="重命名工作组">···</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  )
}

function WorkGroupCover({ photo }: { photo: Photo | null }) {
  const url = useDataUrl(photo?.thumbPath ?? null)
  return url
    ? <img className="lm-workgroup-cover" src={url} alt="" />
    : <span className="lm-workgroup-icon" aria-hidden="true">▧</span>
}
