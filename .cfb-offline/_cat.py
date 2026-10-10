import io, glob, os
OUT = io.open(r'D:\cfb\.cfb-offline\_effects.txt','w',encoding='utf-8')
pats = [r'D:\cfb\transfer\effect-*\summary.md', r'D:\cfb\transfer\effect-sub-eval\summary.md',
        r'D:\cfb\transfer\mr\run*\summary.md', r'D:\cfb\transfer\traj*\summary.md',
        r'D:\cfb\transfer\live-direct\report.md']
seen = []
for pat in pats:
    for f in sorted(glob.glob(pat)):
        if f not in seen: seen.append(f)
for f in seen:
    t = io.open(f, encoding='utf-8', errors='replace').read()
    OUT.write('\n\n########## %s (%d chars) ##########\n' % (f.replace('D:\\cfb\\',''), len(t)))
    OUT.write(t)
OUT.close()
print('files:', len(seen), 'chars:', sum(len(io.open(f,encoding="utf-8",errors="replace").read()) for f in seen))