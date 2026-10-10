# -*- coding: utf-8 -*-
import io, urllib.request, re
url = 'https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/models/rwkv7/modeling_rwkv7.py'
req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
t = urllib.request.urlopen(req, timeout=60).read().decode('utf-8','replace')
io.open(r'D:\cfb\.cfb-offline\_fla_rwkv7.py','w',encoding='utf-8').write(t)
print('lines', t.count(chr(10)))
lines = t.split(chr(10))
# 找 attn_spec 的定义与用法
for i, l in enumerate(lines):
    if 'attn_spec' in l or 'config.attn' in l or 'attn_pattern' in l:
        print('%4d| %s' % (i+1, l[:150]))