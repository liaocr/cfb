
import json, os, zipfile, urllib.request
NL = chr(10)
lines = []
def L(s): lines.append(str(s))

try:
    with urllib.request.urlopen("https://pypi.org/pypi/fla-core/json", timeout=60) as r:
        j = json.load(r)
    urls = [u for u in j["urls"] if u["filename"].endswith(".whl")]
    L("fla-core " + j["info"]["version"] + " wheels: " + str([u["filename"] for u in urls]))
    L("requires_dist: " + str(j["info"].get("requires_dist")))
    w = urls[0]
    dest = "D:/cfb/.cfb-offline/fla-core.whl"
    urllib.request.urlretrieve(w["url"], dest)
    z = zipfile.ZipFile(dest)
    names = z.namelist()
    L("wheel bytes: " + str(os.path.getsize(dest)) + "  entries: " + str(len(names)))
    L("top-level: " + ", ".join(sorted(set(n.split("/")[0] for n in names))))
    L("fla/*: " + ", ".join(sorted(set(n.split("/")[1] for n in names if n.startswith("fla/") and len(n.split("/")) > 1))))
    hits = [n for n in names if "rwkv7" in n.lower()]
    L("rwkv7 entries: " + str(len(hits)) + " -> " + ", ".join(hits[:20]))
    hits2 = [n for n in names if "/models/" in n]
    L("models entries: " + str(len(hits2)) + " -> " + ", ".join(hits2[:20]))
except Exception as e:
    L("FLA-CORE ERR " + repr(e))

for url in ["https://huggingface.co/api/models/fla-hub/rwkv7-0.1B-g1",
            "https://hf-mirror.com/api/models/fla-hub/rwkv7-0.1B-g1"]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.load(r)
        L("HF OK " + url)
        L("  siblings: " + ", ".join(s["rfilename"] for s in j.get("siblings", [])))
        break
    except Exception as e:
        L("HF ERR " + url + " " + repr(e))

for url in ["https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/raw/main/config.json",
            "https://raw.githubusercontent.com/fla-org/flash-linear-attention/main/fla/models/rwkv7/__init__.py"]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read().decode("utf-8", "replace")
        L("OK " + url + " (" + str(len(b)) + " chars)")
        L("  " + b[:500].replace(NL, NL + "  "))
    except Exception as e:
        L("ERR " + url + " " + repr(e))

open("D:/cfb/.cfb-offline/probe.txt", "w", encoding="utf-8").write(NL.join(lines))
print("done")
