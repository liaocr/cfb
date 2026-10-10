import io
files = [r'D:\cfb\transfer\HANDOFF.md', r'D:\cfb\docs\HANDOFF-2026-10-06.md', r'D:\cfb\docs\ROADMAP-GOLD.md', r'D:\cfb\docs\GOLD-EXPANSION-PROGRAM.md']
OUT = io.open(r'D:\cfb\.cfb-offline\_docs3.txt','w',encoding='utf-8')
for f in files:
    t = io.open(f, encoding='utf-8', errors='replace').read()
    OUT.write('\n\n########## %s (%d) ##########\n' % (f.replace('D:\\cfb\\',''), len(t)))
    OUT.write(t)
OUT.close(); print('ok')