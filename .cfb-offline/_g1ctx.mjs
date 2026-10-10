import fs from 'node:fs'
const rows = fs.readFileSync('.cfb-offline/teacher/drafts.jsonl', 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
const get = (id) => rows.find((o) => o.id === id)

// 1) 模块名 -> 文件路径：raw 里到底怎么说的？
for (const id of ['aiokitchen_aiomisc_pr199#b13', 'astropy_sphinx-automodapi_pr100#b11', 'barrust_pyprobables_pr116#b8', 'brandon-rhodes_python-skyfield_pr51#b9']) {
  const o = get(id)
  console.log('='.repeat(74))
  console.log(id)
  const a = id.includes('aiomisc') ? 'grpc_server' : id.includes('automodapi') ? 'smart_resolver' : id.includes('pyprobables') ? 'quotientfilter' : 'units'
  for (const [name, txt] of [['RAW', o.raw], ['CTX', o.ctx]]) {
    const i = txt.indexOf(a)
    console.log('  ' + name + ' 中 ' + JSON.stringify(a) + ' 出现的上下文:')
    let k = -1, n = 0
    while ((k = txt.indexOf(a, k + 1)) >= 0 && n < 3) {
      console.log('     ...' + JSON.stringify(txt.slice(Math.max(0, k - 110), k + a.length + 60)))
      n++
    }
    if (n === 0) console.log('     (无)')
  }
}

// 2) test_results/ 那条：raw 里是什么形态
console.log('='.repeat(74))
const o2 = get('blackducksoftware_hub-rest-api-python_pr152#b10')
console.log('blackducksoftware_hub-rest-api-python_pr152#b10')
for (const [name, txt] of [['RAW', o2.raw], ['CTX', o2.ctx]]) {
  let k = -1, n = 0
  while ((k = txt.indexOf('test_results', k + 1)) >= 0 && n < 4) {
    console.log('  ' + name + ': ...' + JSON.stringify(txt.slice(Math.max(0, k - 100), k + 40)))
    n++
  }
  if (!n) console.log('  ' + name + ': (无 test_results)')
}
console.log('  DRAFT 中:')
let k2 = -1
while ((k2 = o2.draft.indexOf('test_results', k2 + 1)) >= 0) {
  console.log('     ...' + JSON.stringify(o2.draft.slice(Math.max(0, k2 - 90), k2 + 40)))
}
