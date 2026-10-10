import io, glob
OUT = io.open(r'D:\cfb\.cfb-offline\_doclist.txt','w',encoding='utf-8')
def p(s): OUT.write(s + '\n')
ROOT = 'D:\\cfb\\'
tot = 0; rows = []
pats = [r'D:\cfb\docs\**\*.md', r'D:\cfb\*.md', r'D:\cfb\transfer\**\*.md', r'D:\cfb\tools\**\*.md']
seen = set()
for pat in pats:
    for p_ in glob.glob(pat, recursive=True):
        if p_ in seen: continue
        seen.add(p_)
        n = len(io.open(p_, encoding='utf-8', errors='replace').read())
        rows.append((n, p_)); tot += n
rows.sort(reverse=True)
p('md 文件 %d 个，合计 %d 字符' % (len(rows), tot))
p('')
for n, p_ in rows:
    p('%9d  %s' % (n, p_.replace(ROOT, '')))
OUT.close(); print('ok')