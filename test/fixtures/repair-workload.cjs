// 真实 loopback HTTP + 计时器。只输出原始事件/返回值；不读取任何模型配置或密钥。
const fs = require('node:fs'), http = require('node:http'), { performance } = require('node:perf_hooks')
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'))
const fixture = JSON.parse(fs.readFileSync('fixture.json', 'utf8'))
const events = []; let requests = 0, complete = false, asserted = false, hedgeTimer
const mark = (kind, extra = {}) => events.push({ kind, at: performance.now(), ...extra })
const assert = () => { if (!asserted) { asserted = true; mark('assert', { wasComplete: complete }) } }
const server = http.createServer((req, res) => {
  requests++
  if (req.url === '/hedge') { res.end('{}'); return }
  const wrong = fixture.identityFault && config.route === 'legacy'
  const identity = { model: wrong && fixture.wrongField === 'model' ? 'wrong-model' : 'local-model', fingerprint: wrong && fixture.wrongField === 'fingerprint' ? 'wrong-fp' : 'local-fp' }
  const body = Buffer.from(JSON.stringify({ ...identity, note: '中文🙂', request: 'primary' }))
  const send = () => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Model', identity.model); res.setHeader('X-Fingerprint', identity.fingerprint)
    if (['chunked-json', 'split-utf8', 'chunked-header'].includes(fixture.transport)) {
      const at = fixture.transport === 'split-utf8' ? body.indexOf(Buffer.from('中')) + 1 : Math.floor(body.length / 2)
      res.write(body.subarray(0, at)); setTimeout(() => res.end(body.subarray(at)), 2)
    } else res.end(body)
  }
  setTimeout(send, fixture.primaryDelayMs + (fixture.transport === 'delayed-headers' ? 3 : 0))
})
server.listen(0, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + server.address().port
  mark('request-start')
  const req = http.get(base + '/primary', { agent: false }, (res) => {
    const chunks = []; res.on('data', (b) => chunks.push(b))
    res.on('end', () => {
      clearTimeout(hedgeTimer); complete = true; mark('primary-complete')
      assert()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const identity = ['header-identity', 'chunked-header'].includes(fixture.transport) ? { model: res.headers['x-model'], fingerprint: res.headers['x-fingerprint'] } : { model: body.model, fingerprint: body.fingerprint }
      server.closeAllConnections(); server.close(() => console.log(JSON.stringify({ events, identity, requests })))
    })
  })
  req.on('error', (e) => { console.error(e.code || e.message); process.exitCode = 1; clearTimeout(hedgeTimer); server.closeAllConnections(); server.close() })
  hedgeTimer = setTimeout(() => { if (!complete) { mark('hedge-start'); http.get(base + '/hedge', { agent: false }, (r) => r.resume()).on('error', () => {}) } }, config.waitMs)
  if (fixture.earlyAssertion && config.assertMode === 'legacy') setTimeout(assert, 0)
})
