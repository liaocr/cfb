import io, json
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
rep = json.load(io.open(r'D:\cfb\.cfb-offline\ruler\report-teacher-all.json', encoding='utf-8'))
drafts = {}
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl', encoding='utf-8'):
    if l.strip():
        o = json.loads(l); drafts[o['id']] = o
bad = []
for r in rep['rows']:
    if not r['pass']: continue
    o = drafts[r['id']]
    rt = len(TK.encode(o['raw'])); dt = len(TK.encode(o['draft']))
    if dt > rt: bad.append((dt/rt, r['ratio'], r['id'], rt, dt, len(o['raw']), len(o['draft'])))
bad.sort(reverse=True)
OUT = io.open(r'D:\cfb\.cfb-offline\_tokenbad.txt','w',encoding='utf-8')
OUT.write('=== 过了 G7（字符比<=0.55）但在 token 上**比原文还长**的稿子 ===\n')
OUT.write('共 %d / %d 条 = %.1f%%\n\n' % (len(bad), sum(1 for r in rep['rows'] if r['pass']), 100.0*len(bad)/sum(1 for r in rep['rows'] if r['pass'])))
for t, c, i, rt, dt, rc, dc in bad[:12]:
    OUT.write('  %-46s 字符比=%.3f  token比=%.3f  (%d->%d tok, %d->%d 字)\n' % (i[:46], c, t, rt, dt, rc, dc))
OUT.write('\n=== 结论 ===\n')
OUT.write('G7 卡的是**字符比** 0.55。但稿是中文为主、原文是英文：\n')
OUT.write('  原文 3.75 字符/token；稿件 1.85 字符/token => 中文每字符贵 2.03 倍\n')
OUT.write('  于是字符比 0.55 对应 token 比约 0.55*2.03 = 1.12 —— **允许比原文更长**。\n')
OUT.close(); print('ok')