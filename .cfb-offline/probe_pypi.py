
import json, os, zipfile, urllib.request
NL = chr(10)
lines = []
def L(s): lines.append(str(s))

for pkg in ["flash-linear-attention", "fla"]:
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/%s/json" % pkg, timeout=60) as r:
            j = json.load(r)
        L("=== %s  version=%s" % (pkg, j["info"]["version"]))
        L("  summary: " + str(j["info"]["summary"]))
        L("  requires_dist: " + str(j["info"].get("requires_dist")))
        ws = [u for u in j["urls"] if u["filename"].endswith(".whl")]
        L("  wheels: " + str([u["filename"] for u in ws]))
        if ws:
            dest = "D:/cfb/.cfb-offline/%s.whl" % pkg
            urllib.request.urlretrieve(ws[0]["url"], dest)
            z = zipfile.ZipFile(dest)
            names = z.namelist()
            L("  bytes=%d entries=%d" % (os.path.getsize(dest), len(names)))
            mods = sorted(set(n.split("/")[1] for n in names if n.startswith("fla/") and len(n.split("/")) > 1))
            L("  fla/*: " + ", ".join(mods))
            rw = [n for n in names if "rwkv7" in n.lower()]
            L("  rwkv7 (%d): " % len(rw) + ", ".join(rw[:25]))
    except Exception as e:
        L("=== %s ERR %r" % (pkg, e))
open("D:/cfb/.cfb-offline/pypi_probe.txt", "w", encoding="utf-8").write(NL.join(lines))
print("ok")
