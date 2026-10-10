
import io, json, os, sys, urllib.request
env = {}
for l in io.open(r'C:\Users\Liaocr\.secrets\keys.env', encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
print('keys:', sorted(env.keys()))
KEY, BASE, MODEL = env.get('DEEPSEEK_API_KEY'), env.get('DEEPSEEK_BASE_URL'), env.get('DEEPSEEK_MODEL')
print('key len', len(KEY or ''), 'base', BASE, 'model', MODEL)
body = {'model': MODEL, 'messages': [{'role':'user','content':'reply with the single word OK'}],
        'max_tokens': 16, 'thinking': {'type': 'disabled'}}
req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
with urllib.request.urlopen(req, timeout=60) as r:
    j = json.loads(r.read().decode('utf-8','replace'))
print('probe ok:', repr(j['choices'][0]['message'].get('content'))[:80], '| finish', j['choices'][0].get('finish_reason'))
print('usage', j.get('usage'))
