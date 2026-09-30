// 第二实现：从事件序列和实际响应独立判定，不读策略名/故障标签。
let text = ''
process.stdin.setEncoding('utf8'); process.stdin.on('data', (s) => { text += s })
process.stdin.on('end', () => {
  try {
    const r = JSON.parse(text), kinds = r.events.map((e) => e.kind)
    const arrived = kinds.indexOf('primary-complete'), checked = kinds.indexOf('assert')
    const okay = arrived >= 0 && !kinds.includes('hedge-start') && checked > arrived && r.events[checked].wasComplete === true && r.identity.model === 'local-model' && r.identity.fingerprint === 'local-fp'
    console.log(JSON.stringify({ okay }))
  } catch { process.exitCode = 1 }
})
