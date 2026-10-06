import json, re, collections
import numpy as np

rows = json.load(open('/home/user/probes/oracle_out.json'))
LAT = re.compile(r'[a-z][a-z0-9_]{2,}')
CJK = re.compile(r'[\u4e00-\u9fff]+')

def toks(t):
    s = str(t).lower(); out = [m.group(0) for m in LAT.finditer(s)]
    for m in CJK.finditer(s):
        r = m.group(0)
        for i in range(len(r) - 1): out.append(r[i:i + 2])
    return set(out)

def retain_math(row, key):
    """必需事实 = 链式中间量数字（每个都必须出现在输出里）"""
    req = row['chainResults'] or []
    if not req: return None
    got = sum(1 for x in req if re.search(r'(?<![\d.])' + re.escape(str(x)) + r'(?![\d])', row[key]))
    return got / len(req)

def retain_multihop(row, key):
    """必需事实 = 官方支撑句（title + 该 title 下的那句）；判定=该句内容词在输出中覆盖 ≥60%"""
    if not row['support']: return None
    ctx = row['context']
    # 把 context 按行切成 title: sentences
    lines = [l for l in ctx.split('\n') if l.strip()]
    blocks = {}
    for l in lines:
        if ': ' in l:
            t, s = l.split(': ', 1)
            blocks.setdefault(t, []).append(s)
    kept = []
    for t, si in zip(row['support']['title'], row['support']['sent']):
        sents = blocks.get(t)
        if not sents: continue
        idx = si if si < len(sents) else 0
        sent = sents[idx]
        need = toks(sent)
        if not need: continue
        have = toks(row[key])
        cov = len(need & have) / len(need)
        kept.append(cov >= 0.60)
    return (sum(kept) / len(kept)) if kept else None

sel = ['prod', 'uni', 'rnd', 'lead']
names = {'prod': '现有生产渲染器', 'uni': '通用选择器(新)', 'rnd': '随机', 'lead': 'lead-k'}
agg = collections.defaultdict(lambda: collections.defaultdict(list))
for row in rows:
    fn = retain_math if row['domain'] == 'math-cot' else retain_multihop
    for k in sel:
        v = fn(row, k)
        if v is not None: agg[row['domain']][k].append(v)

print('金标 oracle = 数据自带的必需事实（math: 链式中间量；multihop: 官方支撑句），30% 字符预算')
print(f"{'域':14s} {'选择器':16s} {'必需事实保留':>10s} {'篇':>4s}")
for dom in ['math-cot', 'multihop-qa']:
    for k in sel:
        vs = agg[dom][k]
        if not vs: continue
        print(f"{dom:14s} {names[k]:16s} {np.mean(vs)*100:9.1f}% {len(vs):4d}")
    print()
allv = {k: [v for dom in agg for v in agg[dom][k]] for k in sel}
print('全部:')
for k in sel:
    print(f"  {names[k]:16s} {np.mean(allv[k])*100:5.1f}%  (n={len(allv[k])})")
