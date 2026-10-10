# -*- coding: utf-8 -*-
import io, json, os, re, numpy as np
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def sc(s):
    w = len(RE_WIDE.findall(s)); return w, len(s) - w
T = os.path.join('D:\\', 'cfb', '.cfb-offline', 'teacher'); PD = os.path.join('D:\\','cfb','transfer','prompts')
PROMPTS = {'v1-off.jsonl':'compress-zh.txt','v2-off.jsonl':'handoff-zh.txt','v3-off.jsonl':'teacher-zh.txt','v4-30.jsonl':'teacher2-zh.txt'}
A, y = [], []
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
        w, ot = sc(full); A.append([w, ot]); y.append(u['prompt'])
        w2, o2 = sc(o['draft']); A.append([w2, o2]); y.append(u['completion'])
A = np.array(A, float); y = np.array(y, float)
# 不带截距的联合拟合：estimateTokens 的接口没有截距项
c, *_ = np.linalg.lstsq(A, y, rcond=None)
pred = A @ c
print('联合拟合 n=%d（输入+输出各 330）' % len(y))
print('  中文/全角 : %.4f token/字' % c[0])
print('  其余      : %.4f token/字' % c[1])
print('  平均绝对误差: %.2f%%' % (100*np.abs(pred-y).mean()/y.mean()))
p6 = A[:,0]*0.6 + A[:,1]*0.3
print('  现行 0.6/0.3 平均绝对误差: %.2f%%' % (100*np.abs(p6-y).mean()/y.mean()))
print('')
print('=== 比例 ===')
print('  现行常数暗示 中文/英文 = %.2fx' % (0.6/0.3))
print('  实测       中文/英文 = %.2fx' % (c[0]/c[1]))