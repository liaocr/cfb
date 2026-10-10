
import json, urllib.request, socket, io
socket.setdefaulttimeout(45)
UA = {"User-Agent": "Mozilla/5.0"}
OUT = io.StringIO()

def w(*a):
    print(*a, file=OUT)

def fetch(u, cap=4000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA))
        return r.read().decode("utf-8", "replace")[:cap]
    except Exception as e:
        return f"__FAIL__ {type(e).__name__}: {str(e)[:80]}"

repos = ["lyxyxyxlx/LLM-From-Scratch-0.1B", "charent/ChatLM-mini-Chinese",
         "jingyaogong/minimind", "huangxiaoye6/LLM-tuning", "Tongyun1/from-minimind-to-more"]
for r in repos:
    w("\n" + "=" * 74); w("### " + r)
    meta = fetch(f"https://api.github.com/repos/{r}", 6000)
    try:
        j = json.loads(meta)
        w(f"  desc : {j.get('description')}")
        w(f"  stars: {j.get('stargazers_count')}  lang={j.get('language')}  branch={j.get('default_branch')}  pushed={j.get('pushed_at')}")
        br = j.get("default_branch") or "main"
    except Exception:
        w("  meta 失败: " + meta[:160]); br = "main"
    got = False
    for b in [br, "main", "master"]:
        t = fetch(f"https://raw.githubusercontent.com/{r}/{b}/README.md", 9000)
        if not t.startswith("__FAIL__"):
            w(t[:5200]); got = True; break
    if not got:
        w("  (README 未取到)")

with open(r"D:\cfb\.cfb-offline\_links1.txt", "w", encoding="utf-8") as f:
    f.write(OUT.getvalue())
print("written", len(OUT.getvalue()))
