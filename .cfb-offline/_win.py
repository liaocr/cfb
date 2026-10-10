# -*- coding: utf-8 -*-
import io, json, time
src = io.open(r'D:\cfb\.cfb-offline\rwkv7\hf_rwkv_tokenizer.py', encoding='utf-8').read()
src = src.replace('from transformers.tokenization_utils import AddedToken, PreTrainedTokenizer', 'class PreTrainedTokenizer: pass')
src = src.replace('from transformers.utils import logging', 'class _L:\n    def get_logger(self,n): return None\nlogging=_L()')
src = src[:src.find('class RwkvTokenizer')]
ns = {}; exec(compile(src, 't', 'exec'), ns)
tk = ns['RWKV_TOKENIZER'](r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
units = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl', encoding='utf-8') if l.strip()]
print('候选 %d' % len(units))
SYS = 1188   # 已实测（真实 token）
DRAFT = 368  # 教师稿真实中位
STEP = 10
sample = units[::STEP]
t0 = time.time()
U = []
for u in sample:
    user = '[\u9898\u9762]\n' + u['ctx'] + '\n\n[\u601d\u8003\u8fc7\u7a0b]\n' + u['raw']
    U.append(len(tk.encode(user)[0]))
print('编码 %d 条，%.1fs' % (len(U), time.time()-t0))
U.sort(); n = len(U)
OUT = io.open(r'D:\cfb\.cfb-offline\_win.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('抽样 %d / %d 个单元（每 %d 取一）' % (len(U), len(units), STEP))
p('user（题面+思考过程）真实 token: p50 %d  p75 %d  p90 %d  p95 %d  max %d' % (U[n//2], U[3*n//4], U[int(n*.9)], U[int(n*.95)], U[-1]))
p('固定开销: system %d + draft %d = %d token' % (SYS, DRAFT, SYS+DRAFT))
p('')
p('=== 各窗口能装多少（总长 = %d + user）===' % (SYS+DRAFT))
for cap in [2048, 3072, 4096, 5120, 6144, 8192]:
    b = cap - SYS - DRAFT
    ok = sum(1 for x in U if x <= b)
    p('  窗口 %5d: user 上限 %5d, 可训 %3d/%d = %5.1f%%' % (cap, b, ok, n, 100.0*ok/n))
OUT.close(); print(io.open(r'D:\cfb\.cfb-offline\_win.txt', encoding='utf-8').read())