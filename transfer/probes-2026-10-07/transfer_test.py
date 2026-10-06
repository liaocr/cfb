"""跨域迁移实验：通用目标（锚点+内容词边际增益，无人工规则）训练的打分器，
   在**未见过的领域**上对打：随机 / lead-k / TextRank / greedy-coverage(该目标的上界) / 现模型(v排序)。"""
import json, re, math, random, collections
import numpy as np

ROWS = [json.loads(l) for l in open('/home/user/probes/units.jsonl')]
NUM = re.compile(r'\d+(?:[.,]\d+)*'); BT = re.compile(r'`([^`]+)`')
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*'); LAT = re.compile(r'[a-z][a-z0-9_]{2,}')
CUE = re.compile(r'\b(because|therefore|thus|so|hence|since|however|but|if|then|first|second|next|finally|note|assume|suppose|we get|equals)\b'
                 r'|因此|所以|但是|然而|因为|如果|首先|其次|然后|最后|注意|假设|可得|等于|可见', re.I)

def anchors(t):
    a = set(NUM.findall(t))
    for m in BT.findall(t): a.add(m.strip())
    for w in IDENT.findall(t):
        if '_' in w or re.search(r'[a-z][A-Z]', w) or (w.isupper() and len(w) >= 2): a.add(w)
    return a

def toks(t):
    out = [w.lower() for w in LAT.findall(t)]
    for m in re.finditer(r'[\u4e00-\u9fff]+', t):
        r = m.group(0)
        for i in range(len(r) - 1): out.append(r[i:i + 2])
    return out

def jac(a, b):
    A, B = set(a), set(b)
    return 0.0 if not A or not B else len(A & B) / len(A | B)

# 域内 IDF
idf = {}
for dom, rs in collections.defaultdict(list, {d: [r for r in ROWS if r['domain'] == d] for d in {r['domain'] for r in ROWS}}).items():
    df = collections.Counter()
    for r in rs:
        seen = set()
        for u in r['units']: seen.update(toks(u['t']))
        for t in seen: df[t] += 1
    idf[dom] = {t: math.log((len(rs) + 1) / (c + 0.5)) for t, c in df.items()}

def content(r, t):
    d = idf[r['domain']]
    vals = {tk: d.get(tk, math.log(len(idf[r['domain']]) + 1)) for tk in set(toks(t))}
    return set(sorted(vals, key=lambda k: -vals[k])[:40])

def unit_features(r, i):
    U = r['units']; t = U[i]['t']; L = max(1, len(t))
    a = anchors(t); c = content(r, t)
    prev = U[:i]
    a_all = set().union(*[anchors(u['t']) for u in U]) if U else set()
    a_prev = set().union(*[anchors(u['t']) for u in prev]) if prev else set()
    tk = set(toks(t))
    maxj = max([jac(tk, set(toks(u['t']))) for u in prev], default=0.0)
    tt = toks(t)
    d = idf[r['domain']]
    idfv = [d.get(x, math.log(len(d) + 1)) for x in tt] or [0.0]
    return [
        len(t) / 200.0, len(tt) / 40.0, i / max(1, len(U) - 1), 1.0 if i == 0 else 0.0,
        1.0 if i == len(U) - 1 else 0.0,
        len(NUM.findall(t)) / 5.0, len(BT.findall(t)) / 3.0,
        len([w for w in IDENT.findall(t) if '_' in w or re.search(r'[a-z][A-Z]', w) or (w.isupper() and len(w) >= 2)]) / 3.0,
        len(a - a_prev) / max(1, len(a) + 1e-9), len(a) / max(1, len(a_all) + 1e-9),
        len(c) / 40.0, float(np.mean(idfv)), float(np.max(idfv)),
        maxj, 1.0 if re.search(r'[?？]\s*$', t) else 0.0,
        len(CUE.findall(t)) / 2.0, len(re.findall(r'[=<>+\-*/]', t)) / 3.0,
        len(re.findall(r'\d', t)) / max(1, L) * 10,
    ]

def gain_of(r, i):
    """通用目标：该单元相对『文档其余部分』的边际信息增益（每字符）——无人工规则。"""
    U = r['units']
    a_i, c_i = anchors(U[i]['t']), content(r, U[i]['t'])
    rest = [j for j in range(len(U)) if j != i]
    a_r = set().union(*[anchors(U[j]['t']) for j in rest]) if rest else set()
    c_r = set().union(*[content(r, U[j]['t']) for j in rest]) if rest else set()
    g = len(a_i - a_r) + 0.5 * len(c_i - c_r)
    return g / max(1, len(U[i]['t']))

def fill(order, U, budget):
    used, sel = 0, []
    for i in order:
        L = len(U[i]['t'])
        if used + L > budget and sel: continue
        sel.append(i); used += L
        if used >= budget: break
    return sel

