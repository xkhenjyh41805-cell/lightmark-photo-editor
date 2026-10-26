import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useDataUrl } from '../store/useDataUrl'
import type { Photo } from '../types'

interface FilmstripProps {
  groupName: string
  photos: Photo[]
  selectedId: string | null
  selectedIds: string[]
  onSelect: (id: string) => void
  onToggleMulti: (id: string) => void
}

export function Filmstrip({ groupName, photos, selectedId, selectedIds, onSelect, onToggleMulti }: FilmstripProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [thumbnailWidth, setThumbnailWidth] = useState(142)
  const [batchMode, setBatchMode] = useState(false)
  const trackStyle = { '--lm-thumb-width': `${thumbnailWidth}px` } as CSSProperties

  const scrollNext = () => trackRef.current?.scrollBy({ left: Math.max(360, thumbnailWidth * 3), behavior: 'smooth' })

  return (
    <section className="lm-filmstrip" aria-label={`${groupName}照片`}>
      <div className="lm-filmstrip-head">
        <span className="lm-filmstrip-title">{groupName} <span>{photos.length} 张照片</span></span>
        <div className="lm-filmstrip-controls" role="toolbar" aria-label="胶片栏控制">
          <button type="button" className={`lm-filmstrip-batch-button${batchMode ? ' is-active' : ''}`} onClick={() => setBatchMode((active) => !active)} aria-pressed={batchMode} aria-label="批量选择照片" title="批量选择照片">☑</button>
          <div className="lm-filmstrip-size-control">
            <button type="button" onClick={() => setThumbnailWidth((size) => Math.max(110, size - 12))} disabled={thumbnailWidth <= 110} aria-label="缩小缩略图">−</button>
            <input type="range" min="110" max="220" step="6" value={thumbnailWidth} onChange={(event) => setThumbnailWidth(Number(event.target.value))} aria-label="缩略图大小" />
            <button type="button" onClick={() => setThumbnailWidth((size) => Math.min(220, size + 12))} disabled={thumbnailWidth >= 220} aria-label="放大缩略图">＋</button>
          </div>
        </div>
      </div>
      <div ref={trackRef} className="lm-filmstrip-track" style={trackStyle}>
        {photos.length === 0 ? (
          <p className="lm-filmstrip-empty">此工作组还没有照片。点击左侧“导入照片”开始。</p>
        ) : photos.map((photo) => (
          <FilmstripItem
            key={photo.id}
            photo={photo}
            active={photo.id === selectedId}
            checked={selectedIds.includes(photo.id)}
            showCheckbox={batchMode || selectedIds.includes(photo.id)}
            onSelect={() => onSelect(photo.id)}
            onToggleMulti={() => onToggleMulti(photo.id)}
          />
        ))}
        {photos.length > 0 && <button type="button" className="lm-filmstrip-next" onClick={scrollNext} aria-label="查看更多照片" title="查看更多照片">›</button>}
      </div>
    </section>
  )
}

function FilmstripItem({ photo, active, checked, showCheckbox, onSelect, onToggleMulti }: {
  photo: Photo
  active: boolean
  checked: boolean
  showCheckbox: boolean
  onSelect: () => void
  onToggleMulti: () => void
}) {
  const thumbUrl = useDataUrl(photo.thumbPath)
  return (
    <div className={`lm-filmstrip-item${active ? ' is-active' : ''}`}>
      <button className="lm-filmstrip-photo" onClick={onSelect} aria-current={active ? 'true' : undefined} title={photo.name}>
        {thumbUrl ? <img src={thumbUrl} alt="" /> : <span className="lm-filmstrip-placeholder" />}
        <span className="lm-filmstrip-name">{photo.name}</span>
      </button>
      <label className={`lm-filmstrip-check${showCheckbox ? ' is-visible' : ''}`} title="加入批量导出">
        <input type="checkbox" checked={checked} onChange={onToggleMulti} aria-label={`选中 ${photo.name} 用于批量导出`} />
      </label>
    </div>
  )
}
