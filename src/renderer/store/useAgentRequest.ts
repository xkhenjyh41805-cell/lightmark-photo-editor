import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRequestStatus } from '../types'

const PHASE_LABELS: Record<string, string> = {
  preparing: '准备请求', waiting_response: '等待服务响应', reading_response: '接收模型回复',
  parsing_response: '解析模型回复', completed: '请求完成', failed: '请求失败', cancelled: '请求已取消',
}
export function useAgentRequest() {
  const active = useRef<{ id: string; cancelled: boolean; startedAt: number } | null>(null)
  const [status, setStatus] = useState<AgentRequestStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const supported = typeof window.lightmark.cancelAgentRequest === 'function' && typeof window.lightmark.getAgentRequestStatus === 'function'
  const run = useCallback(async <T,>(call: (requestId: string) => Promise<T>): Promise<T> => {
    if (active.current) throw new Error('已有请求进行中。')
    const request = { id: crypto.randomUUID(), cancelled: false, startedAt: Date.now() }
    active.current = request
    setBusy(true); setCancelling(false)
    setStatus({ requestId: request.id, running: true, phase: 'preparing', elapsedMs: 0, timeoutSeconds: 120, receivedBytes: 0 })
    try {
      const result = await call(request.id)
      if (request.cancelled) throw new Error('请求已取消，未执行任何修改。')
      return result
    } finally {
      if (typeof window.lightmark.getAgentRequestStatus === 'function') {
        try { const final = await window.lightmark.getAgentRequestStatus(request.id); if (final) setStatus(final) } catch {}
      }
      active.current = null
      setBusy(false); setCancelling(false)
    }
  }, [])
  const cancel = useCallback(async () => {
    const request = active.current
    if (!request) return
    request.cancelled = true
    setCancelling(true)
    if (typeof window.lightmark.cancelAgentRequest === 'function') {
      try { await window.lightmark.cancelAgentRequest(request.id) } catch {}
    }
  }, [])
  useEffect(() => {
    if (!busy) return
    let stopped = false
    let reading = false
    const timer = setInterval(() => {
      const request = active.current
      if (!request || stopped) return
      setStatus((current) => current ? { ...current, elapsedMs: Date.now() - request.startedAt } : current)
      if (reading || typeof window.lightmark.getAgentRequestStatus !== 'function') return
      reading = true
      void window.lightmark.getAgentRequestStatus(request.id).then((value) => {
        if (!stopped && value) setStatus(value)
      }).catch(() => {}).finally(() => { reading = false })
    }, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [busy])
  useEffect(() => () => {
    const request = active.current
    if (request) {
      request.cancelled = true
      if (typeof window.lightmark.cancelAgentRequest === 'function') void window.lightmark.cancelAgentRequest(request.id).catch(() => {})
    }
  }, [])
  return { run, cancel, busy, cancelling, supported, status, phaseLabel: PHASE_LABELS[status?.phase ?? 'preparing'], elapsedSeconds: Math.floor((status?.elapsedMs ?? 0) / 1000) }
}
