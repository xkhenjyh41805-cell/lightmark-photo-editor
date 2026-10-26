import assert from 'node:assert/strict'
import {
  extractOpenAiChatContent,
  formatAgentError,
  isTaoTokenCodingEndpoint,
  isConsentRemembered,
  normalizeOpenAiBaseUrl,
  parseAgentModelReply,
  PROVIDER_PRESETS,
  providerConsentScope,
} from '../provider.ts'
import type { ProviderPublicConfig } from '../provider.ts'

function test(name: string, run: () => void) {
  try {
    run()
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

const validPlan = {
  version: 1,
  summary: '整体提亮并保留高光',
  steps: [{
    tool: 'adjust_global',
    args: { exposure: 8, highlights: -6 },
    reason: '主体曝光偏低，适度提亮并保护亮部。',
  }],
}

console.log('— OpenAI 兼容 Provider 与模型回复校验 —')
test('Qwen、DeepSeek 预设有 Base URL 和多模态模型名', () => {
  assert.match(PROVIDER_PRESETS.qwen.baseUrl, /^https:\/\//)
  assert.match(PROVIDER_PRESETS.deepseek.baseUrl, /^https:\/\//)
  assert.equal(PROVIDER_PRESETS.qwen.model, 'qwen3-vl-plus')
  assert.equal(PROVIDER_PRESETS.deepseek.model, 'deepseek-flash')
})
test('Base URL 规范化并保留兼容端点前缀路径', () => {
  assert.equal(normalizeOpenAiBaseUrl(' https://example.com/v1/// '), 'https://example.com/v1')
  assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
})
test('拒绝明文公网 HTTP、凭据、查询参数和具体请求路径', () => {
  for (const value of [
    'http://api.example.com/v1',
    'https://name:secret@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/v1/chat/completions',
  ]) assert.throws(() => normalizeOpenAiBaseUrl(value))
})
test('授权范围随 Base URL 与模型名变化', () => {
  const scope = providerConsentScope('https://example.com/v1/', 'vision-model')
  const config: ProviderPublicConfig = {
    preset: 'custom', baseUrl: 'https://example.com/v1', model: 'vision-model',
    apiKeyConfigured: true, rememberedConsentScope: scope,
  }
  assert.equal(isConsentRemembered(config, 'https://example.com/v1', 'vision-model'), true)
  assert.equal(isConsentRemembered(config, 'https://other.example.com/v1', 'vision-model'), false)
  assert.equal(isConsentRemembered(config, 'https://example.com/v1', 'another-model'), false)
})
test('读取兼容 Chat Completions 的字符串和文本块内容', () => {
  assert.equal(extractOpenAiChatContent({ choices: [{ message: { content: 'ok' } }] }), 'ok')
  assert.equal(extractOpenAiChatContent({ choices: [{ message: { content: [{ type: 'text', text: 'one' }, { text: 'two' }] } }] }), 'one\ntwo')
  assert.throws(() => extractOpenAiChatContent({ choices: [] }))
})
test('解析计划和独立主动建议', () => {
  const reply = parseAgentModelReply(JSON.stringify({
    message: '我看到画面整体偏暗，已按你的要求调整。',
    observation: '主体和环境中间调较暗。',
    plan: validPlan,
    suggestions: [{
      observation: '背景比主体更抢眼，可以稍微降低饱和度。',
      plan: { version: 1, summary: '弱化背景色彩', steps: [{
        tool: 'adjust_global', args: { saturation: -5 }, reason: '背景色彩较浓。',
      }] },
    }],
  }))
  assert.equal(reply.plan?.summary, validPlan.summary)
  assert.equal(reply.suggestions.length, 1)
  assert.equal(reply.suggestions[0].observation, '背景比主体更抢眼，可以稍微降低饱和度。')
})
test('可解析围栏 JSON，但拒绝计划越界与未声明工具', () => {
  const wrapped = '```json\n' + JSON.stringify({ message: '已分析。', observation: '', plan: validPlan, suggestions: [] }) + '\n```'
  assert.equal(parseAgentModelReply(wrapped).plan?.version, 1)
  const bad = JSON.stringify({
    message: '执行 shell 命令', observation: '', plan: {
      version: 1, summary: '危险计划', steps: [{ tool: 'run_shell', args: { command: 'x' }, reason: 'x' }],
    }, suggestions: [],
  })
  assert.throws(() => parseAgentModelReply(bad), /安全校验/)
})
test('拒绝未知 envelope 字段和过多建议', () => {
  assert.throws(() => parseAgentModelReply(JSON.stringify({ message: 'ok', observation: '', plan: null, suggestions: [], command: 'x' })))
  assert.throws(() => parseAgentModelReply(JSON.stringify({ message: 'ok', observation: '', plan: null, suggestions: [1, 2, 3, 4] })))
})
test('错误显示去掉IPC前缀并保留授权哨兵', () => {
  assert.equal(formatAgentError(new Error("Error invoking remote method 'agent:ask': Error: 模型请求超时（60 秒）。")), '模型请求超时（60 秒）。')
  assert.equal(formatAgentError(new Error("Error invoking remote method 'agent:ask': Error: PHOTO_CONSENT_REQUIRED")), 'PHOTO_CONSENT_REQUIRED')
})
test('默认超时120秒，Coding Plan仅提示确切域名与路径', () => {
  assert.equal(PROVIDER_PRESETS.qwen.requestTimeoutSeconds, 120)
  assert.equal(isTaoTokenCodingEndpoint('https://api.taotoken.net/coding/v1'), true)
  assert.equal(isTaoTokenCodingEndpoint('https://api.taotoken.net/token/v1'), false)
  assert.equal(isTaoTokenCodingEndpoint('https://api.taotoken.net.example.com/coding/v1'), false)
})
console.log('结果：Provider 测试全部通过')
