# -*- coding: utf-8 -*-
import io, json, re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return int(w*0.81 + (len(s)-w)*0.26)
full = io.open(r'D:\cfb\transfer\prompts\teacher2-zh.txt', encoding='utf-8').read()
full = '\n'.join(x for x in full.split('\n') if not x.lstrip().startswith('#'))
i = full.find('\u3010\u6837\u4f8b\u3011'); j = full.rfind('\u3010\u539f\u6587\u3011')
nosample = full[:i] + full[j:]
units = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl', encoding='utf-8') if l.strip()]
n = len(units)
DRAFT = 500   # 稿子预算（v4 实测 p90 约 500）
OUT = io.open(r'D:\cfb\.cfb-offline\_expand.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('候选单元 %d' % n)
p('system: 带样例 %d tok / 不带样例 %d tok' % (est(full), est(nosample)))
p('')
for cap in [2048, 4096, 8192]:
    p('=== 窗口 %d ===' % cap)
    for nm, sysp in [('带样例', full), ('不带样例', nosample)]:
        b = cap - est(sysp) - DRAFT
        ok = sum(1 for u in units if est(u['raw']) <= b)
        p('  raw->draft, %s: raw 上限 %4d tok, 可训 %4d/%d = %5.1f%%' % (nm, b, ok, n, 100.0*ok/n))
    b2 = cap - est(full) - DRAFT
    ok2 = sum(1 for u in units if est(u['ctx']) + est(u['raw']) <= b2)
    p('  raw+ctx->draft, 带样例: raw+ctx 上限 %4d, 可训 %4d/%d = %5.1f%%' % (b2, ok2, n, 100.0*ok2/n))
    p('')
R = sorted(est(u['raw']) for u in units)
p('raw token 分布: p50 %d p75 %d p90 %d p95 %d p99 %d max %d' % (R[n//2], R[3*n//4], R[int(n*.9)], R[int(n*.95)], R[int(n*.99)], R[-1]))
OUT.close(); print(open(r'D:\cfb\.cfb-offline\_expand.txt', encoding='utf-8').read())