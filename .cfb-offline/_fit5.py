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
print('candidate units: %d' % n)
R = sorted(est(u['raw']) for u in units)
print('raw token: p50 %d  p75 %d  p90 %d  p95 %d  max %d' % (R[n//2], R[3*n//4], R[int(n*.9)], R[int(n*.95)], R[-1]))
print('')
CAP = 2048
print('general compressor: raw -> draft only (no ctx)')
for nm, sysp in [('with-sample', full), ('no-sample', nosample)]:
    for draft_tok in [332, 500]:
        budget = CAP - est(sysp) - draft_tok
        ok = sum(1 for u in units if est(u['raw']) <= budget)
        print('  %-12s sys=%4d draft=%3d => raw max %4d tok, trainable %4d/%d = %.0f%%' % (nm, est(sysp), draft_tok, budget, ok, n, 100.0*ok/n))
print('')
C = [est(full)+est(u['ctx'])+est(u['raw'])+332 for u in units]
print('with ctx (current): p50 %d, fits %d/%d = %.1f%%' % (sorted(C)[n//2], sum(1 for x in C if x<=CAP), n, 100.0*sum(1 for x in C if x<=CAP)/n))