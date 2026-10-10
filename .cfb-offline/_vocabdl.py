
import io, json, os, urllib.request, urllib.error
OUT = io.open(r"D:\cfb\.cfb-offline\_vocabdl.txt","w",encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a)+"\n")
DEST = r"D:\cfb\.cfb-offline\rwkv7"
BASE = "https://hf-mirror.com"

def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

p("=== repo file list ===")
try:
    raw = get(BASE + "/api/models/fla-hub/rwkv7-0.1B-g1")
    j = json.loads(raw.decode("utf-8","replace"))
    for s in j.get("siblings", []):
        p("  ", s.get("rfilename"))
except Exception as e:
    p("list err:", repr(e)[:300])

cands = ["rwkv_vocab_v20230424.txt"]
for name in cands:
    url = BASE + "/fla-hub/rwkv7-0.1B-g1/resolve/main/" + name
    try:
        b = get(url)
        fp = os.path.join(DEST, name)
        open(fp,"wb").write(b)
        p("")
        p("downloaded", name, len(b), "bytes ->", fp)
        p("first 3 lines:", b.decode("utf-8","replace").split(chr(10))[:3])
    except urllib.error.HTTPError as e:
        p("HTTPError", name, e.code, e.read()[:200])
    except Exception as e:
        p("err", name, repr(e)[:300])
OUT.close(); print("ok")
