import { useEffect, useState } from 'react'

// 用主进程读一个文件路径，返回 data URL，供 <img src> 使用
// 路径变化或为空时清空
export function useDataUrl(filePath: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!filePath) {
      setUrl(null)
      return
    }
    window.lightmark.readDataUrl(filePath).then((dataUrl) => {
      if (alive) setUrl(dataUrl)
    })
    return () => {
      alive = false
    }
  }, [filePath])

  return url
}
