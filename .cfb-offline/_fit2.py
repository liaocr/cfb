import io, json, re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return int(w*0.81 + (len(s)-w)*0.26)
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
full = io.open(r'D:\cfb\transfer\prompts\teacher2-zh.txt', encoding='utf-8').read()
full = '\n'.join(x for x in full.split('\n') if not x.lstrip().startswith('#'))
# 拆出样例段（从【样例】到【原文】），看它占多少
i = full.find('【样例】'); j = full.find('【原文】')
print('提示词全文 token: %d' % est(full))
print('  其中【样例】段 token: %d（占 %.0f%%）' % (est(full[i:j]), 100.0*est(full[i:j])/est(full)))
print('  去掉样例后 token: %d' % est(full[:i] + full[j:]))
print()
def dist(L, cap=2048):
    L = sorted(L); n = len(L)
    return '中位 %d  p90 %d  max %d  超窗 %d/%d' % (L[n//2], L[int(n*0.9)], L[-1], sum(1 for x in L if x>cap), n)
A, B, C = [], [], []
for o in rows:
    A.append(est(full) + est(o['ctx']) + est(o['raw']) + est(o['draft']))
    B.append(est(full) + est(o['raw']) + est(o['draft']))
    C.append(est(full[:i]+full[j:]) + est(o['ctx']) + est(o['raw']) + est(o['draft']))
print('方案 A 现状（带 ctx + 带样例）: %s' % dist(A))
print('方案 B 去掉 ctx           : %s' % dist(B))
print('方案 C 去掉样例、保留 ctx  : %s' % dist(C))