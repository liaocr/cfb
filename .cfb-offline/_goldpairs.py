import io, json, glob
rows = []
for f in sorted(glob.glob(r'D:\cfb\transfer\gold\*\*.json')):
    o = json.load(io.open(f, encoding='utf-8'))
    rows.append({'id': o.get('id'), 'raw': o.get('raw') or '', 'ctx': o.get('ctx') or '', 'draft': o.get('draft') or ''})
with io.open(r'D:\cfb\.cfb-offline\_goldpairs.jsonl','w',encoding='utf-8') as F:
    for r in rows: F.write(json.dumps(r, ensure_ascii=False) + '\n')
print('wrote', len(rows))