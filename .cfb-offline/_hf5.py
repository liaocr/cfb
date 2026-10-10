
import json, urllib.request, socket, random
socket.setdefaulttimeout(60)
B = "https://hf-mirror.com"
URL = f"{B}/datasets/homerquan/mn-context-compression-dataset-v1/resolve/main/smollm3_v3_sft_train.jsonl"

def rng(u, a, b):
    req = urllib.request.Request(u, headers={"Range": f"bytes={a}-{b}"})
    return urllib.request.urlopen(req).read().decode("utf-8", "replace")

print("=" * 74); print("### 在不同偏移抽样 mn-context-compression（每行 ~8KB）")
for off in [0, 2_000_000, 6_000_000, 20_000_000, 40_000_000, 60_000_000]:
    try:
        chunk = rng(URL, off, off + 20000)
        lines = [l for l in chunk.split("\n")[1:] if l.strip()]
        o = json.loads(lines[0])
        p, r = o["prompt"], o["response"]
        print(f"\n--- 偏移 {off:>11}  scenario={o.get('scenario')} target_tokens={o.get('target_tokens')} teacher={o.get('teacher_sources')}")
        print(f"    prompt 长 {len(p)}   response 长 {len(r)}")
        print("    prompt 尾部 700 字:")
        print("      " + p[-700:].replace("\n", "\n      "))
        print("    response 全文:")
        print("      " + r[:1400].replace("\n", "\n      "))
    except Exception as e:
        print(f"  偏移 {off} 失败 {type(e).__name__}: {str(e)[:90]}")
