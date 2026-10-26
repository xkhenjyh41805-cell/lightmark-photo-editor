import { useEffect, useState } from 'react'
import {
  isConsentRemembered,
  formatAgentError,
  isTaoTokenCodingEndpoint,
  PROVIDER_PRESETS,
  type ProviderDraft,
  type ProviderPreset,
  type ProviderPublicConfig,
} from '../../agent/provider'
import { useAgentRequest } from '../store/useAgentRequest'

interface AgentModelSettingsProps {
  open: boolean
  config: ProviderPublicConfig | null
  previewDataUrl: string | null
  onClose: () => void
  onSave: (draft: ProviderDraft) => Promise<ProviderPublicConfig>
  onClearKey: () => Promise<ProviderPublicConfig>
  onForgetConsent: () => Promise<ProviderPublicConfig>
  onTestImage: (draft: ProviderDraft, previewDataUrl: string, consentMode?: 'once' | 'remember', requestId?: string) => Promise<string>
}

export function AgentModelSettings({
  open, config, previewDataUrl, onClose, onSave, onClearKey, onForgetConsent, onTestImage,
}: AgentModelSettingsProps) {
  const [draft, setDraft] = useState<ProviderDraft>({ ...PROVIDER_PRESETS.qwen, apiKey: '' })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState('')
  const [consentOpen, setConsentOpen] = useState(false)
  const [rememberChoice, setRememberChoice] = useState(false)
  const request = useAgentRequest()
  const savedKeyMatchesDraft = Boolean(
    config?.apiKeyConfigured &&
    config.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === draft.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
  )

  useEffect(() => {
    if (!open || dirty) return
    const preset: ProviderPreset = config?.preset ?? 'qwen'
    setDraft({
      preset,
      baseUrl: config?.baseUrl ?? PROVIDER_PRESETS[preset].baseUrl,
      model: config?.model ?? PROVIDER_PRESETS[preset].model,
      apiKey: '',
      requestTimeoutSeconds: config?.requestTimeoutSeconds ?? (config ? 60 : 120),
    })
    setError('')
    setTestResult('')
    setConsentOpen(false)
    setDirty(false)
  }, [open, config, dirty])

  if (!open) return null

  const applyPreset = (preset: ProviderPreset) => {
    const defaults = PROVIDER_PRESETS[preset]
    setDraft((current) => ({ ...defaults, apiKey: current.apiKey ?? '', requestTimeoutSeconds: current.requestTimeoutSeconds ?? 120 }))
    setDirty(true)
    setError('')
    setTestResult('')
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave(draft)
      setTestResult('模型设置已保存。API Key 不会返回到表单。')
      setDraft((current) => ({ ...current, apiKey: '' }))
      setDirty(false)
    } catch (e) {
      setError(formatAgentError(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async (consentMode?: 'once' | 'remember') => {
    if (!previewDataUrl) {
      setError('当前照片预览尚未准备好，请稍候再测试。')
      return
    }
    setBusy(true)
    setError('')
    setTestResult('')
    setConsentOpen(false)
    try {
      const result = await request.run((requestId) => onTestImage(draft, previewDataUrl, consentMode, requestId))
      setTestResult(`图文连接成功：${result}`)
      setDraft((current) => ({ ...current, apiKey: '' }))
    } catch (e) {
      setError(formatAgentError(e))
    } finally {
      setBusy(false)
    }
  }

  const startTest = () => {
    setError('')
    setTestResult('')
    if (isConsentRemembered(config, draft.baseUrl, draft.model)) {
      void test()
    } else {
      setRememberChoice(false)
      setConsentOpen(true)
    }
  }

  const allowTest = () => {
    void test(rememberChoice ? 'remember' : 'once')
  }

  const clearKey = async () => {
    setBusy(true)
    setError('')
    try {
      await onClearKey()
      setTestResult('本机已保存的 API Key 已清除。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '清除 API Key 失败。')
    } finally {
      setBusy(false)
    }
  }

  const forgetConsent = async () => {
    setBusy(true)
    setError('')
    try {
      await onForgetConsent()
      setTestResult('已撤销记住的照片上传授权；下次发送前会再次询问。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销照片上传授权失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="agent-model-title" className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="agent-model-title" className="text-sm font-semibold text-zinc-100">多模态模型设置</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">使用 OpenAI Chat Completions 兼容接口。具体模型必须支持图片输入。</p>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white">关闭</button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-[11px] text-zinc-400">
            接口预设
            <select
              value={draft.preset}
              disabled={busy}
              onChange={(e) => applyPreset(e.target.value as ProviderPreset)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none focus:border-sky-600"
            >
              <option value="qwen">通义千问（Qwen）</option>
              <option value="deepseek">DeepSeek</option>
              <option value="custom">自定义 OpenAI 兼容接口</option>
            </select>
          </label>

          <label className="block text-[11px] text-zinc-400">
            Base URL（API 根地址，不含 /chat/completions）
              <input value={draft.baseUrl} disabled={busy} onChange={(e) => { setDirty(true); setDraft((s) => ({ ...s, baseUrl: e.target.value })) }} placeholder="https://api.example.com/v1" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none focus:border-sky-600" />
            {draft.preset === 'qwen' && <span className="mt-1 block text-[10px] text-zinc-600">Qwen 区域端点可能需要控制台提供的 Workspace ID 专属 Base URL；可直接在此替换预设地址。</span>}
            {isTaoTokenCodingEndpoint(draft.baseUrl) && <span className="mt-1 block text-[10px] text-amber-300">这是 TaoToken 的 Coding Plan 编程入口；请向服务商确认它允许图像分析／修图用途，以及该模型支持图片输入。换到 Token Plan 或按量地址会改变计费入口，应用不会自动替换。</span>}
          </label>

          <label className="block text-[11px] text-zinc-400">
            支持图片输入的模型名
              <input value={draft.model} disabled={busy} onChange={(e) => { setDirty(true); setDraft((s) => ({ ...s, model: e.target.value })) }} placeholder="填写服务商提供的视觉模型 ID" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none focus:border-sky-600" />
          </label>

          <label className="block text-[11px] text-zinc-400">
            API Key（只写入，不回显）
            <input type="password" autoComplete="new-password" value={draft.apiKey ?? ''} disabled={busy} onChange={(e) => { setDirty(true); setDraft((s) => ({ ...s, apiKey: e.target.value })) }} placeholder={savedKeyMatchesDraft ? '该地址已有密钥；留空则保留' : config?.apiKeyConfigured ? '当前地址不同；请输入此服务商的 API Key' : '粘贴服务商 API Key'} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100 outline-none focus:border-sky-600" />
            <span className="mt-1 block text-[10px] text-zinc-600">{savedKeyMatchesDraft ? '本机已有绑定此 Base URL 的加密密钥。' : config?.apiKeyConfigured ? '已保存的密钥绑定其他 Base URL；不会发送给新地址，请重新输入。' : '密钥只交给 Electron 主进程加密保存，不写入普通配置文件。'}</span>
          </label>

          <label className="block text-[11px] text-zinc-400">
            请求超时
            <select aria-label="请求超时" value={draft.requestTimeoutSeconds ?? 120} disabled={busy || !config?.requestControlsVersion} onChange={(e) => { setDirty(true); setDraft((s) => ({ ...s, requestTimeoutSeconds: Number(e.target.value) })) }} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-100">
              {[60, 120, 180, 300].map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒{seconds === 120 ? '（默认）' : ''}</option>)}
            </select>
            <span className="mt-1 block text-[10px] text-zinc-600">较慢的中转／推理模型可适当延长；延长不保证成功。超时后不自动重发，避免重复调用。</span>
            {!config?.requestControlsVersion && <span className="mt-1 block text-[10px] text-amber-300">当前主进程尚未加载超时和取消功能，请保存对话后重启应用。</span>}
          </label>

          <div className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-[10px] leading-relaxed text-zinc-500">
            图文测试会发送当前画布的 JPEG 预览和固定测试语句。Agent 分析会发送预览、你的本轮指令、最近对话摘要／消息及当前全局／HSL 参数；两种请求都不会发送原始高分辨率文件或 sidecar。API Key 会作为认证请求头发送到上面的 Base URL，不会放进图片或对话内容。服务商的数据处理仍受其自身政策约束。
          </div>

          {error && <p role="alert" className="rounded border border-red-900/70 bg-red-950/30 p-2 text-[11px] text-red-300">{error}</p>}
          {testResult && <p role="status" className="rounded border border-emerald-900/70 bg-emerald-950/30 p-2 text-[11px] text-emerald-300">{testResult}</p>}
          {request.busy && <div role="status" className="flex items-center justify-between gap-2 text-[11px] text-sky-300"><span>{request.phaseLabel} · 已等待 {request.elapsedSeconds} 秒</span><button disabled={!request.supported || request.cancelling} onClick={() => void request.cancel()} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">{request.cancelling ? '取消中…' : '取消测试'}</button></div>}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3">
            <div className="flex flex-wrap gap-2">
              <button onClick={startTest} disabled={busy || !previewDataUrl} className="rounded border border-zinc-700 px-3 py-2 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">测试图文连接</button>
              <button onClick={() => void save()} disabled={busy} className="rounded bg-zinc-200 px-3 py-2 text-[11px] font-medium text-zinc-900 hover:bg-white disabled:opacity-40">保存配置</button>
            </div>
            <div className="flex gap-2">
              {config?.apiKeyConfigured && <button onClick={() => void clearKey()} disabled={busy} className="rounded px-2 py-2 text-[10px] text-zinc-500 hover:text-red-300 disabled:opacity-40">清除密钥</button>}
              {config?.rememberedConsentScope && <button onClick={() => void forgetConsent()} disabled={busy} className="rounded px-2 py-2 text-[10px] text-zinc-500 hover:text-amber-300 disabled:opacity-40">撤销记住的传图授权</button>}
            </div>
          </div>
        </div>

        {consentOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-5">
            <div role="dialog" aria-modal="true" aria-labelledby="model-test-consent-title" className="w-full max-w-sm rounded-lg border border-amber-800/70 bg-zinc-950 p-4 shadow-xl">
              <h3 id="model-test-consent-title" className="text-xs font-semibold text-amber-200">允许发送照片预览进行图文测试？</h3>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">将把当前画布的缩小 JPEG 预览和固定测试语句发送至 <span className="break-all text-zinc-200">{draft.baseUrl}</span>，模型为 <span className="text-zinc-200">{draft.model}</span>；API Key 会作为认证请求头发往此 Base URL。不会发送原始高分辨率文件或 sidecar。</p>
              <label className="mt-3 flex items-start gap-2 text-[10px] leading-relaxed text-zinc-400">
                <input type="checkbox" checked={rememberChoice} onChange={(e) => setRememberChoice(e.target.checked)} className="mt-0.5 accent-amber-400" />
                记住对该 Base URL 与模型的授权，以后不再询问（可在设置中撤销）
              </label>
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setConsentOpen(false)} className="rounded px-3 py-2 text-[10px] text-zinc-400 hover:bg-zinc-800">取消</button>
                <button onClick={allowTest} disabled={busy} className="rounded bg-amber-200 px-3 py-2 text-[10px] font-medium text-zinc-900 hover:bg-amber-100 disabled:opacity-50">{rememberChoice ? '记住并允许测试' : '仅允许本次测试'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
