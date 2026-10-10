import io, json, glob
OUT = io.open(r'D:\cfb\.cfb-offline\_hand2.txt','w',encoding='utf-8')
rows = []
for f in sorted(glob.glob(r'D:\cfb\.cfb-runtime\traj\*\hand-samples.jsonl')):
    for l in io.open(f, encoding='utf-8'):
        if l.strip():
            try: rows.append(json.loads(l))
            except Exception: pass
elig = [o for o in rows if o.get('trainingEligible') and o.get('draft') and o.get('raw')]
elig.sort(key=lambda o: len(o['draft'])/max(1,len(o['raw'])))
# 看最短的和中位的各两份
for tag, o in [('最短', elig[0]), ('p25', elig[len(elig)//4]), ('中位', elig[len(elig)//2])]:
    OUT.write('='*78 + '\n[%s] %s  raw=%d draft=%d 比值=%.3f\n' % (tag, o['id'], len(o['raw']), len(o['draft']), len(o['draft'])/len(o['raw'])))
    OUT.write('--- CTX ---\n' + (o.get('ctx') or '')[:600] + '\n')
    OUT.write('--- DRAFT 全文 ---\n' + o['draft'] + '\n')
    OUT.write('--- raw 前 500 ---\n' + o['raw'][:500] + '\n\n')
OUT.close(); print('ok')