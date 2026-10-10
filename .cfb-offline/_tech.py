# -*- coding: utf-8 -*-
import io, urllib.request, json, re
OUT = io.open(r'D:\cfb\.cfb-offline\_tech.txt','w',encoding='utf-8')
def get(u):
    try:
        return urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent':'M'}), timeout=60).read().decode('utf-8','replace')
    except Exception as e: return 'FAILED %r' % e
tc = get('https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/raw/main/tokenizer_config.json')
if not tc.startswith('FAILED'):
    d = json.loads(tc)
    OUT.write('=== chat_template ===\n')
    OUT.write(str(d.get('chat_template')) + '\n\n')
    OUT.write('tokenizer_class: %s\n' % d.get('tokenizer_class'))
    OUT.write('model_max_length: %s\n' % d.get('model_max_length'))
    OUT.write('keys: %s\n' % sorted(d.keys()))
else: OUT.write(tc)
OUT.write('\n=== fla 是否注册 rwkv7 到 AutoConfig/AutoModel ===\n')
m = get('https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/models/__init__.py')
if not m.startswith('FAILED'):
    for l in m.split(chr(10)):
        if 'rwkv7' in l.lower(): OUT.write('  ' + l.strip()[:150] + '\n')
OUT.close()
print(io.open(r'D:\cfb\.cfb-offline\_tech.txt', encoding='utf-8').read()[:4000])