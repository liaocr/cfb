# -*- coding: utf-8 -*-
# 给用户读的对照：同一单元，v1 稿 vs v2 稿并排。
import io, json, os
def load(p):
    d = {}
    for l in io.open(p, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l); d[o['id']] = o
            except Exception: pass
    return d
V1 = load(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl')
V2 = load(r'D:\cfb\.cfb-offline\teacher\drafts-v2.jsonl')
ids = [k for k in V2.keys() if k in V1]
# 挑覆盖不同长度的 10 条
ids.sort(key=lambda i: len(V2[i]['raw']))
pick = [ids[0], ids[len(ids)//10], ids[2*len(ids)//10], ids[3*len(ids)//10], ids[4*len(ids)//10],
        ids[5*len(ids)//10], ids[6*len(ids)//10], ids[7*len(ids)//10], ids[8*len(ids)//10], ids[-1]]
OUT = io.open(r'D:\cfb\.cfb-offline\_sidebyside.txt','w',encoding='utf-8')
for k, i in enumerate(pick, 1):
    a, b = V1[i], V2[i]
    OUT.write('='*80 + '\n')
    OUT.write('[%d/10] %s   raw=%d 字  ctx=%d 字\n' % (k, i, len(a['raw']), len(a['ctx'])))
    OUT.write('-'*80 + '\n')
    OUT.write('【v1 压缩稿】%d 字  字符比 %.3f\n%s\n' % (len(a['draft']), len(a['draft'])/len(a['raw']), a['draft']))
    OUT.write('-'*80 + '\n')
    OUT.write('【v2 交接稿】%d 字  字符比 %.3f\n%s\n' % (len(b['draft']), len(b['draft'])/len(b['raw']), b['draft']))
    OUT.write('\n')
OUT.close(); print('ok')