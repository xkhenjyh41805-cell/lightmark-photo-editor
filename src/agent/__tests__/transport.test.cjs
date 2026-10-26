const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { callOpenAiCompatible: call, validateTimeoutSeconds } = require('../../main/agentTransport.cjs')
let server, base, received, counts = {}, timers = []
const reply = (content = 'ok', finish_reason = 'stop') => JSON.stringify({ choices: [{ finish_reason, message: { content } }] })
const later = (fn, ms) => timers.push(setTimeout(fn, ms))
before(async () => {
  server = http.createServer(async (req, res) => {
    const name = req.url.split('/')[1]
    counts[name] = (counts[name] ?? 0) + 1
    let raw = ''; for await (const chunk of req) raw += chunk
    if (name === 'success') { received = { headers: req.headers, body: JSON.parse(raw), url: req.url }; res.setHeader('Content-Type', 'application/json'); res.end(reply()) }
    else if (name === 'headers-slow' || name === 'cancel') later(() => res.end(reply()), 250)
    else if (name === 'body-slow') { res.setHeader('Content-Type', 'application/json'); res.write('{'); later(() => res.end(reply().slice(1)), 250) }
    else if (name === 'unauthorized') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad test-key data:image/jpeg;base64,AAAA' } })) }
    else if (name === 'limited') { res.statusCode = 429; res.end('{}') }
    else if (name === 'html') res.end('<html>gateway</html>')
    else if (name === 'truncated') res.end(reply('{', 'length'))
    else if (name === 'oversize') res.end('x'.repeat(300100))
    else if (name === 'redirect') { res.statusCode = 302; res.setHeader('Location', `${base}/target/chat/completions`); res.end() }
    else if (name === 'blocks') res.end(reply([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]))
    else res.end(reply())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
const request = (name, extra = {}) => call({ baseUrl: `${base}/${name}`, model: 'test-vision', apiKey: 'test-key', messages: [{ role: 'user', content: 'dummy' }], ...extra })

test('默认120秒，配置只允许60–300秒整数', () => {
  assert.equal(validateTimeoutSeconds(), 120)
  for (const n of [60, 120, 180, 300]) assert.equal(validateTimeoutSeconds(n), n)
  for (const n of [0, 59, 301, 60.5, '120', null, NaN]) assert.throws(() => validateTimeoutSeconds(n))
})
test('保留前缀路径、认证头与非流式请求，诊断不含请求内容', async () => {
  const progress = []
  assert.equal(await request('success', { onProgress: (value) => progress.push(value) }), 'ok')
  assert.equal(received.url, '/success/chat/completions')
  assert.equal(received.headers.authorization, 'Bearer test-key')
  assert.equal(received.body.model, 'test-vision')
  assert.equal(received.body.stream, false)
  assert.equal(received.body.max_tokens, 1800)
  assert.equal(progress.at(-1).phase, 'completed')
  assert(!JSON.stringify(progress).includes('test-key'))
  assert(!JSON.stringify(progress).includes('dummy'))
})
test('等待响应超时，不自动重试', async () => {
  await assert.rejects(request('headers-slow', { timeoutMs: 60 }), (e) => e.code === 'TIMEOUT' && e.phase === 'waiting_response' && /120秒/.test(e.message))
  assert.equal(counts['headers-slow'], 1)
})
test('响应头已收到、正文未完整时超时阶段正确', async () => {
  await assert.rejects(request('body-slow', { timeoutMs: 80 }), (e) => e.code === 'TIMEOUT' && e.phase === 'reading_response')
})
test('请求发出后显式取消，不当成超时', async () => {
  const controller = new AbortController()
  const pending = request('cancel', { signal: controller.signal })
  later(() => controller.abort(), 50)
  await assert.rejects(pending, (e) => e.code === 'CANCELLED' && /未执行/.test(e.message))
})
test('已取消的请求不再发往服务', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(request('cancel-before', { signal: controller.signal }), (e) => e.code === 'CANCELLED')
  assert.equal(counts['cancel-before'], undefined)
})
test('认证错误隐藏密钥和图片data URL', async () => {
  await assert.rejects(request('unauthorized'), (e) => e.code === 'HTTP_ERROR' && e.httpStatus === 401 && !e.message.includes('test-key') && !e.message.includes('AAAA'))
})
test('限流错误与超时区分', async () => {
  await assert.rejects(request('limited'), (e) => e.code === 'HTTP_ERROR' && e.httpStatus === 429)
})
test('网关HTML与截断回复均拒绝', async () => {
  await assert.rejects(request('html'), (e) => e.code === 'INVALID_JSON')
  await assert.rejects(request('truncated'), /截断/)
})
test('正文超过300KB即拒绝，不无限读取', async () => {
  await assert.rejects(request('oversize'), (e) => e.code === 'RESPONSE_TOO_LARGE')
})
test('禁止重定向，密钥不发往新地址', async () => {
  await assert.rejects(request('redirect'))
  assert.equal(counts.target, undefined)
})
test('兼容文本块输出', async () => {
  assert.equal(await request('blocks'), '甲\n乙')
})
