
import fs from 'node:fs';
for (const f of fs.readdirSync('.cfb-offline/teacher')) {
  const p = '.cfb-offline/teacher/'+f;
  const st = fs.statSync(p);
  let n = null;
  if (f.endsWith('.jsonl')) { try { n = fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).length; } catch(e){ n = 'ERR'; } }
  console.log(f.padEnd(22), String(st.size).padStart(10), n===null?'':('lines='+n));
}
console.log('--- batch.py head ---');
console.log(fs.readFileSync('.cfb-offline/teacher/batch.py','utf8').split('\n').slice(0,80).join('\n'));
