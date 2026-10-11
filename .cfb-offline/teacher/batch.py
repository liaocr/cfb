# -*- coding: utf-8 -*-
# 批量生成稿子。提示词外部传入（唯一权威源 transfer/prompts/）。
#
# 关键：**关掉思考**。这个任务是「把原文里已有的决定搬运成稿」，不是解新题，不需要推理链。
# 开思考的代价实测：v1 均摊 1562 思考 token/条；v2 更是中位 3688、20% 撞满 8000 预算导致
# finish_reason=length、正文 0 字 —— **HTTP 200 的假成功**，统计脚本会把空稿当「压缩比 0」算进去。
# 关掉后思考 = 0，速度快 5 倍，假成功模式直接消失。
#
# 注意 reasoning_effort=minimal 在这个中转站上**不被遵守**（实测思考仍有 1000-4400 token），
# 真正管用的是 thinking={'type':'disabled'}。
import io, json, os, sys, time, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

N       = int(sys.argv[1]) if len(sys.argv) > 1 else 100
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
PROMPTF = sys.argv[3] if len(sys.argv) > 3 else r'D:\cfb\transfer\prompts\compress-zh.txt'
OUTP    = sys.argv[4] if len(sys.argv) > 4 else r'D:\cfb\.cfb-offline\teacher\drafts.jsonl'
THINK   = (sys.argv[5] if len(sys.argv) > 5 else 'off') == 'on'
SHORT   = r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl'
LOGP    = OUTP + '.log'
os.makedirs(os.path.dirname(OUTP), exist_ok=True)

env = {}
for l in io.open(r'C:\Users\Liaocr\.secrets\keys.env', encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env['DEEPSEEK_API_KEY'], env['DEEPSEEK_BASE_URL'], env['DEEPSEEK_MODEL']
# 提示词**逐字保留换行**：样例驱动的提示词被压成一行就废了（样例是 flash 唯一真正读的东西）。
# 只剥掉以 # 开头的注释行（提示词里没有 #，所以这是安全的）。
SYSTEM = '\n'.join(x for x in io.open(PROMPTF, encoding='utf-8').read().split('\n')
                  if not x.lstrip().startswith('#'))
print('prompt:', os.path.basename(PROMPTF), '| thinking:', 'ON' if THINK else 'OFF')

def once(msgs, max_tokens):
    body = {'model': MODEL, 'messages': msgs, 'max_tokens': max_tokens, 'temperature': 0.2}
    if not THINK: body['thinking'] = {'type': 'disabled'}
    req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))

def call(msgs):
    """只有拿到**非空且未截断**的稿才算成功 —— 空正文是 HTTP 200 的假成功。"""
    last = None
    for budget in ([8000] if not THINK else [8000, 20000]):
        for attempt in range(4):
            try:
                j = once(msgs, budget)
            except urllib.error.HTTPError as e:
                last = 'HTTP %s %s' % (e.code, e.read()[:110]); time.sleep(2 * (attempt + 1)); continue
            except Exception as e:
                last = repr(e)[:110]; time.sleep(2 * (attempt + 1)); continue
            ch = j['choices'][0]; msg = ch['message']
            content = (msg.get('content') or '').strip()
            fr = ch.get('finish_reason')
            if content and fr != 'length': return j, None
            last = 'empty-or-truncated(finish=%s)' % fr
            time.sleep(1.0)
    return None, last

rows = [json.loads(l) for l in io.open(SHORT, encoding='utf-8') if l.strip()][:N]
done = set()
if os.path.exists(OUTP):
    for l in io.open(OUTP, encoding='utf-8'):
        if l.strip():
            try:
                o = json.loads(l)
                if (o.get('draft') or '').strip() and o.get('finish') != 'length': done.add(o['id'])
            except Exception: pass
todo = [o for o in rows if o['unitId'] not in done]
print('todo:', len(todo), '/', len(rows))

lock = threading.Lock()
F = io.open(OUTP, 'a', encoding='utf-8')
L = io.open(LOGP, 'a', encoding='utf-8')
st = {'ok': 0, 'fail': 0, 'prompt': 0, 'compl': 0, 'reason': 0}
t0 = time.time()

def work(pair):
    i, o = pair
    u_ = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw']
    j, err = call([{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': u_}])
    if err:
        with lock:
            st['fail'] += 1; L.write('FAIL %s %s\n' % (o['unitId'], err)); L.flush()
        return
    u = j.get('usage') or {}; msg = j['choices'][0]['message']
    rec = {'id': o['unitId'], 'family': o['repository'], 'license': o.get('license'),
           'raw': o['raw'], 'ctx': o['ctx'], 'draft': (msg.get('content') or '').strip(),
           'finish': j['choices'][0].get('finish_reason'), 'thinking': THINK,
           'usage': {'prompt': u.get('prompt_tokens', 0), 'completion': u.get('completion_tokens', 0),
                     'reasoning': (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0)}}
    with lock:
        F.write(json.dumps(rec, ensure_ascii=False) + '\n'); F.flush()
        st['ok'] += 1
        st['prompt'] += rec['usage']['prompt']; st['compl'] += rec['usage']['completion']; st['reason'] += rec['usage']['reasoning']
        n = st['ok'] + st['fail']
        if n % 20 == 0 or n == len(todo):
            L.write('progress %d/%d ok=%d fail=%d %.0fs\n' % (n, len(todo), st['ok'], st['fail'], time.time() - t0)); L.flush()

with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(work, list(enumerate(todo, 1))))

n = max(1, st['ok']); el = time.time() - t0
off = (st['prompt']*0.15 + st['compl']*0.60)/1e6
L.write('=== done ok=%d fail=%d %.0fs | prompt=%.0f completion=%.0f reasoning=%.0f | 低谷 $%.4f ===\n' % (
    st['ok'], st['fail'], el, st['prompt']/n, st['compl']/n, st['reason']/n, off))
L.close(); F.close()
print('ok=%d fail=%d %.0fs' % (st['ok'], st['fail'], el))