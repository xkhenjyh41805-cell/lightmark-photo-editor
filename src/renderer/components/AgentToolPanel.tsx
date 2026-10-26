import { useEffect, useMemo, useRef, useState } from 'react'
import { validateEditPlan, type EditPlan, type ParameterChange, type PlanIntent, type PlanScope } from '../../agent/plan'
import {
  isConsentRemembered,
  formatAgentError,
  parseAgentModelReply,
  type ProviderDraft,
  type ProviderPublicConfig,
} from '../../agent/provider'
import { isMaskAgentAvailable, localMaskTypeLabel, normalizeMaskName, type ImageBuf, type LocalMask, type PhotoAdjust } from '../../image'
import type { Photo } from '../types'
import { AgentModelSettings } from './AgentModelSettings'
import { groupSuggestions } from '../../agent/timeline'
import type { TransactionStatus } from '../../agent/history'
import { useAgentRequest } from '../store/useAgentRequest'
import { automaticMaskLabel, findExistingMaskForTarget, inferAutomaticMaskTarget } from '../../agent/autoMask'

export type AgentToolRunOutcome =
  | {
      status: 'applied'
      summary: string
      changes: ParameterChange[]
      transactionId?: string
      createdMask?: { id: string; name: string; description: string }
    }
  | { status: 'awaiting_confirmation'; summary: string }
  | { status: 'no_changes'; summary: string }
  | { status: 'failed'; message: string }

interface AgentToolPanelProps {
  workGroupId: string | null
  workGroupName: string
  photo: Photo | null
  preview: ImageBuf | null
  previewReady: boolean
  adjustmentRevision: string
  adjustments: Pick<PhotoAdjust, 'global' | 'hsl'>
  masks: LocalMask[]
  ready: boolean
  canUndo: boolean
  canRedo: boolean
  getTransactionState: (photoId: string, transactionId: string) => { status: TransactionStatus; canUndo: boolean; canRedo: boolean }
  getAdjustmentRevision: (photoId: string) => string
  onRunPlan: (raw: unknown, photoId: string, intent: PlanIntent, confirmed?: boolean, expectedRevision?: string, scope?: PlanScope, autoMask?: LocalMask) => AgentToolRunOutcome
  onCreateAutoSkyMask: (photoId: string, expectedRevision: string) => Promise<LocalMask | null>
  onCancelAutoSkyMask: () => void
  onInspectMask: (photoId: string, maskId: string) => void
  onUndo: (photoId: string, transactionId: string) => void
  onRedo: (photoId: string, transactionId: string) => void
  onUndoLatest: () => void
  onRedoLatest: () => void
}

interface ChatLine {
  id: number
  role: 'user' | 'assistant'
  content: string
  photoId: string
  photoName: string
  observation?: string
  outcome?: AgentToolRunOutcome
  retryPrompt?: string
}

interface PendingSuggestion {
  id: number
  parentMessageId?: number
  photoId: string
  photoName: string
  observation: string
  plan: EditPlan
  adjustmentRevision: string
  outcome?: AgentToolRunOutcome
  dismissed?: boolean
}

interface AskSnapshot {
  prompt: string
  photo: Photo
  previewDataUrl: string
  adjustmentRevision: string
  adjustments: Pick<PhotoAdjust, 'global' | 'hsl'>
  localMasks: AgentMaskDescriptor[]
  autoMask?: LocalMask
  history: { role: 'user' | 'assistant'; content: string }[]
}

interface AgentMaskDescriptor {
  id: string
  name: string
  type: 'gradient' | 'radial' | 'brush' | 'raster'
}

interface AgentConversationRecord {
  version: 1
  messages: ChatLine[]
  suggestions: PendingSuggestion[]
  conversationSummary: string
  compressionCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOutcome(raw: unknown): AgentToolRunOutcome | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.status === 'failed' && typeof raw.message === 'string' && raw.message.length <= 2000) {
    return { status: 'failed', message: raw.message }
  }
  if (typeof raw.summary !== 'string' || raw.summary.length > 1000) return undefined
  if (raw.status === 'awaiting_confirmation' || raw.status === 'no_changes') {
    return { status: raw.status, summary: raw.summary }
  }
  if (raw.status !== 'applied' || !Array.isArray(raw.changes) || raw.changes.length > 12) return undefined
  const changes: ParameterChange[] = []
  for (const change of raw.changes) {
    if (!isRecord(change) || typeof change.path !== 'string' || typeof change.label !== 'string' ||
        typeof change.reason !== 'string' || typeof change.before !== 'number' || !Number.isFinite(change.before) ||
        typeof change.after !== 'number' || !Number.isFinite(change.after)) return undefined
    changes.push({ path: change.path.slice(0, 200), label: change.label.slice(0, 100), reason: change.reason.slice(0, 500), before: change.before, after: change.after })
  }
  const transactionId = typeof raw.transactionId === 'string' && raw.transactionId.length <= 160 ? raw.transactionId : undefined
  let createdMask: { id: string; name: string; description: string } | undefined
  if (isRecord(raw.createdMask) && typeof raw.createdMask.id === 'string' && typeof raw.createdMask.name === 'string' && typeof raw.createdMask.description === 'string') {
    createdMask = { id: raw.createdMask.id.slice(0, 160), name: raw.createdMask.name.slice(0, 80), description: raw.createdMask.description.slice(0, 1000) }
  }
  return { status: 'applied', summary: raw.summary, changes, ...(transactionId ? { transactionId } : {}), ...(createdMask ? { createdMask } : {}) }
}

