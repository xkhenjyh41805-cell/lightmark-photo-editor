const DEFAULT_TIMEOUT_SECONDS = 120
function validateTimeoutSeconds(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS
  if (!Number.isInteger(value) || value < 60 || value > 300) throw new Error('请求超时须为60到300秒之间的整数。')
  return value
}
function transportError(code, message, phase, elapsedMs, httpStatus) {
  const error = new Error(message)
  Object.assign(error, { code, phase, elapsedMs, httpStatus })
  return error
}
function safeDetail(raw, apiKey) {
  let detail = ''
  try { const data = JSON.parse(raw); detail = typeof data?.error?.message === 'string' ? data.error.message : '' } catch {}
  return detail.replaceAll(apiKey, '[密钥已隐藏]').replace(/data:image\/[^\s"']+/gi, '[图片已隐藏]').slice(0, 300)
}
function contentFromResponse(response) {
  const choice = response?.choices?.[0]
  if (choice?.finish_reason === 'length') throw new Error('模型输出达到长度限制，回复可能被截断；未执行任何修改。请简化指令或选择适合的模型。')
  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n')
    if (text.trim()) return text
  }
  throw new Error('模型未返回可读取的文本；请确认模型支持图片输入和 Chat Completions。')
}
async function callOpenAiCompatible({ baseUrl, model, apiKey, messages, requestTimeoutSeconds, signal, onProgress, timeoutMs: testTimeoutMs, fetchImpl = fetch }) {
  const seconds = validateTimeoutSeconds(requestTimeoutSeconds)
  // Short injected deadline is used by local unit tests only, never supplied by IPC.
  const timeoutMs = testTimeoutMs ?? seconds * 1000
  const controller = new AbortController()
  const startedAt = Date.now()
  let phase = 'waiting_response'
  let timedOut = false
  let receivedBytes = 0
  const cancelled = () => controller.abort()
  if (signal?.aborted) cancelled()
  signal?.addEventListener('abort', cancelled, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const progress = (patch = {}) => onProgress?.({ phase, elapsedMs: Date.now() - startedAt, receivedBytes, ...patch })
  try {
    if (controller.signal.aborted) throw new Error('CANCELLED')
    progress()
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, max_tokens: 1800 }),
    })
    phase = 'reading_response'
    progress({ httpStatus: response.status })
    const reader = response.body?.getReader()
    let raw = ''
    if (reader) {
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          receivedBytes += value.byteLength
          if (receivedBytes > 300000) { await reader.cancel(); throw transportError('RESPONSE_TOO_LARGE', '模型响应超过大小限制；未执行任何修改。', phase, Date.now() - startedAt, response.status) }
          raw += decoder.decode(value, { stream: true })
          progress({ httpStatus: response.status })
        }
        raw += decoder.decode()
      } finally { reader.releaseLock() }
    } else {
      raw = await response.text()
      receivedBytes = new TextEncoder().encode(raw).byteLength
      if (receivedBytes > 300000) throw transportError('RESPONSE_TOO_LARGE', '模型响应超过大小限制；未执行任何修改。', phase, Date.now() - startedAt, response.status)
    }
    if (controller.signal.aborted) throw new Error('CANCELLED')
    if (!response.ok) {
      const detail = safeDetail(raw, apiKey)
      const hint = response.status === 401 || response.status === 403 ? '请核对密钥和入口权限。' : response.status === 429 ? '服务限流或额度受限，请查看服务商控制台。' : response.status >= 500 ? '中转或上游服务异常。' : '请核对模型名、图片输入能力和请求参数。'
      throw transportError('HTTP_ERROR', `模型服务返回 HTTP ${response.status}。${hint}${detail ? ` ${detail}` : ''} 未执行任何修改。`, phase, Date.now() - startedAt, response.status)
    }
    phase = 'parsing_response'
    progress({ httpStatus: response.status })
    let data
    try { data = JSON.parse(raw) } catch {
      throw transportError('INVALID_JSON', '模型服务返回的不是有效JSON，可能是网关页面或不兼容的协议；未执行任何修改。', phase, Date.now() - startedAt, response.status)
    }
    const content = contentFromResponse(data)
    phase = 'completed'
    progress({ httpStatus: response.status })
    return content
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    if (timedOut) {
      const step = phase === 'waiting_response' ? '等待服务响应（含连接、上传和服务排队／生成）' : '读取完整模型回复'
      throw transportError('TIMEOUT', `模型请求超时（${seconds}秒），阶段：${step}。照片没有被修改。可在模型设置延长超时，或检查入口与模型的图片支持。不会自动重试。`, phase, elapsedMs)
    }
    if (signal?.aborted || controller.signal.aborted) throw transportError('CANCELLED', '请求已取消，未执行任何修改。停止本地请求不保证服务商停止生成或计费。', phase, elapsedMs)
    if (error?.code) throw error
    if (error?.name === 'TypeError' && /fetch|network/i.test(error.message)) throw transportError('NETWORK_ERROR', `无法完成模型网络请求${error.cause?.code ? `（${error.cause.code}）` : ''}。请检查网络、代理或服务地址；未执行任何修改。`, phase, elapsedMs)
    throw transportError('RESPONSE_ERROR', error instanceof Error ? error.message : '模型请求失败；未执行任何修改。', phase, elapsedMs)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancelled)
  }
}
module.exports = { DEFAULT_TIMEOUT_SECONDS, validateTimeoutSeconds, callOpenAiCompatible }
