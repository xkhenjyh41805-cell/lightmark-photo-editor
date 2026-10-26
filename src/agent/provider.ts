import { validateEditPlan, type EditPlan } from './plan.ts'

export type ProviderPreset = 'qwen' | 'deepseek' | 'custom'

export interface ProviderDraft {
  preset: ProviderPreset
  baseUrl: string
  model: string
  /** Write-only: blank means keep an already saved key. */
  apiKey?: string
  requestTimeoutSeconds?: number
}

export interface ProviderPublicConfig {
  preset: ProviderPreset
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  rememberedConsentScope: string | null
  requestTimeoutSeconds?: number
  requestControlsVersion?: number
}

export interface AgentSuggestion {
  observation: string
  plan: EditPlan
}

export interface AgentModelReply {
  message: string
  observation: string
  plan: EditPlan | null
  suggestions: AgentSuggestion[]
}

export const PROVIDER_PRESETS: Record<ProviderPreset, Omit<ProviderDraft, 'apiKey'>> = {
  qwen: {
    preset: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-vl-plus',
    requestTimeoutSeconds: 120,
  },
  deepseek: {
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    requestTimeoutSeconds: 120,
  },
  custom: {
    preset: 'custom',
    baseUrl: '',
    model: '',
    requestTimeoutSeconds: 120,
  },
}

export function formatAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '模型请求失败；照片没有被修改。')
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

export function isTaoTokenCodingEndpoint(input: string): boolean {
  try { const u = new URL(input); return u.hostname.toLowerCase() === 'api.taotoken.net' && /^\/coding(?:\/|$)/.test(u.pathname) } catch { return false }
}

export function normalizeOpenAiBaseUrl(input: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 500) {
    throw new Error('请填写有效的 Base URL。')
  }
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Base URL 格式无效。')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Base URL 必须使用 HTTPS；仅本机回环地址可使用 HTTP。')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 不能包含用户名、密码、查询参数或片段。')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (/\/(chat\/completions|responses)$/i.test(url.pathname)) {
    throw new Error('请填写 API 根地址，不要包含具体的请求路径。')
  }
  return url.toString().replace(/\/$/, '')
}

export function providerConsentScope(baseUrl: string, model: string): string {
  return `${normalizeOpenAiBaseUrl(baseUrl).toLowerCase()}|${model.trim()}`
}

export function isConsentRemembered(
  config: ProviderPublicConfig | null,
  baseUrl: string,
  model: string,
): boolean {
  if (!config?.rememberedConsentScope) return false
  try {
    return config.rememberedConsentScope === providerConsentScope(baseUrl, model)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`模型回复中的${label}格式无效。`)
  }
  return value.trim()
}

export function extractOpenAiChatContent(response: unknown): string {
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error('模型返回的 Chat Completions 结构无效。')
  }
  const first = response.choices[0]
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error('模型返回中缺少 assistant message。')
  }
  const content = first.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((part) => isRecord(part) && typeof part.text === 'string')
      .map((part) => (part as Record<string, unknown>).text as string)
    if (parts.length > 0) return parts.join('\n')
  }
  throw new Error('模型没有返回可读取的文本内容。')
}

export function parseAgentModelReply(rawContent: string): AgentModelReply {
  if (typeof rawContent !== 'string' || rawContent.length > 20_000) {
    throw new Error('模型回复为空或超出长度限制。')
  }
  const jsonText = rawContent.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('模型没有按要求返回有效 JSON；未执行任何修改。')
  }
  if (!isRecord(parsed) || !onlyKeys(parsed, ['message', 'observation', 'plan', 'suggestions'])) {
    throw new Error('模型回复包含未允许的字段或结构。')
  }
  const message = requiredText(parsed.message, '说明', 1200)
  const observation = typeof parsed.observation === 'string'
    ? parsed.observation.trim().slice(0, 1200)
    : ''

  let plan: EditPlan | null = null
  if (parsed.plan !== null) {
    const validation = validateEditPlan(parsed.plan)
    if (!validation.ok) throw new Error(`模型主计划未通过安全校验：${validation.error}`)
    plan = validation.plan
  }

  if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length > 3) {
    throw new Error('模型建议必须是最多 3 条的数组。')
  }
  const suggestions = parsed.suggestions.map((item, index): AgentSuggestion => {
    if (!isRecord(item) || !onlyKeys(item, ['observation', 'plan'])) {
      throw new Error(`第 ${index + 1} 条建议包含未允许字段。`)
    }
    const note = requiredText(item.observation, '建议现象说明', 600)
    const validation = validateEditPlan(item.plan)
    if (!validation.ok) throw new Error(`第 ${index + 1} 条建议未通过安全校验：${validation.error}`)
    return { observation: note, plan: validation.plan }
  })

  return { message, observation, plan, suggestions }
}
