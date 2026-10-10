# -*- coding: utf-8 -*-
# 只要回答一件事：哪种写法真的关掉了思考，且正文照样出。2 种写法 x 2 条 = 4 次调用。
import io, json, time, urllib.request, urllib.error
env = {}
for l in io.open(r'C:\Users\Liaocr\.secrets\keys.env', encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env['DEEPSEEK_API_KEY'], env['DEEPSEEK_BASE_URL'], env['DEEPSEEK_MODEL']
SYSTEM = ' '.join(x.strip() for x in io.open(r'D:\cfb\transfer\prompts\handoff-zh.txt', encoding='utf-8').read().split('\n')
                  if x.strip() and not x.startswith('#'))
OUT = io.open(r'D:\cfb\.cfb-offline\_nothink.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
def call(msgs, **kw):
    body = {'model': MODEL, 'messages': msgs, 'max_tokens': 16000, 'temperature': 0.2}
    body.update(kw)
    req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode('utf-8', 'replace')), time.time() - t0, None
    except urllib.error.HTTPError as e:
        return None, time.time() - t0, 'HTTP %s %s' % (e.code, e.read()[:160])
    except Exception as e:
        return None, time.time() - t0, repr(e)[:160]
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl', encoding='utf-8') if l.strip()][:2]
for name, kw in [('minimal', {'reasoning_effort': 'minimal'}), ('disabled', {'thinking': {'type': 'disabled'}})]:
    p('='*70)
    p('### ' + name + '  ' + json.dumps(kw))
    tr = tc = 0; okc = 0
    for o in rows:
        u_ = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw']
        j, el, err = call([{'role':'system','content':SYSTEM},{'role':'user','content':u_}], **kw)
        if err: p('   ERR ' + err[:160]); continue
        ch = j['choices'][0]; msg = ch['message']; u = j.get('usage') or {}
        rc = (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0)
        ct = (msg.get('content') or '').strip()
        tr += rc; tc += u.get('completion_tokens', 0)
        if ct: okc += 1
        p('   %5.1fs reasoning=%-6d content=%-5d finish=%s' % (el, rc, len(ct), ch.get('finish_reason')))
        if ct: p('      前 120 字: ' + ct[:120].replace(chr(10), ' / '))
    p('   -> 有正文 %d/%d  思考合计 %d  completion 合计 %d' % (okc, len(rows), tr, tc))
OUT.close(); print('ok')