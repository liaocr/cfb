"""金标质量三闸机械检验（无需人工）：
   闸1 内部可复算：math 的 <<a op b = c>> 逐个重算；多跳的支撑句索引可解析
   闸2 充分性：必需事实本身足以推出答案（math: 链条连续；多跳: 答案出现在支撑句里）
   闸3 必要性/排他性：答案不在非支撑处（多跳）；链条每一步的中间量被后续步骤或最终答案用到（math）
"""
import json, re, collections

MATH = json.load(open('/home/user/probes/corpus/math_cot_labelled.json'))
MULTI = json.load(open('/home/user/probes/corpus/multihop_qa_labelled.json'))

def num(s):
    return float(str(s).replace(',', ''))

# ── 闸1a：math 算式重算 ──────────────────────────────────────────────
ok = bad = 0; bad_examples = []
for d in MATH:
    for m in re.finditer(r'<<([^>]+)>>', d['text']):
        body = m.group(1)
        mm = re.match(r'^\s*([\d,\.]+)\s*([+\-*/])\s*([\d,\.]+)\s*=\s*([\d,\.]+)\s*$', body)
        if not mm:
            bad += 1; bad_examples.append(('无法解析', body)); continue
        a, op, b, c = num(mm.group(1)), mm.group(2), num(mm.group(3)), num(mm.group(4))
        try:
            v = {'+': a + b, '-': a - b, '*': a * b, '/': a / b if b else None}[op]
        except Exception:
            v = None
        if v is not None and abs(v - c) <= 1e-6 * max(1.0, abs(c)):
            ok += 1
        else:
            bad += 1; bad_examples.append(('重算不符', f'{a} {op} {b} = {c}（应为 {v}）'))
print(f"闸1a math 算式重算：通过 {ok} / {ok+bad} = {100*ok/max(1,ok+bad):.1f}%  失败样例 {bad_examples[:3]}")

# ── 闸2a：math 链条连续性（每步中间量被后续步骤或最终答案使用）────────
cont_ok = cont_tot = 0
for d in MATH:
    steps = [m.group(1) for m in re.finditer(r'<<([^>]+)>>', d['text'])]
    results = [s.split('=')[-1].strip() for s in steps]
    final = d['final']
    for i, r in enumerate(results):
        cont_tot += 1
        later = ' '.join(steps[i+1:])
        if re.search(r'(?<![\d.])' + re.escape(str(r)) + r'(?![\d])', later) or str(r) == str(final):
            cont_ok += 1
print(f"闸2a math 链条连续性：{cont_ok} / {cont_tot} = {100*cont_ok/max(1,cont_tot):.1f}%")
fin_ok = sum(1 for d in MATH if d['final'] and re.search(r'####\s*' + re.escape(str(d['final'])), d['text']))
print(f"         最终答案行一致：{fin_ok} / {len(MATH)} = {100*fin_ok/len(MATH):.1f}%")

# ── 闸1b/2b/3b：多跳（索引可解析 / 答案在支撑句内 / 答案不在别处）────
res_ok = res_bad = 0
ans_in_sup = ans_out_only = 0
by_type = collections.Counter(); fail_by_type = collections.Counter()
for d in MULTI:
    ctx = d['text']
    blocks = {}
    for l in ctx.split('\n'):
        if ': ' in l:
            t, s = l.split(': ', 1)
            blocks.setdefault(t.strip(), []).append(s)
    sup_titles = d['supporting_facts']['title']; sup_ids = d['supporting_facts']['sent_id']
    qtype = 'bridge' if len(sup_titles) == 2 and sup_titles[0] != sup_titles[1] else 'other'
    by_type[qtype] += 1
    good = True
    sup_text = []
    for t, si in zip(sup_titles, sup_ids):
        sents = blocks.get(t.strip())
        if not sents or si >= len(sents):
            res_bad += 1; good = False; continue
        res_ok += 1
        sup_text.append(sents[si])
    ans = str(d['answer']).lower().strip()
    joined = ' '.join(sup_text).lower()
    contains = ans in joined
    elsewhere = ans in ' '.join(l for l in ctx.split('\n') if not any(t in l for t in sup_titles)).lower()
    if contains: ans_in_sup += 1
    else: fail_by_type[qtype] += 1
    if not elsewhere: ans_out_only += 1
print(f"闸1b 多跳支撑句索引可解析：{res_ok} / {res_ok+res_bad} = {100*res_ok/max(1,res_ok+res_bad):.1f}%")
print(f"闸2b 答案出现在支撑句内：{ans_in_sup} / {len(MULTI)} = {100*ans_in_sup/len(MULTI):.1f}%   （题型分布 {dict(by_type)}；失败按题型 {dict(fail_by_type)}）")
print(f"闸3b 答案仅出现在支撑句（排他性）：{ans_out_only} / {len(MULTI)} = {100*ans_out_only/len(MULTI):.1f}%")

# ── 分档结论 ──────────────────────────────────────────────────────────
print()
print('分档规则（只有 A 档计入头条验收指标）：')
print('  A 档 = 闸1 通过 且 闸2 通过 且 闸3 通过')
print('  B 档 = 闸1+闸2 通过、闸3 不通过（答案也在别处出现 ⇒ 不是唯一必需事实）')
print('  C 档 = 闸1 或 闸2 不通过 ⇒ 剔除，不进金标')
