import io, glob
files = [r'D:\cfb\docs\ARCHITECTURE.md', r'D:\cfb\docs\HISTORY-AND-EXPERIMENTS.md',
         r'D:\cfb\docs\STATUS-2026-10-07.md', r'D:\cfb\docs\EVIDENCE-PROGRAM.md',
         r'D:\cfb\transfer\notes\MICRO-MODEL-PLAN.md', r'D:\cfb\docs\TRAINING-AND-BENCHMARK.md',
         r'D:\cfb\README.md', r'D:\cfb\docs\ROADMAP-GOLD.md']
OUT = io.open(r'D:\cfb\.cfb-offline\_docs2.txt','w',encoding='utf-8')
for f in files:
    t = io.open(f, encoding='utf-8', errors='replace').read()
    OUT.write('\n\n########## %s (%d chars) ##########\n' % (f.replace('D:\\cfb\\',''), len(t)))
    OUT.write(t)
OUT.close(); print('ok')