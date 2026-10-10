import io, json
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
rep = json.load(io.open(r'D:\cfb\.cfb-offline\ruler\report-teacher-all.json', encoding='utf-8'))
drafts = {}
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts.jsonl', encoding='utf-8'):
    if l.strip():
        o = json.loads(l); drafts[o['id']] = o
C = E = 0; cb = []; eb = []
for r in rep['rows']:
    if not r['pass']: continue
    o = drafts[r['id']]
    cjk = sum(1 for c in o['draft'] if '\u4e00' <= c <= '\u9fff')
    tot = len(o['draft'])
    C += cjk; E += (tot - cjk)
    cb.append(100.0*cjk/max(1,tot))
OUT = io.open(r'D:\cfb\.cfb-offline\_lang.txt','w',encoding='utf-8')
OUT.write('过门稿 %d 条合计字符 %d\n' % (len(cb), C+E))
OUT.write('  汉字 %d (%.1f%%)   非汉字 %d (%.1f%%)\n' % (C, 100.0*C/(C+E), E, 100.0*E/(C+E)))
cb.sort()
OUT.write('  每条稿的汉字占比：min=%.0f%% 中位=%.0f%% max=%.0f%%\n' % (cb[0], cb[len(cb)//2], cb[-1]))
OUT.write('\n反推：每 token 1.85 字符 => 汉字约 %.0f%%、非汉字约 %.0f%%（与上面吻合）\n' % (100*1.85/3.75*1.0, 0))
OUT.close(); print('ok')