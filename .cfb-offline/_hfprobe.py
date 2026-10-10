
import json, urllib.request, urllib.parse, socket, subprocess
socket.setdefaulttimeout(30)
def get(u):
    return json.load(urllib.request.urlopen(u))

print("=" * 70)
print("A. 硬件")
print("=" * 70)
try:
    out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                         capture_output=True, text=True, timeout=30)
    print("  nvidia-smi:", (out.stdout or out.stderr).strip()[:200] or "(空)")
except Exception as e:
    print("  nvidia-smi 不可用:", type(e).__name__)
import os
print("  CPU 逻辑核:", os.cpu_count())

print()
print("=" * 70)
print("B. torch / transformers 在 PyPI 上的 Windows CPU 轮子体积")
print("=" * 70)
for pkg in ["torch", "transformers", "datasets", "tokenizers", "sentencepiece", "accelerate"]:
    try:
        j = get(f"https://pypi.org/pypi/{pkg}/json")
        ver = j["info"]["version"]
        wins = [f for f in j["urls"] if f["filename"].endswith(".whl") and ("win_amd64" in f["filename"] or "py3-none-any" in f["filename"])]
        wins.sort(key=lambda f: f["size"])
        best = wins[0] if wins else None
        if best:
            print(f"  {pkg:14} {ver:12} {best['filename'][:62]:64} {best['size']/1048576:8.1f} MB")
        else:
            print(f"  {pkg:14} {ver:12} (无 win_amd64/py3-none-any 轮子)")
    except Exception as e:
        print(f"  {pkg:14} 查询失败 {type(e).__name__}")

print()
print("=" * 70)
print("C. hf-mirror 模型检索")
print("=" * 70)
for q in ["prompt compression", "context compression", "reasoning compression",
          "chain of thought compression", "llmlingua", "500xcompressor", "xrag",
          "cot compression", "reasoning summarizer", "context distillation"]:
    try:
        ms = get("https://hf-mirror.com/api/models?search=" + urllib.parse.quote(q) + "&limit=6&sort=downloads&direction=-1")
        print(f"\n  --- 「{q}」 {len(ms)} 条 ---")
        for m in ms[:6]:
            print(f"    {m['id'][:66]:68} dl={m.get('downloads',0):>9} likes={m.get('likes',0):>4}")
    except Exception as e:
        print(f"  「{q}」失败 {type(e).__name__}: {str(e)[:70]}")
