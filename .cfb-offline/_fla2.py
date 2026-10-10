# -*- coding: utf-8 -*-
import io, urllib.request, re
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    try: return urllib.request.urlopen(req, timeout=60).read().decode('utf-8','replace')
    except Exception as e: return 'FAILED %r' % e
t = get('https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/layers/rwkv7.py')
io.open(r'D:\cfb\.cfb-offline\_fla_layer.py','w',encoding='utf-8').write(t)
print('rwkv7.py lines:', t.count(chr(10)))
if not t.startswith('FAILED'):
    lines = t.split(chr(10))
    print()
    print('=== 有没有长度/位置相关的东西 ===')
    for i, l in enumerate(lines):
        if re.search(r'max_position|seq_len|position|rope|rotary|chunk_size|limit', l, re.I):
            print('%4d| %s' % (i+1, l.strip()[:150]))
print()
mc = get('https://hf-mirror.com/BlinkDL/rwkv7-g1/raw/main/README.md')
print('=== BlinkDL 模型卡里的 ctx 线索 ===')
for l in mc.split(chr(10)):
    if re.search(r'ctx|context|4096|8192|2048|length|token', l, re.I): print('  ' + l.strip()[:170])