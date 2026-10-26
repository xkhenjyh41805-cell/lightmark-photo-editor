import { useEffect, useState } from 'react'

// 用主进程读一个文件路径，返回 data URL，供 <img src> 使用
// 路径变化或为空时清空
export function useDataUrl(filePath: string | null): string | null {
  const [loaded, setLoaded] = useState<{ filePath: string; url: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    if (!filePath) {
      setLoaded(null)
      return
    }
    window.lightmark.readDataUrl(filePath).then((dataUrl) => {
      if (alive) setLoaded({ filePath, url: dataUrl })
    }).catch(() => {
      if (alive) setLoaded({ filePath, url: null })
    })
    return () => {
      alive = false
    }
  }, [filePath])

  return loaded?.filePath === filePath ? loaded.url : null
}
