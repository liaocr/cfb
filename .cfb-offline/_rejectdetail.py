import io, json, re
d={}
for l in io.open(r'D:\cfb\.cfb-offline\_stage1_drafts.jsonl',encoding='utf-8'):
    if l.strip():
        o=json.loads(l); d[o['id']]=o
TICK=chr(96)
OUT=io.open(r'D:\cfb\.cfb-offline\_rejectdetail.txt','w',encoding='utf-8')
for uid in ['adamchainz_treepoem_pr437#b19','aiokitchen_aiomisc_pr199#b13','ariebovenberg_slotscheck_pr34#b10']:
    o=d[uid]
    OUT.write('='*78+'\n'+uid+'\n')
    OUT.write('--- DRAFT ---\n'+o['draft']+'\n')
    OUT.write('--- 稿中反引号 token 是否在 raw/ctx 里 ---\n')
    for m in re.findall(TICK+'([^'+TICK+'\n]{1,60})'+TICK, o['draft']):
        s=m.strip()
        OUT.write('   %-42s in raw/ctx: %s\n' % (s[:42], (s in o['raw']) or (s in o['ctx'])))
    OUT.write('\n')
OUT.close(); print('ok')