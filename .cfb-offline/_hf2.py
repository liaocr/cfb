
import json, urllib.request, urllib.parse, socket
socket.setdefaulttimeout(40)
B = "https://hf-mirror.com"
def get(u, raw=False):
    r = urllib.request.urlopen(u)
    d = r.read()
    return d if raw else json.loads(d)
def txt(u, n=3000):
    try:
        return get(u, True).decode("utf-8", "replace")[:n]
    except Exception as e:
        return f"(失败 {type(e).__name__}: {str(e)[:80]})"

print("=" * 72); print("A. 数据集检索"); print("=" * 72)
for q in ["reasoning compression", "cot compression", "reasoning summarization",
          "chain of thought compression", "context compression", "reasoning traces",
          "open-thoughts", "agent trajectory compression"]:
    try:
        ds = get(f"{B}/api/datasets?search=" + urllib.parse.quote(q) + "&limit=6&sort=downloads&direction=-1")
        print(f"\n  --- 「{q}」{len(ds)} 条 ---")
        for d in ds[:6]:
            print(f"    {d['id'][:64]:66} dl={d.get('downloads',0):>9} likes={d.get('likes',0):>4}")
    except Exception as e:
        print(f"  「{q}」失败 {type(e).__name__}: {str(e)[:60]}")

print(); print("=" * 72); print("B. reasoning-summarizer-qwen3.5-0.8b-preview 详情"); print("=" * 72)
for repo in ["mithulaartigala/reasoning-summarizer-qwen3.5-0.8b-preview"]:
    try:
        info = get(f"{B}/api/models/{repo}")
        print("  files:", [s["rfilename"] for s in info.get("siblings", [])][:25])
        print("  tags:", info.get("tags", [])[:20])
        print("  downloads:", info.get("downloads"), " likes:", info.get("likes"))
        print("  --- README (前 2600 字) ---")
        print(txt(f"{B}/{repo}/resolve/main/README.md", 2600))
    except Exception as e:
        print("  失败", type(e).__name__, str(e)[:100])

print(); print("=" * 72); print("C. qilk/reasoning-compression-sft-data 详情"); print("=" * 72)
try:
    info = get(f"{B}/api/datasets/qilk/reasoning-compression-sft-data")
    print("  files:", [s["rfilename"] for s in info.get("siblings", [])][:30])
    print("  downloads:", info.get("downloads"), " likes:", info.get("likes"))
    print("  --- README (前 2000 字) ---")
    print(txt(f"{B}/datasets/qilk/reasoning-compression-sft-data/resolve/main/README.md", 2000))
except Exception as e:
    print("  失败", type(e).__name__, str(e)[:120])
