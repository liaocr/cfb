
import json, urllib.request, urllib.parse, socket, io
socket.setdefaulttimeout(45)
UA = {"User-Agent": "Mozilla/5.0"}
OUT = io.StringIO()
def w(*a): print(*a, file=OUT)

CANDS = [
 "Qwen/Qwen3-0.6B", "Qwen/Qwen2.5-0.5B", "Qwen/Qwen2.5-Coder-0.5B",
 "google/gemma-3-270m-it", "google/gemma-3-270m",
 "HuggingFaceTB/SmolLM2-135M-Instruct", "HuggingFaceTB/SmolLM2-360M-Instruct",
 "jingyaogong/minimind-3", "fla-hub/rwkv7-0.1B-g1", "charent/ChatLM-mini-Chinese",
 "Qwen/Qwen3-1.7B", "Qwen/Qwen2.5-1.5B", "meta-llama/Llama-3.2-1B-Instruct",
 "allenai/OLMo-2-0425-1B", "microsoft/Phi-3.5-mini-instruct",
 "unsloth/Qwen3-0.6B", "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
]
w(f"{'模型':46} {'总参数':>13} {'词表':>8} {'层':>4} {'hidden':>7} {'FFN':>7} {'头/kv':>9} {'ctx':>7}")
w("-"*118)
for c in CANDS:
    try:
        j = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://hf-mirror.com/api/models/{c}", headers=UA)).read())
        st = (j.get("safetensors") or {}).get("total")
        cfg = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://hf-mirror.com/{c}/resolve/main/config.json", headers=UA)).read())
        w(f"{c:46} {st if st else '?':>13} {cfg.get('vocab_size','?'):>8} {cfg.get('num_hidden_layers',cfg.get('num_layers','?')):>4} "
          f"{cfg.get('hidden_size',cfg.get('d_model','?')):>7} {cfg.get('intermediate_size',cfg.get('d_ff','?')):>7} "
          f"{str(cfg.get('num_attention_heads','?'))+'/'+str(cfg.get('num_key_value_heads','?')):>9} {cfg.get('max_position_embeddings',cfg.get('n_positions','?')):>7}")
    except Exception as e:
        w(f"{c:46} 失败 {type(e).__name__} {str(e)[:40]}")

w(""); w("="*118); w("hf-mirror 搜索：0.1B~0.3B 量级（按下载量）")
for q in ["0.1B", "0.2B", "270m", "135M", "0.3B", "TinyLlama", "Qwen3-0.6B pruned"]:
    try:
        ms = json.loads(urllib.request.urlopen(urllib.request.Request(
            "https://hf-mirror.com/api/models?search=" + urllib.parse.quote(q) + "&limit=5&sort=downloads&direction=-1", headers=UA)).read())
        w(f"  --- 「{q}」 ---")
        for m in ms[:5]:
            w(f"    {m['id'][:60]:62} dl={m.get('downloads',0):>9}")
    except Exception as e:
        w(f"  「{q}」失败 {type(e).__name__}")
open(r"D:\cfb\.cfb-offline\_decide.txt","w",encoding="utf-8").write(OUT.getvalue())
print("ok")
