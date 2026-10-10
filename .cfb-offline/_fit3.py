# -*- coding: utf-8 -*-
import io, json, re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return int(w*0.81 + (len(s)-w)*0.26)
full = io.open(r'D:\cfb\transfer\prompts\teacher2-zh.txt', encoding='utf-8').read()
full = '\n'.join(x for x in full.split('\n') if not x.lstrip().startswith('#'))
i = full.find('【样例】'); j = full.find('【原文】')
print('提示词 字符 %d / token %d' % (len(full), est(full)))
print('  【样例】段: 位置 %d .. %d, 字符 %d, token %d' % (i, j, j-i, est(full[i:j])))
nosample = full[:i] + full[j:]
print('  去掉样例后 token: %d' % est(nosample))
print()
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
CAP = 2048
def dist(name, L):
    L = sorted(L); n = len(L)
    print('%-34s 中位 %5d  p90 %5d  max %5d  超窗 %3d/%d = %3.0f%%' % (name, L[n//2], L[int(n*0.9)], L[-1], sum(1 for x in L if x>CAP), n, 100.0*sum(1 for x in L if x>CAP)/n))
print('=== 与底座窗口 %d 对比（system+user+assistant 全量）===' % CAP)
dist('A 现状（ctx + 样例）', [est(full)+est(o['ctx'])+est(o['raw'])+est(o['draft']) for o in rows])
dist('B 去 ctx', [est(full)+est(o['raw'])+est(o['draft']) for o in rows])
dist('C 去样例', [est(nosample)+est(o['ctx'])+est(o['raw'])+est(o['draft']) for o in rows])
dist('D 去 ctx + 去样例', [est(nosample)+est(o['raw'])+est(o['draft']) for o in rows])
print()
print('=== 各部件 token 中位 ===')
for nm, f in [('system 全量', lambda o: est(full)), ('system 去样例', lambda o: est(nosample)), ('ctx', lambda o: est(o['ctx'])), ('raw', lambda o: est(o['raw'])), ('draft', lambda o: est(o['draft']))]:
    L = sorted(f(o) for o in rows); print('  %-14s 中位 %5d  max %5d' % (nm, L[len(L)//2], L[-1]))