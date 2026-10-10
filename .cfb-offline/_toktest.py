# -*- coding: utf-8 -*-
import io, json, os, re, sys
src = io.open(r'D:\cfb\.cfb-offline\rwkv7\hf_rwkv_tokenizer.py', encoding='utf-8').read()
# 剥掉 transformers 依赖：只保留 TRIE + RWKV_TOKENIZER
src = src.replace('from transformers.tokenization_utils import AddedToken, PreTrainedTokenizer', 'class PreTrainedTokenizer: pass')
src = src.replace('from transformers.utils import logging', 'class _L:\n    def get_logger(self,n): return None\nlogging=_L()')
i = src.find('class RwkvTokenizer')
src = src[:i]
ns = {}
exec(compile(src, 'rwkvtok', 'exec'), ns)
TK = ns['RWKV_TOKENIZER']
tk = TK(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
print('tokenizer ok, vocab =', len(tk.idx2token))
print('token 0 =', repr(tk.idx2token.get(0)))
# 用 jinja2 渲染底座原生 chat_template（从 tokenizer_config.json 取的原文）
import jinja2
TPL = "{{ '<|rwkv_tokenizer_end_of_text|>' }}{% for message in messages %}{% if message['role'] == 'user' %}{{'User: ' + message['content'] + '\n\n'}}{% elif message['role'] == 'system' %}{{'System: ' + message['content'] + '\n\n'}}{% elif message['role'] == 'assistant' %}{{'Assistant: ' + message['content'] + '\n\n'}}{% endif %}{% endfor %}{% if add_generation_prompt %}{% if enable_thinking is defined and enable_thinking == False %}{{ 'Assistant: <think\n</think>' }}{% else %}{{ 'Assistant: <think' }}{% endif %}{% endif %}"
env = jinja2.Environment()
tpl = env.from_string(TPL)
msgs = [{'role':'system','content':'你是压缩器。'}, {'role':'user','content':'[原文]\nabc def'}]
p = tpl.render(messages=msgs, add_generation_prompt=True, enable_thinking=False)
print()
print('=== add_gen=True, enable_thinking=False 的渲染尾部 ===')
print(repr(p[-60:]))
p2 = tpl.render(messages=msgs, add_generation_prompt=True)
print('=== 不传 enable_thinking 的渲染尾部（应当未闭合）===')
print(repr(p2[-40:]))
full = tpl.render(messages=msgs+[{'role':'assistant','content':'ABC'}], add_generation_prompt=False)
print('=== 整段渲染尾部 ===')
print(repr(full[-40:]))
print()
print('=== 关键：prompt 是不是 full 的前缀？ ===')
print('startswith:', full.startswith(p))
print('所以训练序列必须手工拼 prompt + draft，不能直接用整段渲染。')