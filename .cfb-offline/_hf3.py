
import json, urllib.request, socket
socket.setdefaulttimeout(40)
B = "https://hf-mirror.com"
def get(u):
    return json.loads(urllib.request.urlopen(u).read())
def txt(u, n=1800):
    try:
        return urllib.request.urlopen(u).read().decode("utf-8", "replace")[:n]
    except Exception as e:
        return f"(失败 {type(e).__name__}: {str(e)[:70]})"

DS = ["Qyrou/reasoning-summaries-61k", "zeju-0727/SFT_cot_compression",
      "DataSeer/reasoning-summarization-training-data-21072026",
      "cot-compression/TokenComplexity", "homerquan/mn-context-compression-dataset-v1",
      "lambda/hermes-agent-reasoning-traces", "allenai/big-reasoning-traces"]
for d in DS:
    print("=" * 72); print("### " + d)
    try:
        info = get(f"{B}/api/datasets/{d}")
        sib = [s["rfilename"] for s in info.get("siblings", [])]
        print("  文件(" + str(len(sib)) + "):", sib[:14])
        print("  dl=", info.get("downloads"), "likes=", info.get("likes"), "gated=", info.get("gated"))
        print("  卡片:")
        print("   " + txt(f"{B}/datasets/{d}/resolve/main/README.md", 1300).replace("\n", "\n   ")[:1300])
    except Exception as e:
        print("  失败", type(e).__name__, str(e)[:110])

print("=" * 72); print("### 模型 XXMiner/soma-cot-compression 与 N7766 系列")
for m in ["XXMiner/soma-cot-compression", "N7766/qwen3-8b-gsm8k-cot-compression-lora-sft-stage3"]:
    try:
        info = get(f"{B}/api/models/{m}")
        print(f"  {m}: files={[s['rfilename'] for s in info.get('siblings',[])][:10]}")
        print("    tags:", info.get("tags", [])[:14])
    except Exception as e:
        print(f"  {m} 失败 {type(e).__name__}")

print("=" * 72); print("### Qwen/Qwen3.5-0.8B-Base 可用性")
try:
    info = get(f"{B}/api/models/Qwen/Qwen3.5-0.8B-Base")
    for s in info.get("siblings", []):
        print("   ", s["rfilename"])
except Exception as e:
    print("  失败", type(e).__name__, str(e)[:110])
