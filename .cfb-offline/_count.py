import io, json
p = r'D:\cfb\.cfb-offline\teacher\drafts.jsonl'
ids = []
for l in io.open(p, encoding='utf-8'):
    if l.strip():
        try: ids.append(json.loads(l)['id'])
        except Exception: pass
print('existing drafts:', len(ids), 'unique:', len(set(ids)))
sl = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl', encoding='utf-8') if l.strip()]
have = set(ids)
todo = [o for o in sl[:500] if o['unitId'] not in have]
print('shortlist total:', len(sl))
print('first 500 remaining:', len(todo))
fams = set(o['repository'] for o in sl[:500])
print('first 500 cover repositories:', len(fams))
