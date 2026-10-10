# -*- coding: utf-8 -*-
# 批量生成压缩稿（带断点续传、多线程、失败重试）。产出即训练集候选。
import io, json, os, sys, time, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

N       = int(sys.argv[1]) if len(sys.argv) > 1 else 100
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
SHORT   = r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl'
OUTP    = r'D:\cfb\.cfb-offline\teacher\drafts.jsonl'
LOGP    = r'D:\cfb\.cfb-offline\teacher\run.log'
os.makedirs(os.path.dirname(OUTP), exist_ok=True)

env = {}
for l in io.open(r'C:\Users\Liaocr\.secrets\keys.env', encoding='utf-8'):
    l = l.strip()
    if l and not l.startswith('#') and '=' in l:
        k, v = l.split('=', 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env['DEEPSEEK_API_KEY'], env['DEEPSEEK_BASE_URL'], env['DEEPSEEK_MODEL']

SYSTEM = ('你是思维链压缩器。用户给你一次真实软件工程任务的题面，以及当时模型写下的完整思考过程（英文）。'
  '请把那段思考压成一份**中文压缩稿**，供后续模型直接阅读以继续任务。'
  '硬要求：1) 保留所有承重的事实、结论、决定、落点、验收依据；删掉探索过程、重复、已被推翻的猜测。'
  '2) 引用原文时必须是真的逐字，用「」包裹；不确定是否逐字就改写、不要加引号。'
  '3) 必须写清「落点」——要动手改的那个文件路径，且必须是原文里确实在讨论要改的那个文件；不要用报错信息里出现的路径充数。'
  '4) 不许编造原文与题面里都没有的文件名、命令、标识符、数字。5) 长度不超过原文的 55%。'
  '直接输出压缩稿，不要前言、不要解释。')

def call(msgs, max_tokens=8000, tries=5):
    body = {'model': MODEL, 'messages': msgs, 'max_tokens': max_tokens, 'temperature': 0.2}
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read().decode('utf-8', 'replace')), None
        except urllib.error.HTTPError as e:
            last = 'HTTP %s %s' % (e.code, e.read()[:150])
        except Exception as e:
            last = repr(e)[:150]
        time.sleep(1.5 * (a + 1))
    return None, last

rows = [json.loads(l) for l in io.open(SHORT, encoding='utf-8') if l.strip()]
todo = rows[:N]

# 断点续传
done = set()
if os.path.exists(OUTP):
    for l in io.open(OUTP, encoding='utf-8'):
        if l.strip():
            try: done.add(json.loads(l)['id'])
            except Exception: pass
todo = [o for o in todo if o['unitId'] not in done]

lock = threading.Lock()
F = io.open(OUTP, 'a', encoding='utf-8')
L = io.open(LOGP, 'a', encoding='utf-8')
st = {'ok': 0, 'fail': 0, 'prompt': 0, 'compl': 0, 'reason': 0}
t0 = time.time()

def work(pair):
    i, o = pair
    u_ = '[题面]\n' + o['ctx'] + '\n\n[思考过程]\n' + o['raw'] + '\n\n请输出中文压缩稿。'
    j, err = call([{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': u_}])
    if err:
        with lock:
            st['fail'] += 1
            L.write('FAIL %s %s\n' % (o['unitId'], err)); L.flush()
        return
    u = j.get('usage') or {}; msg = j['choices'][0]['message']
    d = (msg.get('content') or '').strip()
    rec = {'id': o['unitId'], 'family': o['repository'], 'license': o.get('license'),
           'raw': o['raw'], 'ctx': o['ctx'], 'draft': d,
           'finish': j['choices'][0].get('finish_reason'),
           'usage': {'prompt': u.get('prompt_tokens', 0), 'completion': u.get('completion_tokens', 0),
                     'reasoning': (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0),
                     'relayCost': u.get('cost', 0)}}
    with lock:
        F.write(json.dumps(rec, ensure_ascii=False) + '\n'); F.flush()
        st['ok'] += 1
        st['prompt'] += rec['usage']['prompt']; st['compl'] += rec['usage']['completion']; st['reason'] += rec['usage']['reasoning']
        n = st['ok'] + st['fail']
        if n % 10 == 0 or n == len(todo):
            el = time.time() - t0
            L.write('progress %d/%d ok=%d fail=%d %.0fs (%.1fs/unit)\n' % (n, len(todo), st['ok'], st['fail'], el, el / max(1, n))); L.flush()

with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(work, list(enumerate(todo, 1))))

n = max(1, st['ok'])
el = time.time() - t0
L.write('=== done ok=%d fail=%d %.0fs ===\n' % (st['ok'], st['fail'], el))
L.write('avg prompt=%.0f completion=%.0f reasoning=%.0f (%.0f%% of output)\n' % (
    st['prompt']/n, st['compl']/n, st['reason']/n, 100.0*st['reason']/max(1, st['compl'])))
off = (st['prompt']*0.15 + st['compl']*0.60)/1e6
pk  = (st['prompt']*0.30 + st['compl']*1.20)/1e6
L.write('官方价：本批 %.2f 条 低谷 $%.4f 高峰 $%.4f => 单条 低谷 $%.6f 高峰 $%.6f\n' % (n, off, pk, off/n, pk/n))
L.write('  外推 1000 条：低谷 $%.2f 高峰 $%.2f；4687 条：低谷 $%.2f 高峰 $%.2f\n' % (off/n*1000, pk/n*1000, off/n*4687, pk/n*4687))
L.close(); F.close()
print('ok ok=%d fail=%d %.0fs' % (st['ok'], st['fail'], el))