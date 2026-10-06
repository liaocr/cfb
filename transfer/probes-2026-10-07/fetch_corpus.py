import json, urllib.request, urllib.parse, os

OUT = os.path.dirname(os.path.abspath(__file__)) + '/corpus'
os.makedirs(OUT, exist_ok=True)

def rows(ds, cfg, split, n, off=0):
    url = ("https://datasets-server.huggingface.co/rows?dataset=" + urllib.parse.quote(ds)
           + "&config=" + cfg + "&split=" + split + "&offset=" + str(off) + "&length=" + str(n))
    req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
    return json.loads(urllib.request.urlopen(req, timeout=40).read())['rows']

# 1) 数学思维链
try:
    r = rows('openai/gsm8k', 'main', 'train', 50)
    out = [{'id': 'gsm8k-%d' % i, 'domain': 'math-cot',
            'text': x['row']['question'] + '\n' + x['row']['answer']} for i, x in enumerate(r)]
    json.dump(out, open(OUT + '/math_cot.jsonl', 'w'), ensure_ascii=False)
    print('math-cot:', len(out), 'avg chars', sum(len(o['text']) for o in out) // max(1, len(out)))
except Exception as e:
    print('gsm8k fail:', str(e)[:200])

# 2) 多跳问答（长上下文推理）
try:
    r = rows('hotpotqa/hotpot_qa', 'distractor', 'validation', 40)
    out = []
    for i, x in enumerate(r):
        row = x['row']
        ctx = ''
        for t, ss in zip(row['context']['title'], row['context']['sentences']):
            ctx += t + ': ' + ' '.join(ss) + '\n'
        out.append({'id': 'hpqa-%d' % i, 'domain': 'multihop-qa',
                    'text': row['question'] + '\n' + ctx})
    json.dump(out, open(OUT + '/multihop_qa.jsonl', 'w'), ensure_ascii=False)
    print('multihop-qa:', len(out), 'avg chars', sum(len(o['text']) for o in out) // max(1, len(out)))
except Exception as e:
    print('hotpotqa fail:', str(e)[:200])
