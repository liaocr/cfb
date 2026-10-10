# -*- coding: utf-8 -*-
import io, urllib.request, json, os
OUT = io.open(r'D:\cfb\.cfb-offline\_rwkvfetch.txt','w',encoding='utf-8')
def get(url, tag):
    try:
        req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode('utf-8','replace')
        OUT.write('\n\n===== %s (%d bytes) =====\n' % (tag, len(t)))
        OUT.write(t[:6000])
        return t
    except Exception as e:
        OUT.write('\n\n===== %s FAILED: %r =====\n' % (tag, e))
        return ''
# 1) 模型卡
get('https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/raw/main/README.md', 'model-card')
# 2) fla 的 RWKV7 实现
get('https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/models/rwkv7/modeling_rwkv7.py', 'fla-rwkv7')
OUT.close()
t = io.open(r'D:\cfb\.cfb-offline\_rwkvfetch.txt', encoding='utf-8').read()
print('total', len(t))
import re
for m in re.finditer(r'max_position_embeddings|max_seq_len|position_embed|rotary|RoPE|rope', t):
    s = max(0, m.start()-160); print('...' + t[s:m.end()+160].replace(chr(10),' ') + '...'); print('---')