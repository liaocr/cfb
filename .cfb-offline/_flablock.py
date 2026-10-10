# -*- coding: utf-8 -*-
import io
lines = io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py', encoding='utf-8').read().split(chr(10))
print('=== 1..42 行（imports）===')
for i in range(0, 42):
    s = lines[i].strip()
    if s and not s.startswith('#'): print('%4d| %s' % (i+1, lines[i][:140]))
print()
print('=== 119..170（RWKV7Block）===')
for i in range(118, min(170, len(lines))):
    print('%4d| %s' % (i+1, lines[i][:140]))