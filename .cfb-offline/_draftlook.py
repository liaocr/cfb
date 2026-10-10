
import io, json
d=[json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\_stage1_drafts.jsonl",encoding="utf-8") if l.strip()]
OUT=io.open(r"D:\cfb\.cfb-offline\_draftlook.txt","w",encoding="utf-8")
for o in d[:3]:
    OUT.write("="*78+"\n"+o["id"]+"  raw=%d draft=%d\n"%(len(o["raw"]),len(o["draft"])))
    OUT.write("--- CTX[:700] ---\n"+o["ctx"][:700]+"\n")
    OUT.write("--- RAW[:900] ---\n"+o["raw"][:900]+"\n")
    OUT.write("--- DRAFT (full) ---\n"+o["draft"]+"\n\n")
OUT.close(); print("ok")
