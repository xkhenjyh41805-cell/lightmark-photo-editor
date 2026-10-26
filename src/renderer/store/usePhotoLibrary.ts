import { useCallback, useEffect, useState } from 'react'
import type { Photo } from '../types'

// 图库状态管理：管理照片列表 + 当前选中照片
// 持久化交给主进程（library.json），这里只负责内存状态和与主进程同步
export function usePhotoLibrary() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // 启动时从主进程读图库
  useEffect(() => {
    let alive = true
    window.lightmark.readLibrary().then((list) => {
      if (!alive) return
      setPhotos(list)
      setSelectedId(list.length > 0 ? list[0].id : null)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const importPhotosFromPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return null
    const added = await window.lightmark.importImages(paths)
    if (added.length === 0) return null
    setPhotos((prev) => [...prev, ...added])
    setSelectedId(added[added.length - 1].id)
    return added
  }, [])

  const importPhotosFromDialog = useCallback(async () => {
    const paths = await window.lightmark.pickImages()
    return importPhotosFromPaths(paths)
  }, [importPhotosFromPaths])

  const replacePhoto = useCallback((updatedPhoto: Photo) => {
    setPhotos((prev) => prev.map((photo) => photo.id === updatedPhoto.id ? updatedPhoto : photo))
  }, [])

  const importFromDialog = useCallback(async () => {
    const added = await importPhotosFromDialog()
    return added?.length ?? 0
  }, [importPhotosFromDialog])

  const removePhoto = useCallback(
    async (photoId: string) => {
      const ok = await window.lightmark.removePhoto(photoId)
      if (!ok) return
      setPhotos((prev) => {
        const next = prev.filter((p) => p.id !== photoId)
        if (selectedId === photoId) {
          setSelectedId(next.length > 0 ? next[0].id : null)
        }
        return next
      })
    },
    [selectedId],
  )

  const selected = photos.find((p) => p.id === selectedId) ?? null

  return {
    photos,
    selected,
    selectedId,
    setSelectedId,
    loading,
    importFromDialog,
    importPhotosFromDialog,
    importPhotosFromPaths,
    replacePhoto,
    removePhoto,
  }
}
