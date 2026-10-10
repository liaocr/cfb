import io, json, collections
rows = []
for l in io.open(r'D:\cfb\.cfb-offline\teacher\drafts-v2.jsonl', encoding='utf-8'):
    if l.strip(): rows.append(json.loads(l))
OUT = io.open(r'D:\cfb\.cfb-offline\_v2empty.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
p('总行 %d' % len(rows))
empty = [o for o in rows if not (o.get('draft') or '').strip()]
p('空稿 %d' % len(empty))
p('')
p('=== 空稿的 finish / usage ===')
for o in empty:
    u = o.get('usage') or {}
    p('  %-44s finish=%-8s prompt=%-5s compl=%-5s reasoning=%-5s' % (o['id'][:44], o.get('finish'), u.get('prompt'), u.get('completion'), u.get('reasoning')))
p('')
p('finish_reason 分布（全部）: ' + json.dumps(collections.Counter(o.get('finish') for o in rows), ensure_ascii=False))
p('finish_reason 分布（空稿）: ' + json.dumps(collections.Counter(o.get('finish') for o in empty), ensure_ascii=False))
ne = [o for o in rows if (o.get('draft') or '').strip()]
p('')
p('=== 非空稿 ===')
p('  finish 分布: ' + json.dumps(collections.Counter(o.get('finish') for o in ne), ensure_ascii=False))
rs = [o['usage']['reasoning'] for o in ne if o.get('usage')]
re_ = [o['usage']['reasoning'] for o in empty if o.get('usage')]
if rs: p('  非空稿 reasoning 中位 %d 最大 %d' % (sorted(rs)[len(rs)//2], max(rs)))
if re_: p('  空稿   reasoning 中位 %d 最大 %d' % (sorted(re_)[len(re_)//2], max(re_)))
cm = [o['usage']['completion'] for o in ne if o.get('usage')]
if cm: p('  非空稿 completion 中位 %d 最大 %d' % (sorted(cm)[len(cm)//2], max(cm)))
OUT.close(); print('ok')