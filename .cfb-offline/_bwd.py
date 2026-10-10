# -*- coding: utf-8 -*-
import io
OUT = io.open(r'D:\cfb\.cfb-offline\_bwd.txt','w',encoding='utf-8')
L = io.open(r'D:\cfb\.cfb-offline\_fla_layer.py', encoding='utf-8').read().split(chr(10))
OUT.write('=== fla/layers/rwkv7.py 295..355（训练分支）===\n')
for i in range(294, min(355, len(L))): OUT.write('%4d| %s\n' % (i+1, L[i][:150]))
M = io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py', encoding='utf-8').read().split(chr(10))
OUT.write('\n=== modeling_rwkv7.py 340..400（loss 计算）===\n')
for i in range(339, min(400, len(M))): OUT.write('%4d| %s\n' % (i+1, M[i][:150]))
OUT.close()
print(io.open(r'D:\cfb\.cfb-offline\_bwd.txt', encoding='utf-8').read()[:6500])