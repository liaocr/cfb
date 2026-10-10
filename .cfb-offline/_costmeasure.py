# -*- coding: utf-8 -*-
# 重新量：把 prompt_tokens / completion_tokens（含 reasoning）精确拆出来，5 条真实单元。
import io, json, time, urllib.request, urllib.error
ENVF = r'C:\Users\Liaocr\.secrets\keys.env'
env = {}
for l in io.open(ENVF, encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env['DEEPSEEK_API_KEY'], env['DEEPSEEK_BASE_URL'], env['DEEPSEEK_MODEL']
OUT = io.open(r'D:\cfb\.cfb-offline\_costmeasure.txt', 'w', encoding='utf-8')
def p(*a): OUT.write(' '.join(str(x) for x in a) + '\n')
SYSTEM = '你是思维链压缩器。把英文字段压成中文压缩稿，保留承重事实与落点，引用必须逐字，不得编造。直接输出压缩稿。'
def call(msgs, max_tokens=8000):
    body = {'model': MODEL, 'messages': msgs, 'max_tokens': max_tokens, 'temperature': 0.2}
    req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\_stage1_drafts.jsonl', encoding='utf-8') if l.strip()][:5]
p('%-42s %8s %8s %8s %8s %8s %10s' % ('unitId', 'prompt', 'compl', 'reason', 'content', 'total', 'relay_cost'))
tot = {'prompt':0,'compl':0,'reason':0,'relay':0.0}
for o in rows:
    u_ = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw'] + '\n\n请输出中文压缩稿。'
    j = call([{'role':'system','content':SYSTEM},{'role':'user','content':u_}])
    u = j.get('usage') or {}
    msg = j['choices'][0]['message']
    reason = (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0)
    prompt = u.get('prompt_tokens', 0); compl = u.get('completion_tokens', 0)
    ct = len(msg.get('content') or ''); rc = len(msg.get('reasoning_content') or '')
    relay = u.get('cost', 0) or 0
    tot['prompt'] += prompt; tot['compl'] += compl; tot['reason'] += reason; tot['relay'] += relay
    p('%-42s %8d %8d %8d %8d %8d %10.6f' % (o['id'][:42], prompt, compl, reason, ct, u.get('total_tokens',0), relay))
    p('     本地实测：raw %d 字 / draft %d 字；我的 3.5字符每token 估算给 prompt≈%d' % (len(o['raw']), ct, int((len(o['ctx'])+len(o['raw']))/3.5)))
p('')
p('合计 prompt=%d completion=%d 其中 reasoning=%d relay_cost=$%.6f' % (tot['prompt'], tot['compl'], tot['reason'], tot['relay']))
n = len(rows)
for name, (pin, pout) in {'DeepSeek 缓存未命中 $0.28/$0.42': (0.28, 0.42), 'DeepSeek 缓存命中 $0.028/$0.42': (0.028, 0.42), 'DeepSeek 新版 $0.56/$1.68': (0.56, 1.68)}.items():
    per = (tot['prompt']*pin + tot['compl']*pout)/1e6/n
    p('  %-32s 单条 $%.6f  3000 条 $%.2f  1000 条 $%.2f' % (name, per, per*3000, per*1000))
p('  %-32s 单条 $%.6f  3000 条 $%.2f' % ('relay 自报', tot['relay']/n, tot['relay']/n*3000))
OUT.close(); print('ok')