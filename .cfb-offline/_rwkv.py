import urllib.request, os, json, re, hashlib

os.makedirs(r"D:\cfb\.cfb-offline\rwkv7", exist_ok=True)
base = "https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/resolve/main/"
out = []
for name in ["modeling_rwkv7.py", "config.json", "configuration_rwkv7.py", "hf_rwkv_tokenizer.py"]:
    url = base + name
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=60).read()
        p = os.path.join(r"D:\cfb\.cfb-offline\rwkv7", name)
        open(p, "wb").write(data)
        out.append("%s OK %d bytes sha256=%s" % (name, len(data), hashlib.sha256(data).hexdigest()[:16]))
    except Exception as e:
        out.append("%s FAIL %s" % (name, e))

src_path = r"D:\cfb\.cfb-offline\rwkv7\modeling_rwkv7.py"
if os.path.exists(src_path):
    lines = open(src_path, encoding="utf-8").read().splitlines()
    out.append("TOTAL_LINES %d" % len(lines))

    pats = ["import ", "triton", "fla", "flash", "cuda", "autocast", "chunk", "fused", "recurrent",
            "def forward", "class ", "try:", "except", "NotImplemented", "torch.compile",
            "custom_fwd", "native", "fallback", "kernel", "requires_grad", "float32", "bfloat16"]
    counts = {}
    for p in pats:
        counts[p] = sum(1 for l in lines if p in l)
    out.append("COUNTS " + json.dumps(counts, ensure_ascii=False))

    out.append("--- IMPORT LINES ---")
    for i, l in enumerate(lines, 1):
        if re.match(r"^\s*(import|from)\s", l):
            out.append("%d: %s" % (i, l.rstrip()))

    out.append("--- TRY BLOCKS ---")
    for i, l in enumerate(lines):
        if re.match(r"^\s*try:\s*$", l):
            out.append("L%d: try:" % (i + 1))
            for j in range(i + 1, min(i + 10, len(lines))):
                out.append("   L%d: %s" % (j + 1, lines[j].rstrip()[:150]))

    out.append("--- DEF/CLASS ---")
    for i, l in enumerate(lines, 1):
        if re.match(r"^\s*(def |class )", l):
            out.append("%d: %s" % (i, l.rstrip()[:160]))

    out.append("--- CUDA/FLA/TRITON LINES ---")
    for i, l in enumerate(lines, 1):
        if any(k in l for k in ["triton", "fla.", "flash_linear", "cuda", "NotImplemented"]):
            out.append("%d: %s" % (i, l.rstrip()[:170]))

cfg_path = r"D:\cfb\.cfb-offline\rwkv7\config.json"
if os.path.exists(cfg_path):
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    out.append("--- CONFIG ---")
    out.append(json.dumps(cfg, ensure_ascii=False, indent=1)[:2500])

open(r"D:\cfb\.cfb-offline\rwkv7\ANALYSIS.txt", "w", encoding="utf-8").write("\n".join(out))
print("done", len(out))
