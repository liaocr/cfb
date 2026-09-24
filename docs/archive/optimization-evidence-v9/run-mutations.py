from pathlib import Path
import subprocess,json,os
root=Path(__file__).resolve().parents[2]
cases=[
 ('rebuild-prepared-prompt','index.js','runtime.preparedJudgment?.env === env','false'),
 ('ignore-full-prompt-identity','index.js',"+ '\\n' + prompt","+ '\\n' + prompt.slice(0, 1000)"),
 ('ignore-credential-identity','index.js','key, cfg.model, cfg.maxOutputTokens','null, cfg.model, cfg.maxOutputTokens'),
 ('cancel-healthy-subscriber','exact-flights.js','if (!f.users && !f.done)','if (!f.done)'),
 ('leave-doomed-compiler-running','index.js','task.abort?.abort()','void 0'),
 ('forget-first-content-on-timeout','index.js','meta.firstContentAt ??= Date.now(); meta.lastContentAt = Date.now()','void 0'),
 ('omit-prior-inference-context','evidence-ledger.js',"(env.priorMemory || []).map(x => x.text).join('\\n')","''"),
 ('bypass-default-production-sharing','index.js','{ ...budget, flights: compilerFlights }','{ ...budget }'),
]
results=[]
for name,file,a,b in cases:
 p=root/file; source=p.read_text(); assert a in source,name
 try:
  p.write_text(source.replace(a,b,1))
  r=subprocess.run(['node','efficiency.selftest.mjs'],cwd=root,text=True,capture_output=True,timeout=20,env={k:v for k,v in os.environ.items() if k!='CFB_V9_EVIDENCE_DIR'})
  failures=[line for line in (r.stdout+r.stderr).splitlines() if line.startswith('FAIL ')]
  results.append({'mutation':name,'detected':r.returncode!=0 and bool(failures),'failures':failures})
 finally:p.write_text(source)
out=root/'docs/optimization-evidence-v9';out.mkdir(exist_ok=True)
(out/'mutations.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(results,ensure_ascii=False,indent=2));assert all(r['detected'] for r in results)
