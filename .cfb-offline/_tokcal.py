# -*- coding: utf-8 -*-
# 用我自己的真实 API usage 校准 token 系数。
# 回归式：tokens = a*wide + b*other + c   （wide=CJK/全角字符，other=其余）
import io, json, os, re, numpy as np
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def sc(s):
    w = len(RE_WIDE.findall(s)); return w, len(s) - w
T = os.path.join('D:\\', 'cfb', '.cfb-offline', 'teacher')
PROMPTS = {
  'v1-off.jsonl': os.path.join('D:\\','cfb','transfer','prompts','compress-zh.txt'),
  'v2-off.jsonl': os.path.join('D:\\','cfb','transfer','prompts','handoff-zh.txt'),
  'v3-off.jsonl': os.path.join('D:\\','cfb','transfer','prompts','teacher-zh.txt'),
  'v4-30.jsonl':  os.path.join('D:\\','cfb','transfer','prompts','teacher2-zh.txt'),
}
P, O = [], []   # (wide, other, tokens)
for fn, pf in PROMPTS.items():
    fp = os.path.join(T, fn)
    if not os.path.exists(fp) or not os.path.exists(pf): continue
    SYS = '\n'.join(x for x in io.open(pf, encoding='utf-8').read().split('\n') if not x.lstrip().startswith('#'))
    n = 0
    for l in io.open(fp, encoding='utf-8'):
        if not l.strip(): continue
        try: o = json.loads(l)
        except Exception: continue
        if not (o.get('draft') or '').strip(): continue
        u = o.get('usage') or {}
        pt, ct = u.get('prompt'), u.get('completion')
        if not pt or not ct: continue
        user = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw']
        full = SYS + user
        w, ot = sc(full); P.append((w, ot, pt))
        w2, o2 = sc(o['draft']); O.append((w2, o2, ct))
        n += 1
    print('%-16s %d 条' % (fn, n))
def fit(rows, tag):
    A = np.array([[r[0], r[1], 1.0] for r in rows], dtype=float)
    y = np.array([r[2] for r in rows], dtype=float)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    pred = A @ coef
    resid = y - pred
    ss = 1 - (resid**2).sum() / ((y - y.mean())**2).sum()
    print('')
    print('=== %s  n=%d ===' % (tag, len(rows)))
    print('  中文/全角字符 : %.4f token/字' % coef[0])
    print('  其余字符      : %.4f token/字' % coef[1])
    print('  截距          : %.2f token（chat 模板开销）' % coef[2])
    print('  R^2           : %.4f' % ss)
    print('  平均绝对误差  : %.1f token（%.2f%%）' % (np.abs(resid).mean(), 100*np.abs(resid).mean()/y.mean()))
    print('  现行常数对照  : 中文 0.6 / 其余 0.3')
    print('  按现行常数的误差: %.2f%%' % (100*np.abs(y - (A[:,0]*0.6 + A[:,1]*0.3)).mean()/y.mean()))
    return coef
fit(P, 'prompt（输入）')
fit(O, 'completion（输出=稿子）')