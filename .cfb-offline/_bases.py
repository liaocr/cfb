
import json, urllib.request, socket, io
socket.setdefaulttimeout(45)
UA = {"User-Agent": "Mozilla/5.0"}
OUT = io.StringIO()
def w(*a): print(*a, file=OUT)

CANDS = [
    "Qwen/Qwen3-0.6B", "Qwen/Qwen3-0.6B-Base", "Qwen/Qwen2.5-0.5B",
    "Qwen/Qwen2.5-Coder-0.5B", "Qwen/Qwen3-1.7B", "Qwen/Qwen2.5-1.5B",
    "HuggingFaceTB/SmolLM2-360M", "HuggingFaceTB/SmolLM3-3B",
    "jingyaogong/minimind-3", "charent/ChatLM-mini-Chinese",
    "fla-hub/rwkv7-0.1B-g1", "google/gemma-3-270m-it",
    "microsoft/Phi-3-mini-4k-instruct", "unsloth/Qwen3-0.6B",
]
w(f"{'模型':52} {'下载':>10} {'likes':>6}  权重文件")
w("-" * 130)
for c in CANDS:
    try:
        j = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://hf-mirror.com/api/models/{c}", headers=UA)).read())
        sibs = j.get("siblings", [])
        wts = [s["rfilename"] for s in sibs if s["rfilename"].endswith((".safetensors", ".bin", ".gguf", ".pth"))]
        w(f"{c:52} {j.get('downloads',0):>10} {j.get('likes',0):>6}  {str(wts[:3])[:60]}")
    except Exception as e:
        w(f"{c:52} 失败 {type(e).__name__} {str(e)[:50]}")

w(""); w("=" * 74); w("ModelScope 可达性")
for u in ["https://www.modelscope.cn/api/v1/models/jingyaogong/minimind-3",
          "https://www.modelscope.cn/api/v1/models/charent/ChatLM-mini-Chinese"]:
    try:
        j = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA)).read())
        d = j.get("Data", {})
        w(f"  OK  {u.split('/models/')[1]:42} Downloads={d.get('Downloads')} License={d.get('License')}")
    except Exception as e:
        w(f"  FAIL {u[-40:]:42} {type(e).__name__} {str(e)[:50]}")

w(""); w("=" * 74); w("Kaggle 凭据/CLI")
import shutil
w("  kaggle CLI: " + str(shutil.which("kaggle")))
open(r"D:\cfb\.cfb-offline\_bases.txt","w",encoding="utf-8").write(OUT.getvalue())
print("ok")
