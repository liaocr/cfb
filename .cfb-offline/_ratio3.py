import io, json
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
rep = json.load(io.open(r'D:\cfb\.cfb-offline\ruler\report-teacher-all.json', encoding='utf-8'))
drafts = {}
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl', encoding='utf-8'):
    if l.strip():
        o = json.loads(l); drafts[o['id']] = o
OUT = io.open(r'D:\cfb\.cfb-offline\_ratio3.txt','w',encoding='utf-8')
def stats(xs, label):
    xs = sorted(xs); n = len(xs)
    q = lambda t: xs[min(n-1, int(n*t))]
    OUT.write('%-34s n=%-5d min=%.3f p25=%.3f MED=%.3f p75=%.3f p90=%.3f max=%.3f mean=%.3f\n' % (label, n, xs[0], q(.25), q(.5), q(.75), q(.9), xs[-1], sum(xs)/n))
cc, ct, saved = [], [], 0
tot_raw_tok = tot_draft_tok = 0
for r in rep['rows']:
    if not r['pass']: continue
    o = drafts.get(r['id'])
    if not o: continue
    rt = len(TK.encode(o['raw'])); dt = len(TK.encode(o['draft']))
    tot_raw_tok += rt; tot_draft_tok += dt
    ct.append(dt / max(1, rt))
    cc.append(len(o['draft']) / max(1, len(o['raw'])))
OUT.write('=== 过门的 %d 条 ===\n' % len(ct))
stats(cc, '字符比 draft/raw')
stats(ct, 'token比 draft/raw  <-- 真正的压缩比')
OUT.write('\n合计 raw tokens=%d -> draft tokens=%d\n' % (tot_raw_tok, tot_draft_tok))
OUT.write('token 层面整体压缩到 %.1f%%（省 %.1f 倍，即 %.0f%% 压缩率）\n' % (100.0*tot_draft_tok/tot_raw_tok, tot_raw_tok/tot_draft_tok, 100.0*(1-tot_draft_tok/tot_raw_tok)))
# 为什么差这么多：中文 1 token/字，英文 3.74 字符/token
OUT.write('\n解释：raw 是英文 %.2f 字符/token，稿是中文 %.2f 字符/token\n' % (
    sum(len(drafts[r['id']]['raw']) for r in rep['rows'] if r['pass'])/max(1,tot_raw_tok),
    sum(len(drafts[r['id']]['draft']) for r in rep['rows'] if r['pass'])/max(1,tot_draft_tok)))
OUT.close(); print('ok')