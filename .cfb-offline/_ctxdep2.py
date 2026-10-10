# -*- coding: utf-8 -*-
import io, json, re
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
OUT = io.open(r'D:\cfb\.cfb-offline\_ctxdep2.txt','w',encoding='utf-8')
# 严格：代码味标识符（含 . / _ 或 CamelCase），长度 >= 8，且不含常见英文词
strict = re.compile(r'\b(?:[A-Za-z_][A-Za-z0-9_]*[./][A-Za-z0-9_./-]{3,}|[a-z]+[A-Z][A-Za-z0-9]{4,})\b')
STOP = set('import default branch commit return string format output'.split())
dep = 0; tot = 0; ex = []
for o in rows:
    d = set(x for x in strict.findall(o['draft']) if x.lower() not in STOP)
    if not d: continue
    tot += 1
    inraw = set(strict.findall(o['raw'])); inctx = set(strict.findall(o['ctx']))
    only = d & (inctx - inraw)
    if only:
        dep += 1
        if len(ex) < 8: ex.append((o['id'][:30], sorted(only)[:4]))
OUT.write('=== 严格口径（代码味标识符 >=8 字符）===\n')
OUT.write('稿子含代码味标识符的: %d\n' % tot)
OUT.write('其中含「只在题面、不在思考过程」的: %d/%d = %.0f%%\n' % (dep, tot, 100.0*dep/tot))
for e in ex: OUT.write('  %s -> %s\n' % e)
OUT.write('\n=== 反向：稿子里的代码味标识符有多少能在 raw 里找到 ===\n')
hit = 0; allid = 0
for o in rows:
    d = set(x for x in strict.findall(o['draft']) if x.lower() not in STOP)
    if not d: continue
    inraw = set(strict.findall(o['raw']))
    hit += len(d & inraw); allid += len(d)
OUT.write('稿中标识符总 %d，能在 raw 找到 %d = %.0f%%\n' % (allid, hit, 100.0*hit/allid))
OUT.close(); print(io.open(r'D:\cfb\.cfb-offline\_ctxdep2.txt', encoding='utf-8').read())