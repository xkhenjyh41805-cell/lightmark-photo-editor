import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageBuf } from '../../image'

export interface SkyMaskCandidate {
  width: number
  height: number
  data: Uint8Array
  coverage: number
  modelId: string
}

export type SkyCandidateStatus = 'idle' | 'preparing' | 'loading' | 'downloading' | 'segmenting' | 'error'

interface ActiveRequest {
  id: string
  resolve: (value: SkyMaskCandidate | null) => void
  reject: (reason: Error) => void
}

function formatWorkerError(message: unknown): string {
  const raw = message instanceof Error ? message.message : String(message || '')
  if (/network|fetch|failed to load/i.test(raw)) return '本地分割模型下载失败。请检查网络后重试；照片没有上传到分割服务。'
  if (/out of memory|memory/i.test(raw)) return '本地分割模型内存不足。请关闭其他程序或改用手动蒙版。'
  return raw || '本地天空候选生成失败。请改用手动蒙版或稍后重试。'
}

export function useSkyMaskCandidate() {
  const workerRef = useRef<Worker | null>(null)
  const activeRef = useRef<ActiveRequest | null>(null)
  const sequenceRef = useRef(0)
  const [status, setStatus] = useState<SkyCandidateStatus>('idle')
  const [detail, setDetail] = useState('')
  const [progress, setProgress] = useState<number | null>(null)

  const destroyWorker = useCallback((reason?: Error) => {
    const active = activeRef.current
    activeRef.current = null
    if (workerRef.current) workerRef.current.terminate()
    workerRef.current = null
    if (active && reason) active.reject(reason)
  }, [])

  const getWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current
    const worker = new Worker(new URL('../workers/skySegmentation.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data
      const active = activeRef.current
      if (!active || message.requestId !== active.id) return
      if (message.type === 'progress') {
        const next = message.stage
        if (next === 'preparing' || next === 'loading' || next === 'downloading' || next === 'segmenting') setStatus(next)
        setDetail(typeof message.detail === 'string' ? message.detail : '')
        setProgress(typeof message.progress === 'number' ? message.progress : null)
        return
      }
      activeRef.current = null
      setStatus('idle')
      setProgress(null)
      if (message.type === 'empty') {
        setDetail(typeof message.detail === 'string' ? message.detail : '没有生成可用的天空候选。')
        active.resolve(null)
        return
      }
      if (message.type === 'result') {
        const data = message.data
        const width = message.width
        const height = message.height
        const coverage = message.coverage
        const modelId = message.modelId
        if (!(data instanceof ArrayBuffer) || typeof width !== 'number' || !Number.isInteger(width) || typeof height !== 'number' || !Number.isInteger(height) || typeof coverage !== 'number' || typeof modelId !== 'string') {
          active.reject(new Error('本地分割模型返回了无效候选。'))
          return
        }
        setDetail('已生成天空候选，请检查红色覆盖范围。')
        active.resolve({ width, height, data: new Uint8Array(data), coverage, modelId })
        return
      }
      const error = new Error(formatWorkerError(message.message))
      setStatus('error')
      setDetail(error.message)
      active.reject(error)
    }
    worker.onerror = (event) => {
      const active = activeRef.current
      if (!active) return
      activeRef.current = null
      const error = new Error(formatWorkerError(event.message))
      setStatus('error')
      setDetail(error.message)
      active.reject(error)
    }
    workerRef.current = worker
    return worker
  }, [])

  const generate = useCallback((image: ImageBuf): Promise<SkyMaskCandidate | null> => {
    if (activeRef.current) return Promise.reject(new Error('已有天空候选任务正在进行。'))
    const requestId = `sky-${Date.now()}-${++sequenceRef.current}`
    setStatus('preparing')
    setDetail('照片仅在本机用于生成天空候选。')
    setProgress(null)
    // 把副本交给 Worker，不能脱离当前画布正在使用的 Uint8ClampedArray。
    const rgba = image.data.slice().buffer
    return new Promise<SkyMaskCandidate | null>((resolve, reject) => {
      activeRef.current = { id: requestId, resolve, reject }
      getWorker().postMessage({ type: 'segment', requestId, width: image.width, height: image.height, rgba }, [rgba])
    })
  }, [getWorker])

  const cancel = useCallback(() => {
    if (!activeRef.current) return
    destroyWorker(new Error('已取消本地天空候选生成；没有创建或修改蒙版。'))
    setStatus('idle')
    setProgress(null)
    setDetail('已取消本地天空候选生成。')
  }, [destroyWorker])

  const clearError = useCallback(() => {
    if (status === 'error') {
      setStatus('idle')
      setDetail('')
    }
  }, [status])

  useEffect(() => () => destroyWorker(), [destroyWorker])

  return { status, detail, progress, generate, cancel, clearError }
}
