
import os, io, json, gzip, sys, glob, collections

OUT = io.open(r"D:\cfb\.cfb-offline\_census.txt", "w", encoding="utf-8")
def p(*a):
    OUT.write(" ".join(str(x) for x in a) + "\n")

ROOT = r"D:\cfb"

# ---------- 1. census batch files ----------
p("="*70)
p("1) census batch files")
p("="*70)
pat = os.path.join(ROOT, "transfer", "models", "micro-generator-v4flash-scenarios", "birth-units-census-batch*.jsonl.gz")
for f in sorted(glob.glob(pat)):
    sz = os.path.getsize(f)
    n = 0
    keys = None
    textfields = collections.Counter()
    total_text = 0
    maxrec = 0
    lens = []
    try:
        with gzip.open(f, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line: continue
                n += 1
                if keys is None:
                    try:
                        o = json.loads(line)
                        keys = list(o.keys())
                    except Exception as e:
                        keys = ["<parse-fail>", str(e)[:80]]
                if n <= 5 or n % 200 == 0:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    for k, v in o.items():
                        if isinstance(v, str) and len(v) > 60:
                            textfields[k] += 1
                            total_text += len(v)
                            lens.append(len(v))
                            if len(v) > maxrec: maxrec = len(v)
    except Exception as e:
        p(os.path.basename(f), "ERROR", repr(e)[:200]); continue
    p("---", os.path.basename(f), "bytes=%d" % sz, "lines=%d" % n)
    p("    keys:", keys)
    p("    textfields(sampled):", dict(textfields.most_common(8)))
    p("    sampled_total_chars=%d max=%d" % (total_text, maxrec))

# ---------- 2. .cfb-runtime/traj ----------
p("")
p("="*70)
p("2) .cfb-runtime/traj")
p("="*70)
td = os.path.join(ROOT, ".cfb-runtime", "traj")
files = []
if os.path.isdir(td):
    for dp, dn, fn in os.walk(td):
        for x in fn:
            files.append(os.path.join(dp, x))
p("files=%d" % len(files))
tot = sum(os.path.getsize(x) for x in files)
p("bytes=%d" % tot)
ext = collections.Counter(os.path.splitext(x)[1] for x in files)
p("ext:", dict(ext))
for x in sorted(files, key=lambda z: -os.path.getsize(z))[:5]:
    p("  big:", os.path.relpath(x, ROOT), os.path.getsize(x))

# sample one json
for x in files:
    if x.endswith(".json"):
        try:
            o = json.load(io.open(x, encoding="utf-8", errors="replace"))
            p("sample:", os.path.relpath(x, ROOT))
            if isinstance(o, dict):
                p("  keys:", list(o.keys())[:30])
                for k, v in o.items():
                    if isinstance(v, str) and len(v) > 200:
                        p("  longstr:", k, len(v))
                    if isinstance(v, list):
                        p("  list:", k, len(v))
        except Exception as e:
            p("sample err", repr(e)[:120])
        break

# ---------- 3. recordings.json ----------
p("")
p("="*70)
p("3) transfer/recordings.json")
p("="*70)
rp = os.path.join(ROOT, "transfer", "recordings.json")
if os.path.exists(rp):
    try:
        o = json.load(io.open(rp, encoding="utf-8", errors="replace"))
        p("type:", type(o).__name__)
        if isinstance(o, dict):
            p("keys:", list(o.keys())[:40])
        elif isinstance(o, list):
            p("len:", len(o))
            if o and isinstance(o[0], dict):
                p("item keys:", list(o[0].keys()))
    except Exception as e:
        p("err", repr(e)[:200])
else:
    p("MISSING")

# ---------- 4. gold-rejected ----------
p("")
p("="*70)
p("4) transfer/gold-rejected")
p("="*70)
gd = os.path.join(ROOT, "transfer", "gold-rejected")
if os.path.isdir(gd):
    for x in sorted(os.listdir(gd)):
        fp = os.path.join(gd, x)
        p("  %-40s %8d" % (x, os.path.getsize(fp) if os.path.isfile(fp) else -1))
else:
    p("MISSING")

p("")
p("="*70)
p("5) transfer/gold")
p("="*70)
gd2 = os.path.join(ROOT, "transfer", "gold")
if os.path.isdir(gd2):
    for x in sorted(os.listdir(gd2)):
        fp = os.path.join(gd2, x)
        p("  %-40s %8d" % (x, os.path.getsize(fp) if os.path.isfile(fp) else -1))

OUT.close()
print("done")