def metric(r, sel):
    U = r['units']
    dt = ' '.join(u['t'] for u in U); st = ' '.join(U[i]['t'] for i in sel)
    A, B = anchors(dt), anchors(st)
    cd = set().union(*[content(r, u['t']) for u in U]) if U else set()
    cs = set().union(*[content(r, U[i]['t']) for i in sel]) if sel else set()
    seen, dup = [], 0
    for i in sel:
        tk = set(toks(U[i]['t']))
        if any(jac(tk, s) >= 0.6 for s in seen): dup += 1
        seen.append(tk)
    return len(A & B) / max(1, len(A)), len(cd & cs) / max(1, len(cd)), dup / max(1, len(sel) or 1)

def sel_greedy(r, budget):
    U = r['units']; got_a, got_c, sel, used = set(), set(), [], 0
    while True:
        best, bg = None, 0.0
        for i in range(len(U)):
            if i in sel: continue
            L = len(U[i]['t'])
            if used + L > budget and sel: continue
            g = (len(anchors(U[i]['t']) - got_a) + 0.5 * len(content(r, U[i]['t']) - got_c)) / max(1, L)
            if g > bg: bg, best = g, i
        if best is None: break
        sel.append(best); used += len(U[best]['t'])
        got_a |= anchors(U[best]['t']); got_c |= content(r, U[best]['t'])
        if used >= budget: break
    return sel

def sel_textrank(r, budget):
    U = r['units']; n = len(U); tk = [set(toks(u['t'])) for u in U]
    W = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n): W[i, j] = W[j, i] = jac(tk[i], tk[j])
    s = np.ones(n) / n
    for _ in range(30):
        ns = np.zeros(n)
        for i in range(n):
            acc = sum(W[i, j] / (W[j].sum() or 1.0) * s[j] for j in range(n) if W[i, j])
            ns[i] = 0.15 / n + 0.85 * acc
        s = ns
    return fill(list(np.argsort(-s)), U, budget)

def logistic_fit(X, y, iters=3000, lr=0.1, lam=1e-3):
    Xs = np.hstack([X, np.ones((len(X), 1))]); w = np.zeros(Xs.shape[1])
    y = y.astype(float)
    for t in range(1, iters + 1):
        z = np.clip(Xs @ w, -30, 30); p = 1 / (1 + np.exp(-z))
        g = Xs.T @ (p - y) / len(y) + 2 * lam * w / len(y)
        w -= lr * g
    return w

DOMS = ['math-cot', 'multihop-qa', 'repo-handoff', 'repo-runbook']
def build(dom_filter):
    rows = [r for r in ROWS if dom_filter is None or r['domain'] == dom_filter]
    X, Y, meta = [], [], []
    for r in rows:
        for i in range(len(r['units'])):
            X.append(unit_features(r, i)); Y.append(gain_of(r, i)); meta.append((r, i))
    return rows, np.array(X), np.array(Y), meta

def eval_scorer(rows, score_fn, label):
    res = []
    for r in rows:
        budget = max(100, round(0.30 * r['docChars']))
        sc = score_fn(r)
        res.append(metric(r, fill(list(np.argsort(-np.array(sc))), r['units'], budget)))
    a = np.mean([x[0] for x in res]); c = np.mean([x[1] for x in res]); d = np.mean([x[2] for x in res])
    print(f'    {label:26s} 锚点覆盖 {a*100:5.1f}%  内容词覆盖 {c*100:5.1f}%  冗余 {d*100:4.1f}%')
    return a

print('=== 跨域迁移：训练域 → 未见测试域（目标=通用边际增益，无人工规则）===')
for train_dom, test_dom in [('math-cot', 'multihop-qa'), ('multihop-qa', 'math-cot'), ('math-cot', 'repo-handoff')]:
    tr_rows, X, Y, _ = build(train_dom)
    te_rows = [r for r in ROWS if r['domain'] == test_dom]
    w = logistic_fit(X, Y)
    print(f'  训练={train_dom}({len(tr_rows)}篇)  测试={test_dom}({len(te_rows)}篇)')
    eval_scorer(te_rows, lambda r: [unit_features(r, i) @ w[:-1] + w[-1] for i in range(len(r['units']))], '通用目标 学到的线性打分器')
    eval_scorer(te_rows, lambda r: [u['v'] for u in r['units']], '现模型 v 排序')
    eval_scorer(te_rows, lambda r: [random.Random(7).random() for _ in r['units']], '随机')
    eval_scorer(te_rows, lambda r: [anchors(u['t']).__len__() for u in r['units']], '锚点数排序(纯计数)')
    # greedy 作为该目标上界（不是选择器对比，是"目标可达性"参照）
    res = []
    for r in te_rows:
        budget = max(100, round(0.30 * r['docChars']))
        res.append(metric(r, sel_greedy(r, budget)))
    print(f'    {"greedy-coverage(目标上界)":22s} 锚点覆盖 {np.mean([x[0] for x in res])*100:5.1f}%  内容词覆盖 {np.mean([x[1] for x in res])*100:5.1f}%  冗余 {np.mean([x[2] for x in res])*100:4.1f}%')
    print()
