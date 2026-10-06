import json, re, math, random, collections

ROWS = [json.loads(l) for l in open('/home/user/probes/units.jsonl')]

NUM = re.compile(r'\d+(?:[.,]\d+)*')
BT = re.compile(r'`([^`]+)`')
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
LAT = re.compile(r'[a-z][a-z0-9_]{2,}')
CJK = re.compile(r'[\u4e00-\u9fff]')

def anchors(t):
    a = set(NUM.findall(t))
    for m in BT.findall(t): a.add(m.strip())
    for w in IDENT.findall(t):
        if '_' in w or (len(w) > 3 and re.search(r'[a-z][A-Z]', w)) or (w.isupper() and len(w) >= 2):
            a.add(w)
    return a

def tokens(t):
    out = [w.lower() for w in LAT.findall(t)]
    s = CJK.sub(lambda m: ' ' + m.group(0) + ' ', '')  # placeholder
    for m in re.finditer(r'[\u4e00-\u9fff]+', t):
        run = m.group(0)
        for i in range(len(run) - 1): out.append(run[i:i + 2])
    return out

def jac(a, b):
    A, B = set(a), set(b)
    if not A or not B: return 0.0
    return len(A & B) / len(A | B)

# 域内 IDF
by_dom = collections.defaultdict(list)
for r in ROWS: by_dom[r['domain']].append(r)
idf = {}
for dom, rs in by_dom.items():
    df = collections.Counter()
    for r in rs:
        seen = set()
        for u in r['units']: seen.update(tokens(u['t']))
        for t in seen: df[t] += 1
    N = len(rs)
    idf[dom] = {t: math.log((N + 1) / (c + 0.5)) for t, c in df.items()}

def content_tokens(r, t):
    toks = tokens(t)
    id_ = idf[r['domain']]
    vals = sorted({tok: id_.get(tok, math.log(len(by_dom[r['domain']]) + 1)) for tok in toks}.items(), key=lambda kv: -kv[1])
    keep = [kv for kv in vals if kv[1] > 0.35]
    return [kv[0] for kv in keep[:40]]

def metric(r, sel_idx):
    doc_units = r['units']
    doc_txt = ' '.join(u['t'] for u in doc_units)
    sel_txt = ' '.join(doc_units[i]['t'] for i in sel_idx)
    A_doc, A_sel = anchors(doc_txt), anchors(sel_txt)
    anc_rec = len(A_doc & A_sel) / max(1, len(A_doc))
    C_doc = set(t for u in doc_units for t in content_tokens(r, u['t']))
    C_sel = set(t for i in sel_idx for t in content_tokens(r, doc_units[i]['t']))
    idf_cov = len(C_doc & C_sel) / max(1, len(C_doc))
    # 冗余：选中单元中与先前选中单元 token Jaccard>=0.6 的比例
    dup = 0
    seen = []
    for i in sel_idx:
        tk = set(tokens(doc_units[i]['t']))
        if any(jac(tk, s) >= 0.6 for s in seen): dup += 1
        seen.append(tk)
    return anc_rec, idf_cov, dup / max(1, len(sel_idx))

def fill(order, units, budget):
    used, sel = 0, []
    for i in order:
        L = len(units[i]['t'])
        if used + L > budget and sel: continue
        sel.append(i); used += L
        if used >= budget: break
    return sel

def sel_random(r, budget, seed):
    rnd = random.Random(seed)
    order = list(range(len(r['units']))); rnd.shuffle(order)
    return fill(order, r['units'], budget)

def sel_lead(r, budget):
    return fill(list(range(len(r['units']))), r['units'], budget)

def sel_textrank(r, budget, iters=30, d=0.85):
    U = r['units']; n = len(U)
    tks = [set(tokens(u['t'])) for u in U]
    W = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            w = jac(tks[i], tks[j]) if (tks[i] and tks[j]) else 0.0
            W[i][j] = W[j][i] = w
    s = [1.0 / n] * n
    for _ in range(iters):
        ns = [0.0] * n
        for i in range(n):
            tsum = sum(W[i]) or 1.0
            acc = 0.0
            for j in range(n):
                if W[i][j]: acc += W[i][j] / (sum(W[j]) or 1.0) * s[j]
            ns[i] = (1 - d) / n + d * acc
        s = ns
    order = sorted(range(n), key=lambda i: -s[i])
    return fill(order, U, budget)

def sel_coverage(r, budget):
    """通用、无标注目标：每字符带来的『新锚点+新内容词』增益最大者优先。"""
    U = r['units']; n = len(U)
    got_a, got_c, sel, used = set(), set(), [], 0
    while True:
        best, gain = None, 0.0
        for i in range(n):
            if i in sel: continue
            L = len(U[i]['t'])
            if used + L > budget and sel: continue
            a, c = anchors(U[i]['t']), set(content_tokens(r, U[i]['t']))
            g = (len(a - got_a) + 0.5 * len(c - got_c)) / max(1, L)
            if g > gain: gain, best = g, i
        if best is None: break
        sel.append(best); used += len(U[best]['t'])
        got_a |= anchors(U[best]['t']); got_c |= set(content_tokens(r, U[best]['t']))
        if used >= budget: break
    return sel

def sel_model(r, budget, use_caps=True):
    """部署路径：selectOpsV5 的选中集合（按原顺序），或按 v 排序（去掉槽位硬上限）。"""
    U = r['units']
    if use_caps:
        order = r['chosenIdx']
    else:
        order = sorted(range(len(U)), key=lambda i: -U[i]['v'])
    return fill(order, U, budget)

def run(name, fn, doc_filter=None):
    rows = [r for r in ROWS if doc_filter is None or r['domain'] == doc_filter]
    res = collections.defaultdict(list)
    for r in rows:
        budget = max(100, round(0.30 * r['docChars']))
        for tag, sel in fn(r, budget):
            a, c, d = metric(r, sel)
            res[tag].append((a, c, d, len(sel)))
    print(f'--- {name} (n={len(rows)} docs) ---')
    for tag, vs in sorted(res.items()):
        na = sum(v[0] for v in vs) / len(vs)
        nc = sum(v[1] for v in vs) / len(vs)
        nd = sum(v[2] for v in vs) / len(vs)
        nsel = sum(v[3] for v in vs) / len(vs)
        print(f'  {tag:22s} 锚点覆盖 {na*100:5.1f}%  内容词覆盖 {nc*100:5.1f}%  冗余 {nd*100:4.1f}%  选中单元 {nsel:4.1f}')

def standard(r, budget):
    return [
        ('random', sel_random(r, budget, 7)),
        ('lead-k', sel_lead(r, budget)),
        ('textrank', sel_textrank(r, budget)),
        ('greedy-coverage', sel_coverage(r, budget)),
        ('current-model(部署)', sel_model(r, budget, True)),
        ('current-model(v排序)', sel_model(r, budget, False)),
    ]

for dom in ['math-cot', 'multihop-qa', 'repo-handoff', 'repo-runbook']:
    run(dom, standard, dom)
run('全部', standard, None)
