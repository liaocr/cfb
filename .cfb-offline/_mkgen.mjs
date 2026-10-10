
import fs from 'node:fs'
const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l))
const out = dev.map(r => JSON.stringify({ id: r.id, raw: r.raw, ctx: r.ctx, draft: r.assistant }))
fs.writeFileSync('.cfb-offline/_selftest-gen.jsonl', out.join('\n')+'\n')
console.log('wrote', out.length, 'rows (draft = 教师自己的稿)')
