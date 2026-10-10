# -*- coding: utf-8 -*-
import io, json, re
src = io.open(r'D:\cfb\.cfb-offline\rwkv7\hf_rwkv_tokenizer.py', encoding='utf-8').read()
src = src.replace('from transformers.tokenization_utils import AddedToken, PreTrainedTokenizer', 'class PreTrainedTokenizer: pass')
src = src.replace('from transformers.utils import logging', 'class _L:\n    def get_logger(self,n): return None\nlogging=_L()')
src = src[:src.find('class RwkvTokenizer')]
ns = {}; exec(compile(src, 't', 'exec'), ns)
tk = ns['RWKV_TOKENIZER'](r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
import jinja2
TPL = "{{ '<|rwkv_tokenizer_end_of_text|>' }}{% for message in messages %}{% if message['role'] == 'user' %}{{'User: ' + message['content'] + '\n\n'}}{% elif message['role'] == 'system' %}{{'System: ' + message['content'] + '\n\n'}}{% elif message['role'] == 'assistant' %}{{'Assistant: ' + message['content'] + '\n\n'}}{% endif %}{% endfor %}{% if add_generation_prompt %}{% if enable_thinking is defined and enable_thinking == False %}{{ 'Assistant: <think\n</think>' }}{% else %}{{ 'Assistant: <think' }}{% endif %}{% endif %}"
tpl = jinja2.Environment().from_string(TPL)
SPECIAL = '<|rwkv_tokenizer_end_of_text|>'
def enc(text):
    parts = text.split(SPECIAL); ids = []
    for i, part in enumerate(parts):
        if i > 0: ids.append(0)
        if part: ids.extend(tk.encode(part)[0])
    return ids
def render(m, g): return tpl.render(messages=m, add_generation_prompt=g, enable_thinking=False)
rows = [json.loads(l) for l in io.open(r'D:\cfb\deploy\kaggle\data\sft-train.jsonl', encoding='utf-8') if l.strip()]
OUT = io.open(r'D:\cfb\.cfb-offline\_realtok.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('真实 RWKV 分词器 · %d 条训练样本' % len(rows))
L, drifts, sysL, userL, asstL = [], [], [], [], []
for r in rows:
    ms = [{'role':'system','content':r['system']}, {'role':'user','content':r['user']}, {'role':'assistant','content':r['assistant']}]
    prompt = render(ms[:-1], True)
    full = prompt + r['assistant'] + '\n\n'
    pids = enc(prompt); ids = enc(full) + [0]
    k = 0
    while k < min(len(pids), len(ids)) and pids[k] == ids[k]: k += 1
    drifts.append(len(pids) - k)
    L.append(len(ids)); sysL.append(len(enc(render([ms[0]], False)))); userL.append(len(enc(render(ms[:2], False))))
    asstL.append(len(enc(r['assistant'])))
L.sort(); n = len(L)
p('')
p('=== 样本总长（真实 token，含 eos）===')
p('  min %d  p50 %d  p90 %d  max %d  均值 %d' % (L[0], L[n//2], L[int(n*.9)], L[-1], sum(L)//n))
p('  窗口 4096 占用: p50 %.1f%%  p90 %.1f%%  max %.1f%%' % (100*L[n//2]/4096, 100*L[int(n*.9)]/4096, 100*L[-1]/4096))
p('  超 4096 的: %d/%d' % (sum(1 for x in L if x>4096), n))
p('  超 2048 的: %d/%d  <-- 旧窗口会丢多少' % (sum(1 for x in L if x>2048), n))
p('')
p('=== 掩码边界偏差（LCP 口径）===')
p('  非零: %d/%d  max %d' % (sum(1 for d in drifts if d), len(drifts), max(drifts)))
p('  <=2 token 的偏差属正常 BPE 跨边界合并')
p('')
p('=== 各部件真实 token 中位 ===')
for nm, a in [('system(压缩提示词)', sysL), ('system+user', userL), ('assistant(稿子)', asstL)]:
    a2 = sorted(a); p('  %-22s p50 %5d  max %5d' % (nm, a2[len(a2)//2], a2[-1]))
OUT.close(); print(io.open(r'D:\cfb\.cfb-offline\_realtok.txt', encoding='utf-8').read())