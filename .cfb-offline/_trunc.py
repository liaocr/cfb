import io, json
rows = [json.loads(l) for l in io.open(r'D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl', encoding='utf-8') if l.strip()]
n = sum(1 for r in rows if 'middle of the visible history omitted' in (r.get('ctx') or ''))
L = [len(r.get('ctx') or '') for r in rows]
print('ctx 被截断（含 omitted 标记）: %d/%d = %.1f%%' % (n, len(rows), 100.0*n/len(rows)))
print('ctx 长度 == 4043 的: %d/%d' % (sum(1 for x in L if x==4043), len(rows)))
print('raw 长度中位: %d' % sorted(len(r['raw']) for r in rows)[len(rows)//2])