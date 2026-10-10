# -*- coding: utf-8 -*-
import io, json, os, re, numpy as np
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def sc(s):
    w = len(RE_WIDE.findall(s)); return w, len(s) - w
T = os.path.join('D:\\', 'cfb', '.cfb-offline', 'teacher')
PROMPTS = {'v1-off.jsonl':'compress-zh.txt','v2-off.jsonl':'handoff-zh.txt','v3-off.jsonl':'teacher-zh.txt','v4-30.jsonl':'teacher2-zh.txt'}
PD = os.path.join('D:\\','cfb','transfer','prompts')
O = []
for fn, pf in PROMPTS.items():
    fp = os.path.join(T, fn); pp = os.path.join(PD, pf)
    if not os.path.exists(fp): continue
    SYS = '\n'.join(x for x in io.open(pp, encoding='utf-8').read().split('\n') if not x.lstrip().startswith('#'))
    for l in io.open(fp, encoding='utf-8'):
        if not l.strip(): continue
        try: o = json.loads(l)
        except Exception: continue
        if not (o.get('draft') or '').strip(): continue
        u = o.get('usage') or {}
        if not u.get('prompt') or not u.get('completion'): continue
        full = SYS + '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw']
        w, ot = sc(full)
        w2, o2 = sc(o['draft'])
        O.append({'w':w,'o':ot,'pt':u['prompt'],'w2':w2,'o2':o2,'ct':u['completion']})
print('n =', len(O))
W = np.array([r['w'] for r in O], float); Ot = np.array([r['o'] for r in O], float)
print('')
print('=== 共线性检查（输入侧）===')
print('中文宽字符 范围: %d ~ %d (std %.0f)' % (W.min(), W.max(), W.std()))
print('其余字符   范围: %d ~ %d (std %.0f)' % (Ot.min(), Ot.max(), Ot.std()))
print('相关系数 corr(w,o) = %.4f  (|r|>0.95 才叫不可分)' % np.corrcoef(W, Ot)[0,1])
print('中文占比        : %.3f ~ %.3f' % ((W/(W+Ot)).min(), (W/(W+Ot)).max()))
print('')
print('=== 输出侧 ===')
W2 = np.array([r['w2'] for r in O], float); O2 = np.array([r['o2'] for r in O], float)
print('中文宽字符 范围: %d ~ %d (std %.0f)' % (W2.min(), W2.max(), W2.std()))
print('其余字符   范围: %d ~ %d (std %.0f)' % (O2.min(), O2.max(), O2.std()))
print('相关系数 corr(w,o) = %.4f' % np.corrcoef(W2, O2)[0,1])
print('中文占比        : %.3f ~ %.3f' % ((W2/(W2+O2)).min(), (W2/(W2+O2)).max()))
print('')
print('=== 留出验证：8:2 切分，训练集拟合 → 测试集误差 ===')
rng = np.random.default_rng(7); idx = rng.permutation(len(O)); k = int(len(O)*0.8)
for tag, Wc, Oc, yc in [('输入', W, Ot, np.array([r['pt'] for r in O],float)),
                        ('输出', W2, O2, np.array([r['ct'] for r in O],float))]:
    tr, te = idx[:k], idx[k:]
    A = np.stack([Wc, Oc, np.ones_like(Wc)], 1)
    c, *_ = np.linalg.lstsq(A[tr], yc[tr], rcond=None)
    pe = np.abs(A[te] @ c - yc[te]).mean() / yc[te].mean()
    p6 = np.abs(A[te][:,0]*0.6 + A[te][:,1]*0.3 - yc[te]).mean() / yc[te].mean()
    print('%s: 拟合系数 中%.3f 其%.3f 截距%.1f | 留出误差 %.2f%% | 现行0.6/0.3 留出误差 %.2f%%' % (tag, c[0], c[1], c[2], 100*pe, 100*p6))