function normalizeConversation(raw: unknown): AgentConversationRecord | null {
  if (raw === null || raw === undefined) {
    return { version: 1, messages: [], suggestions: [], conversationSummary: '', compressionCount: 0 }
  }
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.messages) || !Array.isArray(raw.suggestions)) return null
  const messages = raw.messages.flatMap((item): ChatLine[] => {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || typeof item.role !== 'string' ||
        (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string' ||
        typeof item.photoId !== 'string' || typeof item.photoName !== 'string') return []
    return [{
      id: item.id as number,
      role: item.role,
      content: item.content.slice(0, 20000),
      photoId: item.photoId.slice(0, 512),
      photoName: item.photoName.slice(0, 512),
      ...(typeof item.observation === 'string' ? { observation: item.observation.slice(0, 4000) } : {}),
      ...(typeof item.retryPrompt === 'string' ? { retryPrompt: item.retryPrompt.slice(0, 2000) } : {}),
      ...(item.outcome ? { outcome: normalizeOutcome(item.outcome) } : {}),
    }]
  })
  const suggestions = raw.suggestions.flatMap((item): PendingSuggestion[] => {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || typeof item.photoId !== 'string' ||
        typeof item.photoName !== 'string' || typeof item.observation !== 'string' || typeof item.adjustmentRevision !== 'string') return []
    const validated = validateEditPlan(item.plan)
    if (!validated.ok) return []
    return [{
      id: item.id as number,
      ...(Number.isSafeInteger(item.parentMessageId) ? { parentMessageId: item.parentMessageId as number } : {}),
      photoId: item.photoId.slice(0, 512),
      photoName: item.photoName.slice(0, 512),
      observation: item.observation.slice(0, 4000),
      plan: validated.plan,
      adjustmentRevision: item.adjustmentRevision.slice(0, 4000),
      ...(item.outcome ? { outcome: normalizeOutcome(item.outcome) } : {}),
      ...(typeof item.dismissed === 'boolean' ? { dismissed: item.dismissed } : {}),
    }]
  })
  return {
    version: 1,
    messages,
    suggestions,
    conversationSummary: typeof raw.conversationSummary === 'string' ? raw.conversationSummary.slice(-3600) : '',
    compressionCount: typeof raw.compressionCount === 'number' && Number.isFinite(raw.compressionCount)
      ? Math.max(0, Math.min(100000, Math.floor(raw.compressionCount)))
      : 0,
  }
}

const LOCAL_REQUEST_PATTERN = /(背景|天空|主体|人物|人像|宠物|猫咪|猫|狗|局部|这部分|这块|区域|蒙版)/
const WHOLE_IMAGE_PATTERN = /(整体|全图|全局|整张|画面整体)/

function inferPlanScope(prompt: string): PlanScope {
  return LOCAL_REQUEST_PATTERN.test(prompt) && !WHOLE_IMAGE_PATTERN.test(prompt) ? 'local_only' : 'any'
}

function availableLocalMasks(masks: LocalMask[]): AgentMaskDescriptor[] {
  return masks
    .filter(isMaskAgentAvailable)
    .slice(0, 24)
    .map((mask) => ({ id: mask.id, name: normalizeMaskName(mask.name), type: mask.geom.type }))
}

function imageBufferToJpegDataUrl(buf: ImageBuf): string {
  const source = document.createElement('canvas')
  source.width = buf.width
  source.height = buf.height
  const sourceContext = source.getContext('2d', { willReadFrequently: true })
  if (!sourceContext) throw new Error('无法准备照片预览。')
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0)

  const scale = Math.min(1, 1600 / Math.max(buf.width, buf.height))
  const width = Math.max(1, Math.round(buf.width * scale))
  const height = Math.max(1, Math.round(buf.height * scale))
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const outputContext = output.getContext('2d')
  if (!outputContext) throw new Error('无法压缩照片预览。')
  outputContext.drawImage(source, 0, 0, width, height)
  return output.toDataURL('image/jpeg', 0.84)
}

