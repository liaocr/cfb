import json, urllib.request, urllib.parse, re, os
OUT = '/home/user/probes/corpus'
# HotpotQA 带 supporting_facts（官方标注的支撑句）
url = ("https://datasets-server.huggingface.co/rows?dataset=hotpotqa%2Fhotpot_qa&config=distractor&split=validation&offset=0&length=40")
req = urllib.request.Request(url, headers={'User-Agent': 'curl/8'})
rows = json.loads(urllib.request.urlopen(req, timeout=40).read())['rows']
out = []
for i, x in enumerate(rows):
    r = x['row']
    ctx = ''
    for t, ss in zip(r['context']['title'], r['context']['sentences']):
        ctx += t + ': ' + ' '.join(ss) + '\n'
    out.append({'id': 'hpqa-%d' % i, 'domain': 'multihop-qa',
                'text': r['question'] + '\n' + ctx,
                'answer': r['answer'],
                'supporting_facts': r['supporting_facts']})
json.dump(out, open(OUT + '/multihop_qa_labelled.json', 'w'), ensure_ascii=False)

# GSM8K：<<a op b = c>> 链式标注 = 可自动校验的中间量
gsm = []
for d in json.load(open(OUT + '/math_cot.jsonl')):
    chain = re.findall(r'<<([^>]+)>>', d['text'])
    results = [c.split('=')[-1].strip() for c in chain]
    nums = re.findall(r'\d+(?:\.\d+)?', d['text'])
    gsm.append({**d, 'chain_results': results, 'final': results[-1] if results else None, 'numbers': len(set(nums))})
json.dump(gsm, open(OUT + '/math_cot_labelled.json', 'w'), ensure_ascii=False)

print('multihop 带 support 标注:', len(out), '| 每篇支撑句数均值', round(sum(len(o['supporting_facts']['title']) for o in out) / len(out), 1))
print('math 带链式标注:', len(gsm), '| 每篇中间量均值', round(sum(len(g['chain_results']) for g in gsm) / len(gsm), 1), '| 有空链的篇数', sum(1 for g in gsm if not g['chain_results']))
print('示例 math 中间量:', gsm[0]['chain_results'])
print('示例 multihop 支撑句:', list(zip(out[0]['supporting_facts']['title'], out[0]['supporting_facts']['sent_idx']))[:3])
