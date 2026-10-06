import json, re, os, collections
import numpy as np

OUT = [json.loads(l) for l in open('/home/user/probes/e2e_out.jsonl')]
DOCS = {}
for f in ['math_cot.jsonl', 'multihop_qa.jsonl']:
    for d in json.load(open('/home/user/probes/corpus/' + f)):
        DOCS[d['id']] = d
for rel, tag in [('transfer/HANDOFF.md', 'repo-handoff'), ('docs/KAGGLE-MICRO-RUN.md', 'repo-runbook')]:
    p = '/home/user/cfb/' + rel
    if os.path.exists(p):
        k = rel.replace('/', '_').replace('.', '_')
        DOCS[k] = {'id': k, 'domain': tag, 'text': open(p).read()[:20000]}

NUM = re.compile(r'\d+(?:[.,]\d+)*'); BT = re.compile(r'`([^`]+)`'); IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')

def anchors(t):
    a = set(NUM.findall(t))
    for m in BT.findall(t): a.add(m.strip())
    for w in IDENT.findall(t):
        if '_' in w or re.search(r'[a-z][A-Z]', w) or (w.isupper() and len(w) >= 2): a.add(w)
    return a

by = collections.defaultdict(list)
for o in OUT:
    d = DOCS.get(o['id'])
    if not d: continue
    A, B = anchors(d['text']), anchors(o['rendered'])
    cov = len(A & B) / max(1, len(A))
    junk = len(B - A) / max(1, len(B))
    ratio = o['renderedChars'] / max(1, o['chars'])
    by[o['domain']].append((cov, junk, ratio, o['renderedChars'], o['selectedOps'], o['totalUnits'], o['err']))

print(f"{'域':14s} {'篇':>3s} {'输出锚点覆盖':>12s} {'输出幻觉锚点':>12s} {'压缩比':>7s} {'选中单元':>8s} {'报错':>4s}")
for dom, vs in sorted(by.items()):
    n = len(vs)
    print(f"{dom:14s} {n:3d} {np.mean([v[0] for v in vs])*100:11.1f}% {np.mean([v[1] for v in vs])*100:11.1f}% {np.mean([v[2] for v in vs]):7.2f} {np.mean([v[4] or 0 for v in vs]):8.1f} {sum(1 for v in vs if v[6]):4d}")
allv = [v for vs in by.values() for v in vs]
print(f"{'全部':14s} {len(allv):3d} {np.mean([v[0] for v in allv])*100:11.1f}% {np.mean([v[1] for v in allv])*100:11.1f}% {np.mean([v[2] for v in allv]):7.2f} {np.mean([v[4] or 0 for v in allv]):8.1f} {sum(1 for v in allv if v[6]):4d}")
print()
o = [x for x in OUT if x['domain'] == 'math-cot'][0]
print('样例（math-cot 第 1 篇）')
print('  原文头 160 字:', DOCS[o['id']]['text'][:160].replace('\n', ' '))
print('  输出全文:', o['rendered'][:400].replace('\n', ' '))
hy = [x for x in OUT if x['domain'] == 'repo-handoff'][0]
print()
print('样例（repo-handoff，原文 %d 字 → 输出 %d 字）' % (hy['chars'], hy['renderedChars']))
print('  输出头 300 字:', hy['rendered'][:300].replace('\n', ' '))
