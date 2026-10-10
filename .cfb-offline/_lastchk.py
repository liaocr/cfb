# -*- coding: utf-8 -*-
import io, re
OUT = io.open(r'D:\cfb\.cfb-offline\_lastchk.txt','w',encoding='utf-8')
L = io.open(r'D:\cfb\.cfb-offline\_fla_layer.py', encoding='utf-8').read().split(chr(10))
OUT.write('=== fla/layers/rwkv7.py 160..200（position-based init 是什么）===\n')
for i in range(159, min(200, len(L))): OUT.write('%4d| %s\n' % (i+1, L[i][:145]))
OUT.write('\n=== 该文件里所有 forward 签名 ===\n')
for i, l in enumerate(L):
    if 'def forward' in l: OUT.write('%4d| %s\n' % (i+1, l.strip()[:145]))
OUT.write('\n=== RWKV7Model.forward 里有没有 seq_len 上限检查 ===\n')
M = io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py', encoding='utf-8').read().split(chr(10))
for i, l in enumerate(M):
    if re.search(r'raise|assert|warn|max_position|too long|exceed', l): OUT.write('%4d| %s\n' % (i+1, l.strip()[:145]))
OUT.close()
print(io.open(r'D:\cfb\.cfb-offline\_lastchk.txt', encoding='utf-8').read()[:5000])