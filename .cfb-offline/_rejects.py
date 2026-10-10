
import io, json
import sys
sys.path.insert(0, r"D:\cfb\tools")
from subprocess import run
rep=json.load(io.open(r"D:\cfb\.cfb-offline\ruler\report-teacher20.json",encoding="utf-8"))
OUT=io.open(r"D:\cfb\.cfb-offline\_rejects.txt","w",encoding="utf-8")
for row in rep["rows"]:
    if row["pass"]: continue
    OUT.write("="*78+"\n"+row["id"]+"  failed="+str(row["failed"])+" ratio=%.3f copy=%.3f\n"%(row["ratio"],row["copy"]))
    OUT.write("  anchors="+json.dumps(row["anchors"],ensure_ascii=False)+"\n")
OUT.close(); print("ok")
