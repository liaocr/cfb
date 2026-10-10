# -*- coding: utf-8 -*-
# 同一个 key 的问题：thinking 占输出 69%，是成本主因。测非思考模式能否同样过尺。
import io, json, time, datetime, urllib.request, urllib.error
ENVF = r'C:\Users\Liaocr\.secrets\keys.env'
env = {}
for l in io.open(ENVF, encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env['DEEPSEEK_API_KEY'], env['DEEPSEEK_BASE_URL'], env['DEEPSEEK_MODEL']
OUT = io.open(r'D:\cfb\.cfb-offline\_cost2.txt', 'w', encoding='utf-8')
def p(*a): OUT.write(' '.join(str(x) for x in a) + '\n')
now = datetime.datetime.now(datetime.timezone.utc)
wd = now.weekday(); h = now.hour + now.minute / 60.0
peak = (wd < 5) and ((1 <= h < 4) or (6 <= h < 10))
p('UTC now =', now.strftime('%Y-%m-%d %H:%M %a'), ' 是否高峰 =', peak)
SYSTEM = '你是思维链压缩器。用户给你一次真实软件工程任务的题面，以及当时模型写下的完整思考过程（英文）。'
SYSTEM += '请把那段思考压成一份**中文压缩稿**，供后续模型直接阅读以继续任务。'
SYSTEM += '硬要求：1) 保留所有承重的事实、结论、决定、落点、验收依据；删掉探索过程、重复、已被推翻的猜测。'
SYSTEM += '2) 引用原文时必须是真的逐字，用「」包裹；不确定是否逐字就改写、不要加引号。'
SYSTEM += '3) 必须写清「落点」——要动手改的那个文件路径，且必须是原文里确实在讨论要改的那个文件；不要用报错信息里出现的路径充数。'
SYSTEM += '4) 不许编造原文与题面里都没有的文件名、命令、标识符、数字。5) 长度不超过原文的 55%。'
SYSTEM += '直接输出压缩稿，不要前言、不要解释。'
def call(msgs, **kw):
    body = {'model': MODEL, 'messages': msgs, 'max_tokens': 8000, 'temperature': 0.2}
    body.update(kw)
    req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\_stage1_drafts.jsonl', encoding='utf-8') if l.strip()][:10]
# 前 10 条原样另存，便于同输入对照
F0 = io.open(r'D:\cfb\.cfb-offline\_cmp_think.jsonl', 'w', encoding='utf-8')
for o in rows:
    F0.write(json.dumps({'id': o['id'], 'family': o['family'], 'raw': o['raw'], 'ctx': o['ctx'], 'draft': o['draft']}, ensure_ascii=False) + '\n')
F0.close()
F = io.open(r'D:\cfb\.cfb-offline\_cmp_minimal.jsonl', 'w', encoding='utf-8')
tot = {'prompt': 0, 'compl': 0, 'reason': 0}; t0 = time.time()
for i, o in enumerate(rows, 1):
    u_ = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw'] + '\n\n请输出中文压缩稿。'
    j = call([{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': u_}], reasoning_effort='minimal')
    u = j.get('usage') or {}; msg = j['choices'][0]['message']
    r_ = (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0)
    d = (msg.get('content') or '').strip()
    tot['prompt'] += u.get('prompt_tokens', 0); tot['compl'] += u.get('completion_tokens', 0); tot['reason'] += r_
    F.write(json.dumps({'id': o['id'], 'family': o['family'], 'raw': o['raw'], 'ctx': o['ctx'], 'draft': d}, ensure_ascii=False) + '\n')
    p('[%2d] %-42s prompt=%-5d compl=%-5d reason=%-5d draft=%d' % (i, o['id'][:42], u.get('prompt_tokens',0), u.get('completion_tokens',0), r_, len(d)))
n = len(rows)
p('')
p('=== 非思考模式均值（n=%d）===' % n)
p('  prompt=%.1f  completion=%.1f  其中 reasoning=%.1f (%.0f%%)  用时 %.0fs' % (tot['prompt']/n, tot['compl']/n, tot['reason']/n, 100.0*tot['reason']/max(1,tot['compl']), time.time()-t0))
OUT.close(); F.close(); print('ok')