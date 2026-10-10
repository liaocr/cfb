
import json, urllib.request, socket
socket.setdefaulttimeout(60)
B = "https://hf-mirror.com"
def head_lines(url, n=2, cap=250000):
    req = urllib.request.Request(url, headers={"Range": f"bytes=0-{cap}"})
    d = urllib.request.urlopen(req).read().decode("utf-8", "replace")
    out = []
    for ln in d.split("\n"):
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
        if len(out) >= n:
            break
    return out

def show(tag, url, n=2):
    print("=" * 74); print("### " + tag); print("   " + url)
    try:
        for i, o in enumerate(head_lines(url, n)):
            print(f"  --- 记录 {i}  顶层键: {list(o.keys())}")
            for k, v in o.items():
                s = json.dumps(v, ensure_ascii=False)
                print(f"      {k:22} ({len(s):>6} 字符) {s[:400]}")
    except Exception as e:
        print("   失败", type(e).__name__, str(e)[:110])

show("mn-context-compression SFT train",
     f"{B}/datasets/homerquan/mn-context-compression-dataset-v1/resolve/main/smollm3_v3_sft_train.jsonl")
show("zeju-0727 SFT_cot_compression",
     f"{B}/datasets/zeju-0727/SFT_cot_compression/resolve/main/filtered_sft_data.jsonl")
show("DataSeer reasoning-summarization",
     f"{B}/datasets/DataSeer/reasoning-summarization-training-data-21072026/resolve/main/summary_training_dataset.jsonl")

print("=" * 74); print("### homerquan/mn-context-engine-lora-v2 模型")
try:
    info = json.loads(urllib.request.urlopen(f"{B}/api/models/homerquan/mn-context-engine-lora-v2").read())
    print("  files:", [s["rfilename"] for s in info.get("siblings", [])][:14])
    print("  tags:", info.get("tags", [])[:18])
except Exception as e:
    print("  失败", type(e).__name__, str(e)[:110])
