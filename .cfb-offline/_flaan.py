# -*- coding: utf-8 -*-
import io, re
t = io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py', encoding='utf-8').read()
lines = t.split(chr(10))
print('=== max_position_embeddings 出现的每一处（带上下文）===')
for i, l in enumerate(lines):
    if 'max_position_embeddings' in l:
        print('%4d| %s' % (i+1, l.strip()[:160]))
print()
print('=== 类定义 ===')
for i, l in enumerate(lines):
    if re.match(r'^class ', l): print('%4d| %s' % (i+1, l.strip()))
print()
print('=== RWKV7Attention.__init__ 签名 ===')
for i, l in enumerate(lines):
    if 'class RWKV7Attention' in l:
        for j in range(i, min(i+30, len(lines))):
            print('%4d| %s' % (j+1, lines[j][:150]))
        break