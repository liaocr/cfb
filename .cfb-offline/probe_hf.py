
import json, urllib.request
NL = chr(10)
lines = []
def L(s): lines.append(str(s))

BASE = "https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/raw/main/"
files = ["modeling_rwkv7.py", "__init__.py", "hf_rwkv_tokenizer.py", "tokenizer_config.json", "config.json", "generation_config.json"]
for fn in files:
    try:
        req = urllib.request.Request(BASE + fn, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=90) as r:
            b = r.read().decode("utf-8", "replace")
        open("D:/cfb/.cfb-offline/hf_rwkv7/" + fn, "w", encoding="utf-8").write(b)
        L("=== " + fn + "  (" + str(len(b)) + " chars) ===")
        if fn.endswith(".py"):
            for i, ln in enumerate(b.split(chr(10)), 1):
                s = ln.strip()
                if s.startswith("import ") or s.startswith("from ") or "fla" in s and "import" in s:
                    L("  %4d| %s" % (i, s))
        elif fn.endswith(".json"):
            L(b[:1200])
    except Exception as e:
        L("ERR " + fn + " " + repr(e))
open("D:/cfb/.cfb-offline/hf_probe.txt", "w", encoding="utf-8").write(NL.join(lines))
print("ok")
