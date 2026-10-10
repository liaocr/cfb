# -*- coding: utf-8 -*-
import io, urllib.request, re, json
OUT = io.open(r'D:\cfb\.cfb-offline\_cfgchk.txt','w',encoding='utf-8')
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    try: return urllib.request.urlopen(req, timeout=60).read().decode('utf-8','replace')
    except Exception as e: return 'FAILED %r' % e
# 1) fla 的 RWKV7Config 默认值与文档
t = get('https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/models/rwkv7/configuration_rwkv7.py')
OUT.write('===== configuration_rwkv7.py =====\n')
if not t.startswith('FAILED'):
    for i, l in enumerate(t.split(chr(10))):
        if re.search(r'max_position|docstring|context|2048|4096|8192', l, re.I):
            OUT.write('%4d| %s\n' % (i+1, l.strip()[:150]))
else: OUT.write(t + '\n')
# 2) tokenizer_config 的 model_max_length
tj = get('https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/raw/main/tokenizer_config.json')
OUT.write('\n===== tokenizer_config.json =====\n')
if not tj.startswith('FAILED'):
    try:
        d = json.loads(tj)
        for k in ['model_max_length','chat_template']:
            v = d.get(k)
            OUT.write('  %s = %s\n' % (k, (str(v)[:300] if k=='chat_template' else v)))
    except Exception as e: OUT.write('parse fail %r\n' % e)
else: OUT.write(tj + '\n')
OUT.close()
print(io.open(r'D:\cfb\.cfb-offline\_cfgchk.txt', encoding='utf-8').read())