function outcomeText(outcome: AgentToolRunOutcome): string {
  if (outcome.status === 'applied') return `已执行，可撤销：${outcome.summary}`
  if (outcome.status === 'no_changes') return `没有需要改变的参数：${outcome.summary}`
  if (outcome.status === 'awaiting_confirmation') return `等待确认：${outcome.summary}`
  return `未执行：${outcome.message}`
}

function compactChatLine(line: ChatLine): string {
  const speaker = line.role === 'user' ? '用户' : 'Agent'
  const observation = line.observation ? `；观察：${line.observation.slice(0, 160)}` : ''
  const changes = line.outcome?.status === 'applied'
    ? `；已调整：${line.outcome.changes.map((change) => `${change.label} ${change.before}→${change.after}`).join('、')}`
    : ''
  return `${speaker}（${line.photoName}）：${line.content.slice(0, 220)}${observation}${changes}`
}

export function AgentToolPanel({
  workGroupId, workGroupName, photo, preview, previewReady, adjustmentRevision, adjustments, masks, ready,
  getTransactionState, getAdjustmentRevision, onRunPlan, onCreateAutoSkyMask, onCancelAutoSkyMask, onInspectMask,
  onUndo, onRedo,
}: AgentToolPanelProps) {
  const [provider, setProvider] = useState<ProviderPublicConfig | null>(null)
  const [providerLoading, setProviderLoading] = useState(true)
  const [providerError, setProviderError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<ChatLine[]>([])
  const [suggestions, setSuggestions] = useState<PendingSuggestion[]>([])
  const [conversationSummary, setConversationSummary] = useState('')
  const [compressionCount, setCompressionCount] = useState(0)
  const [conversationLoaded, setConversationLoaded] = useState(false)
  const [conversationLoadFailed, setConversationLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preparingAutoMask, setPreparingAutoMask] = useState(false)
  const [autoMaskDetail, setAutoMaskDetail] = useState('')
  const [error, setError] = useState('')
  const [askSnapshot, setAskSnapshot] = useState<AskSnapshot | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  const [rememberConsent, setRememberConsent] = useState(false)
  const sequenceRef = useRef(0)
  const conversationToPersistRef = useRef<AgentConversationRecord | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const groupedSuggestions = useMemo(() => groupSuggestions(messages, suggestions), [messages, suggestions])
  const requestControl = useAgentRequest()
  const agentMasks = useMemo(() => availableLocalMasks(masks), [masks])
  const unnamedOrDisabledMaskCount = masks.length - agentMasks.length
  const isWorking = busy || preparingAutoMask

  useEffect(() => {
    let alive = true
    void window.lightmark.getAgentProvider()
      .then((value) => { if (alive) setProvider(value) })
      .catch((e) => { if (alive) setProviderError(e instanceof Error ? e.message : '无法读取模型设置。') })
      .finally(() => { if (alive) setProviderLoading(false) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    setConversationLoaded(false)
    setConversationLoadFailed(false)
    setMessages([])
    setSuggestions([])
    setConversationSummary('')
    setCompressionCount(0)
    sequenceRef.current = 0
    if (!workGroupId) {
      setConversationLoaded(true)
      return () => { alive = false }
    }
    void window.lightmark.readAgentConversation(workGroupId)
      .then((raw) => {
        if (!alive) return
        const restored = normalizeConversation(raw)
        if (!restored) {
          setConversationLoadFailed(true)
          setError('此工作组的对话记录格式无效；为保护原记录，本次未覆盖保存。')
          return
        }
        setMessages(restored.messages)
        setSuggestions(restored.suggestions)
        setConversationSummary(restored.conversationSummary)
        setCompressionCount(restored.compressionCount)
        sequenceRef.current = Math.max(0, ...restored.messages.map((line) => line.id), ...restored.suggestions.map((item) => item.id))
      })
      .catch((reason) => {
        if (!alive) return
        setConversationLoadFailed(true)
        setError(reason instanceof Error ? `读取工作组对话失败：${reason.message}` : '读取工作组对话失败。')
      })
      .finally(() => { if (alive) setConversationLoaded(true) })
    return () => { alive = false }
  }, [workGroupId])

  useEffect(() => {
    if (!workGroupId || !conversationLoaded || conversationLoadFailed) return
    const record: AgentConversationRecord = { version: 1, messages, suggestions, conversationSummary, compressionCount }
    const timer = window.setTimeout(() => {
      void window.lightmark.saveAgentConversation(workGroupId, record)
        .catch((reason) => setError(reason instanceof Error ? `保存工作组对话失败：${reason.message}` : '保存工作组对话失败。'))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [workGroupId, conversationLoaded, conversationLoadFailed, messages, suggestions, conversationSummary, compressionCount])

  conversationToPersistRef.current = conversationLoaded && !conversationLoadFailed
    ? { version: 1, messages, suggestions, conversationSummary, compressionCount }
    : null
  useEffect(() => () => {
    const record = conversationToPersistRef.current
    if (workGroupId && record) void window.lightmark.saveAgentConversation(workGroupId, record).catch(() => {})
  }, [workGroupId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, suggestions, busy])

  useEffect(() => {
    if (messages.length <= 24) return
    const compacted = messages.slice(0, -14).map((line) => `${compactChatLine(line)}${line.outcome?.status === 'applied' && line.outcome.transactionId ? `；当前事务状态：${getTransactionState(line.photoId, line.outcome.transactionId).status}` : ''}`).join('\n')
    const priorSuggestions = suggestions
      .filter((item) => !item.dismissed && !item.outcome)
      .slice(-6)
      .map((item) => `待确认建议（${item.photoName}）：${item.observation.slice(0, 120)}；${item.plan.summary}`)
      .join('\n')
    const completedSuggestions = suggestions
      .filter((item) => !item.dismissed && item.outcome)
      .slice(-4)
      .map((item) => `已处理建议（${item.photoName}，${item.outcome?.status === 'applied' && item.outcome.transactionId ? getTransactionState(item.photoId, item.outcome.transactionId).status : item.outcome?.status}）：${item.observation.slice(0, 120)}；${item.plan.summary}`)
      .join('\n')
    setConversationSummary([compacted, priorSuggestions, completedSuggestions].filter(Boolean).join('\n').slice(-3600))
    setCompressionCount(Math.ceil((messages.length - 14) / 16))
    // Compress model context without dropping the visible per-turn cards.
  }, [messages, suggestions, adjustmentRevision, getTransactionState])

  const previewDataUrl = useMemo(() => {
    if (!preview || !previewReady || !photo) return null
    try { return imageBufferToJpegDataUrl(preview) } catch { return null }
  }, [preview, previewReady, photo])

  const canRun = Boolean(workGroupId && conversationLoaded && !conversationLoadFailed && photo && ready && previewDataUrl)
  const consentRemembered = isConsentRemembered(provider, provider?.baseUrl ?? '', provider?.model ?? '')
  const modelLabel = provider?.preset === 'qwen'
    ? 'Qwen'
    : provider?.preset === 'deepseek'
      ? 'DeepSeek'
      : provider?.preset === 'custom'
        ? '自定义模型'
        : '未配置模型'

  const pushLine = (line: Omit<ChatLine, 'id'>) => {
    sequenceRef.current += 1
    const next = { ...line, id: sequenceRef.current }
    setMessages((current) => [...current, next])
    return next.id
  }

  const runSnapshot = async (snapshot: AskSnapshot, consentMode?: 'once' | 'remember') => {
    let requiresConsent = false
    setBusy(true)
    setError('')
    setPrompt('')
    setConsentOpen(false)
    setAskSnapshot(null)
    try {
      const raw = await requestControl.run((requestId) => window.lightmark.askAgent({
        requestId,
        prompt: snapshot.prompt,
        previewDataUrl: snapshot.previewDataUrl,
        history: snapshot.history,
        currentAdjustments: snapshot.adjustments,
        localMasks: snapshot.localMasks,
        consentMode,
      }))
      const reply = parseAgentModelReply(raw)
      pushLine({
        role: 'user', content: snapshot.prompt, photoId: snapshot.photo.id, photoName: snapshot.photo.name,
      })
      let outcome: AgentToolRunOutcome | undefined
      if (reply.plan) {
        outcome = onRunPlan(
          reply.plan,
          snapshot.photo.id,
          'explicit_request',
          undefined,
          snapshot.adjustmentRevision,
          inferPlanScope(snapshot.prompt),
          snapshot.autoMask,
        )
      }
      const assistantId = pushLine({
        role: 'assistant',
        content: reply.message,
        observation: reply.observation,
        photoId: snapshot.photo.id,
        photoName: snapshot.photo.name,
        outcome,
      })
      if (reply.suggestions.length) {
        const additions = reply.suggestions.map((suggestion) => {
          sequenceRef.current += 1
          return {
            id: sequenceRef.current,
            parentMessageId: assistantId,
            photoId: snapshot.photo.id,
            photoName: snapshot.photo.name,
            observation: suggestion.observation,
            plan: suggestion.plan,
            adjustmentRevision: outcome?.status === 'applied' ? getAdjustmentRevision(snapshot.photo.id) : snapshot.adjustmentRevision,
          }
        })
        setSuggestions((current) => [...current, ...additions])
      }
    } catch (e) {
      const message = formatAgentError(e)
      if (message === 'PHOTO_CONSENT_REQUIRED') {
        requiresConsent = true
        setAskSnapshot(snapshot)
        setRememberConsent(false)
        setConsentOpen(true)
      } else {
        pushLine({
          role: 'user', content: snapshot.prompt, photoId: snapshot.photo.id, photoName: snapshot.photo.name,
        })
        pushLine({
          role: 'assistant',
          content: message,
          photoId: snapshot.photo.id,
          photoName: snapshot.photo.name,
          retryPrompt: snapshot.prompt,
        })
      }
    } finally {
      setBusy(false)
      void window.lightmark.getAgentProvider()
        .then(setProvider)
        .catch((e) => setProviderError(e instanceof Error ? e.message : '无法刷新模型授权状态。'))
      if (!requiresConsent) {
        setAskSnapshot(null)
        setConsentOpen(false)
      }
    }
  }

  const submitText = async (input: string) => {
    const text = input.trim()
    if (!text || !photo || !canRun || isWorking) return
    if (!provider?.apiKeyConfigured) {
      setSettingsOpen(true)
      setError('先配置支持图片输入的模型和 API Key。')
      return
    }

    setError('')
    const scope = inferPlanScope(text)
    let autoMask: LocalMask | undefined
    let localMasks = agentMasks
    if (scope === 'local_only') {
      const target = inferAutomaticMaskTarget(text)
      const reusable = target ? findExistingMaskForTarget(agentMasks, target) : undefined
      if (target && !reusable) {
        setPreparingAutoMask(true)
        setAutoMaskDetail(`正在本机识别${automaticMaskLabel(target)}区域；照片尚未发送给模型。`)
        try {
          const generated = await onCreateAutoSkyMask(photo.id, adjustmentRevision)
          if (!generated) {
            pushLine({ role: 'user', content: text, photoId: photo.id, photoName: photo.name })
            pushLine({
              role: 'assistant',
              content: '我在本机没有识别到足够可靠的天空区域，因此没有上传照片、没有调用模型，也没有修改照片。请改用手动蒙版，或换一张天空更清晰的照片后重试。',
              photoId: photo.id,
              photoName: photo.name,
            })
            setPrompt('')
            return
          }
          if (getAdjustmentRevision(photo.id) !== adjustmentRevision) {
            setError('生成本地选区期间照片已变化；为避免使用旧画面，请重新发送指令。')
            return
          }
          autoMask = generated
          localMasks = [...agentMasks, { id: generated.id, name: generated.name ?? '天空', type: generated.geom.type }]
          setAutoMaskDetail('已在本机选取天空区域，正在请求 Agent 规划局部参数。')
        } catch (e) {
          const message = e instanceof Error ? e.message : '自动天空选区失败。'
          setError(message)
          return
        } finally {
          setPreparingAutoMask(false)
        }
      } else if (agentMasks.length === 0) {
        pushLine({ role: 'user', content: text, photoId: photo.id, photoName: photo.name })
        pushLine({
          role: 'assistant',
          content: '这是局部修图请求，但当前没有可复用的命名蒙版，且本地自动选区暂时只支持“天空”。请在“调整 → 局部调整”创建并命名“背景”“主体”等区域后再发送；为避免误改，Agent 不会把局部要求降级为全图调整。',
          photoId: photo.id,
          photoName: photo.name,
        })
        setPrompt('')
        return
      }
    }

    const snapshot: AskSnapshot = {
      prompt: text,
      photo,
      previewDataUrl: previewDataUrl!,
      adjustmentRevision,
      adjustments: { global: { ...adjustments.global }, hsl: structuredClone(adjustments.hsl) },
      localMasks,
      autoMask,
      history: [
        ...(conversationSummary ? [{ role: 'assistant' as const, content: `此前对话自动摘要：\n${conversationSummary.slice(-1400)}` }] : []),
        ...messages.slice(-14).map((line) => ({ role: line.role, content: `${compactChatLine(line)}${line.outcome?.status === 'applied' && line.outcome.transactionId ? `；应用端当前状态：${getTransactionState(line.photoId, line.outcome.transactionId).status}` : ''}`.slice(0, 1600) })),
      ].slice(-16),
    }
    if (isConsentRemembered(provider, provider.baseUrl, provider.model)) {
      void runSnapshot(snapshot)
    } else {
      setAskSnapshot(snapshot)
      setRememberConsent(false)
      setConsentOpen(true)
    }
  }

  const allowPendingAsk = () => {
    if (!askSnapshot) return
    void runSnapshot(askSnapshot, rememberConsent ? 'remember' : 'once')
  }
  const submit = () => submitText(prompt)

  const approveSuggestion = (item: PendingSuggestion) => {
    if (!photo || !ready || item.photoId !== photo.id || item.adjustmentRevision !== adjustmentRevision || item.outcome) return
    const outcome = onRunPlan(item.plan, item.photoId, 'proactive_suggestion', true, item.adjustmentRevision)
    setSuggestions((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, outcome } : candidate))
    if (outcome.status === 'applied' || outcome.status === 'no_changes') {
      pushLine({ role: 'assistant', photoId: item.photoId, photoName: item.photoName, content: `用户已确认建议：${item.plan.summary}`, outcome })
    }
  }

  const clearConversation = () => {
    setMessages([])
    setSuggestions([])
    setConversationSummary('')
    setCompressionCount(0)
    sequenceRef.current = 0
    setError('')
  }

  const saveProvider = async (draft: ProviderDraft) => {
    const value = await window.lightmark.saveAgentProvider(draft)
    setProvider(value)
    setProviderError('')
    return value
  }
  const clearApiKey = async () => {
    const value = await window.lightmark.clearAgentApiKey()
    setProvider(value)
    return value
  }
  const forgetConsent = async () => {
    const value = await window.lightmark.forgetAgentImageConsent()
    setProvider(value)
    return value
  }
  const testImage = async (draft: ProviderDraft, image: string, consentMode?: 'once' | 'remember', requestId?: string) => {
    try {
      return await window.lightmark.testAgentImage({ provider: draft, previewDataUrl: image, consentMode, requestId })
    } finally {
      void window.lightmark.getAgentProvider()
        .then(setProvider)
        .catch((e) => setProviderError(e instanceof Error ? e.message : '无法刷新模型授权状态。'))
    }
  }

  const renderOutcome = (outcome: AgentToolRunOutcome, photoId: string) => {
    const transaction = outcome.status === 'applied' && outcome.transactionId
      ? getTransactionState(photoId, outcome.transactionId) : null
    const currentPhoto = photoId === photo?.id
    const label = outcome.status !== 'applied' ? outcomeText(outcome)
      : transaction?.status === 'undone' ? `已撤销，可按历史顺序恢复：${outcome.summary}`
      : transaction?.status === 'unavailable' ? `历史记录已失效或被新编辑替代：${outcome.summary}`
      : `已执行：${outcome.summary}`
    return <div className="mt-2 rounded bg-zinc-900/70 p-2">
      <p className="text-[10px] text-zinc-300">{label}</p>
      {outcome.status === 'applied' && outcome.createdMask && transaction?.status === 'applied' && currentPhoto && <div className="mt-1.5 flex items-center justify-between gap-2 rounded border border-emerald-900/60 bg-emerald-950/20 p-1.5">
        <p className="text-[9px] leading-relaxed text-emerald-200">{outcome.createdMask.description}</p>
        <button disabled={isWorking} onClick={() => onInspectMask(photoId, outcome.createdMask!.id)} className="shrink-0 rounded border border-emerald-800 px-2 py-1 text-[9px] text-emerald-200 disabled:opacity-40">查看／修正范围</button>
      </div>}
      {transaction && outcome.status === 'applied' && outcome.transactionId && currentPhoto && <div className="mt-1 flex gap-2">
        {transaction.status === 'applied' && <button disabled={!transaction.canUndo || isWorking} onClick={() => onUndo(photoId, outcome.transactionId!)} title="只能撤销当前最近一步；较早的操作须按历史顺序撤销" className="rounded border border-zinc-700 px-2 py-1 text-[10px] disabled:opacity-30">撤销此步</button>}
        {transaction.status === 'undone' && <button disabled={!transaction.canRedo || isWorking} onClick={() => onRedo(photoId, outcome.transactionId!)} title="有多个撤销步骤时，请按顺序恢复" className="rounded border border-zinc-700 px-2 py-1 text-[10px] disabled:opacity-30">恢复此步</button>}
      </div>}
      {outcome.status === 'applied' && outcome.changes.map((change) => <div key={change.path} className="mt-1.5 border-t border-zinc-800 pt-1.5">
        <p className="text-[10px] text-zinc-200">{change.label}：{change.before} → {change.after}</p>
        <p className="text-[9px] text-zinc-500">{change.reason}</p>
      </div>)}
    </div>
  }

  const renderSuggestion = (item: PendingSuggestion) => {
    const belongsToCurrent = item.photoId === photo?.id
    const stateMatches = item.adjustmentRevision === adjustmentRevision
    const status = item.outcome?.status === 'applied' && item.outcome.transactionId
      ? getTransactionState(item.photoId, item.outcome.transactionId).status : null
    return <article key={item.id} data-suggestion-id={item.id} className="mt-2 rounded border border-amber-800/70 bg-amber-950/20 p-2.5">
      <div className="flex justify-between gap-2">
        <span className="text-[9px] text-amber-300">{status === 'undone' ? '已撤销' : status === 'unavailable' ? '已失效' : item.outcome?.status === 'applied' ? '已采纳' : item.outcome ? '未执行' : '待你确认'}</span>
        {!item.outcome && <button onClick={() => setSuggestions((cur) => cur.map((s) => s.id === item.id ? { ...s, dismissed: true } : s))} className="text-[9px] text-zinc-500">忽略</button>}
      </div>
      <p className="mt-2 text-[10px] text-zinc-300">观察：{item.observation}</p>
      <p className="mt-1 text-[11px] font-medium">建议：{item.plan.summary}</p>
      {item.plan.steps.map((step, i) => <p key={i} className="mt-1 text-[9px] text-zinc-500">{step.reason}</p>)}
      {!belongsToCurrent && <p className="mt-2 text-[9px] text-amber-300">此建议属于“{item.photoName}”；切回该照片后才能采纳。</p>}
      {belongsToCurrent && !stateMatches && !item.outcome && <p className="mt-2 text-[9px] text-amber-300">生成建议后照片已变化，请根据当前画面重新分析。</p>}
      {item.outcome && renderOutcome(item.outcome, item.photoId)}
      {!item.outcome && <button disabled={!belongsToCurrent || !stateMatches || !ready || busy} onClick={() => approveSuggestion(item)} className="mt-2 w-full rounded bg-amber-200 px-2 py-1.5 text-[10px] text-zinc-900 disabled:opacity-40">确认并执行建议</button>}
    </article>
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <span className="text-xs font-medium tracking-wide text-zinc-200">Agent 对话</span>
        <div className="flex items-center gap-2">
          <span className="max-w-28 truncate rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] text-zinc-400" title={provider?.model}>{providerLoading ? '读取模型…' : modelLabel}</span>
          <button onClick={() => setSettingsOpen(true)} aria-label="模型设置" title="模型设置" className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white">⚙</button>
        </div>
      </div>

      <div className="shrink-0 border-b border-zinc-800 px-3 py-2">
        {workGroupName && <p className="mb-1 truncate text-[9px] text-zinc-500" title={workGroupName}>当前工作组：<span className="text-zinc-300">{workGroupName}</span> · 此组独立对话</p>}
        {photo ? (
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[10px] text-zinc-500" title={photo.name}>当前照片：<span className="text-zinc-300">{photo.name}</span></p>
            <span className="shrink-0 text-[9px] text-zinc-600">{!ready ? '载入中…' : !previewDataUrl ? '预览未就绪' : consentRemembered ? '已授权此模型' : '首传需授权'}</span>
          </div>
        ) : <p className="text-[10px] text-zinc-500">选择照片后可开始对话。</p>}
        {photo && agentMasks.length > 0 && <p className="mt-1 text-[9px] leading-relaxed text-emerald-300">可用局部蒙版：{agentMasks.map((mask) => `${mask.name}（${localMaskTypeLabel({ geom: { type: mask.type } as LocalMask['geom'] })}）`).join('、')}</p>}
        {photo && unnamedOrDisabledMaskCount > 0 && <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">另有 {unnamedOrDisabledMaskCount} 个未命名或关闭的蒙版，不会发送给 Agent。</p>}
        {compressionCount > 0 && <p className="mt-1 text-[9px] text-zinc-600">本工作组对话已自动压缩 {compressionCount} 次，组内切换照片仍沿用这段对话。</p>}
        {providerError && <p role="alert" className="mt-1 text-[10px] text-red-300">{providerError}</p>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!conversationLoaded && <p role="status" className="rounded border border-zinc-800 bg-zinc-900/50 p-3 text-[10px] text-zinc-500">正在载入此工作组的对话记录…</p>}
        {conversationLoaded && messages.length === 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3">
            <p className="text-[11px] font-medium text-zinc-200">让 Agent 理解照片并调用现有修图工具</p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">例如：“整体提亮一些，颜色自然一点。”安全范围内的直接要求可自动执行；额外建议会单独说明现象，并等你确认后再改。</p>
            {!provider?.apiKeyConfigured && <button onClick={() => setSettingsOpen(true)} className="mt-2 rounded bg-zinc-200 px-2.5 py-1.5 text-[10px] font-medium text-zinc-900 hover:bg-white">配置多模态模型</button>}
          </div>
        )}

        {messages.map((line) => (
          <article key={line.id} data-message-id={line.id} className={`rounded border p-2.5 ${line.role === 'user' ? 'ml-5 border-zinc-700 bg-zinc-900' : 'mr-2 border-zinc-800 bg-zinc-950'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[9px] uppercase tracking-wide text-zinc-500">{line.role === 'user' ? '你' : 'LightMark Agent'}</span>
              <span className="max-w-28 truncate text-[9px] text-zinc-600" title={line.photoName}>{line.photoName}</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-200">{line.content}</p>
            {line.retryPrompt && <div className="mt-2"><button disabled={busy || !canRun || line.photoId !== photo?.id} onClick={() => submitText(line.retryPrompt!)} className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 disabled:opacity-40">按当前画面重试</button><p className="mt-1 text-[9px] text-zinc-500">会发起新请求；不自动重发。切到其他照片时不可重试此指令。</p></div>}
            {line.observation && <p className="mt-1.5 rounded bg-zinc-900/80 p-2 text-[10px] leading-relaxed text-zinc-400">观察：{line.observation}</p>}
            {line.outcome && renderOutcome(line.outcome, line.photoId)}
            {(groupedSuggestions.get(line.id) ?? []).map(renderSuggestion)}
          </article>
        ))}

        {preparingAutoMask && <div role="status" className="rounded border border-emerald-900/60 bg-emerald-950/20 p-2.5 text-[10px] text-emerald-200"><p>{autoMaskDetail || '正在本机准备自动天空选区…'}</p><p className="mt-1 text-[9px] text-zinc-500">此阶段不上传照片、不调用云端模型，也不会修改照片。</p><button onClick={onCancelAutoSkyMask} className="mt-2 rounded border border-zinc-700 px-2 py-1 text-zinc-200">取消本地选区</button></div>}
        {busy && <div role="status" className="rounded border border-sky-900/60 bg-sky-950/20 p-2.5 text-[10px] text-sky-300"><p>{requestControl.phaseLabel} · 已等待 {requestControl.elapsedSeconds} 秒 / 上限 {provider?.requestTimeoutSeconds ?? 60} 秒</p>{autoMaskDetail && <p className="mt-1 text-[9px] text-emerald-300">{autoMaskDetail}</p>}<p className="mt-1 text-[9px] text-zinc-500">完整回复通过校验前不会修改照片。</p><button disabled={!requestControl.supported || requestControl.cancelling} onClick={() => void requestControl.cancel()} className="mt-2 rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">{requestControl.cancelling ? '取消中…' : '取消请求'}</button></div>}
        {error && <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-2 text-[10px] leading-relaxed text-red-300">{error}</p>}
      </div>

      <div className="shrink-0 border-t border-zinc-800 p-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          disabled={!photo || !ready || isWorking || !conversationLoaded || conversationLoadFailed}
          maxLength={2000}
          rows={3}
          placeholder={!conversationLoaded ? '正在载入工作组对话…' : photo ? '描述你想怎样调整这张照片…（Enter 发送，Shift+Enter 换行）' : '请先选择工作组中的照片'}
          className="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-700 disabled:opacity-50"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button onClick={clearConversation} disabled={!conversationLoaded || conversationLoadFailed || isWorking || (messages.length === 0 && suggestions.length === 0)} className="rounded px-1.5 py-1 text-[9px] text-zinc-600 hover:text-zinc-300 disabled:opacity-30">清空对话</button>
          <button onClick={submit} disabled={!canRun || isWorking || !prompt.trim()} className="rounded bg-zinc-200 px-3 py-1.5 text-[10px] font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">{preparingAutoMask ? '本地选区中…' : busy ? '分析中…' : '发送并修图'}</button>
        </div>
      </div>

      <AgentModelSettings
        open={settingsOpen}
        config={provider}
        previewDataUrl={previewDataUrl}
        onClose={() => setSettingsOpen(false)}
        onSave={saveProvider}
        onClearKey={clearApiKey}
        onForgetConsent={forgetConsent}
        onTestImage={testImage}
      />

      {consentOpen && askSnapshot && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="agent-upload-consent-title" className="w-full max-w-md rounded-lg border border-amber-800/70 bg-zinc-950 p-4 shadow-2xl">
            <h2 id="agent-upload-consent-title" className="text-xs font-semibold text-amber-200">首次发送照片预览前，请确认</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">本次会发送照片“<span className="text-zinc-200">{askSnapshot.photo.name}</span>”当前画布的缩小 JPEG 预览（最长边不超过 1600px）、本轮指令、最近对话摘要／消息及全局／HSL 参数到 <span className="break-all text-zinc-200">{provider?.baseUrl}</span>（{provider?.model}）。不会发送原始高分辨率照片或 sidecar；API Key 会作为认证请求头发往此 Base URL，不会放进图片或对话内容。记住授权后仍由你逐次点击“发送并修图”发起请求，也可随时撤销授权。</p>
            <label className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-zinc-400">
              <input type="checkbox" checked={rememberConsent} onChange={(e) => setRememberConsent(e.target.checked)} className="mt-0.5 accent-amber-400" />
              记住对该 Base URL 与模型的授权，以后不再询问（可以在模型设置中撤销）
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => { setConsentOpen(false); setAskSnapshot(null) }} className="rounded px-3 py-2 text-[10px] text-zinc-400 hover:bg-zinc-800">取消</button>
              <button onClick={allowPendingAsk} disabled={busy} className="rounded bg-amber-200 px-3 py-2 text-[10px] font-medium text-zinc-900 hover:bg-amber-100 disabled:opacity-50">{rememberConsent ? '记住并发送' : '仅允许本次发送'}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
