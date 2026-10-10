
import json, urllib.request, socket, io
socket.setdefaulttimeout(50)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
OUT = io.StringIO()
def w(*a): print(*a, file=OUT)
def fetch(u, cap=6000):
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA))
        return r.read().decode("utf-8", "replace")[:cap]
    except Exception as e:
        return f"__FAIL__ {type(e).__name__}: {str(e)[:90]}"

w("#" * 74); w("# 1. ModelScope topdktu/unirec-0.1b")
t = fetch("https://www.modelscope.cn/api/v1/models/topdktu/unirec-0.1b", 9000)
w(t[:3500])
w(""); w("--- README ---")
w(fetch("https://www.modelscope.cn/api/v1/models/topdktu/unirec-0.1b/repo?Revision=master&FilePath=README.md", 6000)[:3000])

w(""); w("#" * 74); w("# 2. HF fla-hub/rwkv7-0.1B-g1 (via hf-mirror)")
for u in ["https://hf-mirror.com/api/models/fla-hub/rwkv7-0.1B-g1"]:
    t = fetch(u, 9000)
    try:
        j = json.loads(t)
        w("  files: " + str([s["rfilename"] for s in j.get("siblings", [])][:20]))
        w("  tags : " + str(j.get("tags", [])[:16]))
        w("  dl=" + str(j.get("downloads")) + " likes=" + str(j.get("likes")))
    except Exception:
        w("  " + t[:300])
w("--- README ---")
w(fetch("https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/resolve/main/README.md", 4000)[:3000])

w(""); w("#" * 74); w("# 3. 腾讯云文章 2625378")
t = fetch("https://cloud.tencent.com/developer/article/2625378", 40000)
w("  原始长度 " + str(len(t)))
import re
title = re.search(r"<title>(.*?)</title>", t, re.S)
w("  标题: " + (title.group(1).strip()[:160] if title else "?"))
body = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
body = re.sub(r"<[^>]+>", " ", body)
body = re.sub(r"\s+", " ", body)
w("  正文: " + body[:2800])

w(""); w("#" * 74); w("# 4. 知乎 p/2066564289712894830")
t = fetch("https://zhuanlan.zhihu.com/p/2066564289712894830", 40000)
w("  原始长度 " + str(len(t)))
title = re.search(r"<title>(.*?)</title>", t, re.S)
w("  标题: " + (title.group(1).strip()[:160] if title else "?"))
body = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
body = re.sub(r"<[^>]+>", " ", body); body = re.sub(r"\s+", " ", body)
w("  正文: " + body[:2500])

open(r"D:\cfb\.cfb-offline\_links2.txt", "w", encoding="utf-8").write(OUT.getvalue())
print("written", len(OUT.getvalue()))
