import io, json, os
cfg = json.loads(io.open(r'D:\cfb\.cfb-offline\rwkv7\config.json', encoding='utf-8').read())
print('=== RWKV7-0.1B 的上下文窗口 ===')
for k in ['max_position_embeddings','n_positions','hidden_size','num_hidden_layers','vocab_size','context_length']:
    if k in cfg: print('  %-26s %s' % (k, cfg[k]))
print()
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\teacher\v4-100.jsonl', encoding='utf-8') if l.strip()]
rows = [o for o in rows if (o.get('draft') or '').strip()]
import re
RE_WIDE = re.compile('[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]')
def est(s):
    w = len(RE_WIDE.findall(s)); return int(w*0.81 + (len(s)-w)*0.26)
sysp = io.open(r'D:\cfb\transfer\prompts\teacher2-zh.txt', encoding='utf-8').read()
sysp = '\n'.join(x for x in sysp.split('\n') if not x.lstrip().startswith('#'))
L = []
for o in rows:
    u = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw']
    L.append(est(sysp) + est(u) + est(o['draft']))
L.sort(); n = len(L)
print('=== 一条训练样本的 token 数（system+user+assistant）===')
print('  min %d  p25 %d  中位 %d  p75 %d  p90 %d  max %d' % (L[0], L[n//4], L[n//2], L[3*n//4], L[int(n*0.9)], L[-1]))
print('  均值 %d' % (sum(L)/n))
print()
cap = cfg.get('max_position_embeddings') or cfg.get('context_length') or 2048
print('=== 与底座窗口 %d 对比 ===' % cap)
print('  超窗的样本: %d/%d = %.0f%%' % (sum(1 for x in L if x > cap), n, 100.0*sum(1 for x in L if x>cap)/n))
print('  中位数是窗口的 %.2fx' % (L[n//2]/cap))