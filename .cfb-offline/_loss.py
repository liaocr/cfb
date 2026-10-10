# -*- coding: utf-8 -*-
import io
OUT = io.open(r'D:\cfb\.cfb-offline\_loss.txt','w',encoding='utf-8')
M = io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py', encoding='utf-8').read().split(chr(10))
OUT.write('=== RWKV7ForCausalLM.forward (437..545) ===\n')
for i in range(436, min(545, len(M))): OUT.write('%4d| %s\n' % (i+1, M[i][:150]))
OUT.close()
print(io.open(r'D:\cfb\.cfb-offline\_loss.txt', encoding='utf-8').read()[:6000])