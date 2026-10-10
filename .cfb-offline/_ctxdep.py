# -*- coding: utf-8 -*-
import io, json, re
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
OUT = io.open(r'D:\cfb\.cfb-offline\_ctxdep.txt','w',encoding='utf-8')
# 稿子里出现的、只在 ctx 里出现（不在 raw 里）的长标识符 => 说明依赖题面
tok = re.compile(r'[A-Za-z_][A-Za-z0-9_./-]{5,}')
dep = 0; tot = 0; examples = []
for o in rows:
    d = set(tok.findall(o['draft']))
    if not d: continue
    tot += 1
    inraw = set(tok.findall(o['raw']))
    inctx = set(tok.findall(o['ctx']))
    only_ctx = d & (inctx - inraw)
    if only_ctx:
        dep += 1
        if len(examples) < 6: examples.append((o['id'][:28], sorted(only_ctx)[:4]))
OUT.write('稿子总数 %d\n' % tot)
OUT.write('稿中出现了「只在题面里、不在思考过程里」的标识符: %d/%d = %.0f%%\n' % (dep, tot, 100.0*dep/tot))
for e in examples: OUT.write('  %s -> %s\n' % e)
OUT.write('\n=== 稿子里的数字/路径有多少来自 ctx ===\n')
num = re.compile(r'\b\d+(?:\.\d+)?\b')
d2 = 0
for o in rows:
    dn = set(num.findall(o['draft'])); rn = set(num.findall(o['raw'])); cn = set(num.findall(o['ctx']))
    if dn & (cn - rn): d2 += 1
OUT.write('稿中数字只在题面出现: %d/%d = %.0f%%\n' % (d2, tot, 100.0*d2/tot))
OUT.close(); print(io.open(r'D:\cfb\.cfb-offline\_ctxdep.txt', encoding='utf-8').read())