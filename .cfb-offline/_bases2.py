import urllib.request, json, os

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=60).read()

out = []
cands = {
  "gemma-3-270m-it": "https://hf-mirror.com/google/gemma-3-270m-it/resolve/main/config.json",
  "SmolLM2-360M-Instruct": "https://hf-mirror.com/HuggingFaceTB/SmolLM2-360M-Instruct/resolve/main/config.json",
  "Qwen2.5-0.5B-Instruct": "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct/resolve/main/config.json",
  "rwkv7-0.1B-g1": "https://hf-mirror.com/fla-hub/rwkv7-0.1B-g1/resolve/main/config.json",
}
for k, u in cands.items():
    try:
        c = json.loads(get(u))
        keep = {kk: c.get(kk) for kk in ["model_type","vocab_size","hidden_size","num_hidden_layers",
                "intermediate_size","num_attention_heads","num_key_value_heads","max_position_embeddings",
                "tie_word_embeddings","torch_dtype","head_dim","num_heads"] if kk in c}
        out.append("%s :: %s" % (k, json.dumps(keep, ensure_ascii=False)))
    except Exception as e:
        out.append("%s FAIL %s" % (k, e))

# PyPI availability of flash-linear-attention
for pkg in ["flash-linear-attention", "fla-core", "rwkv-fla"]:
    try:
        d = json.loads(get("https://pypi.org/pypi/%s/json" % pkg))
        v = d["info"]["version"]
        rel = d["releases"][v]
        out.append("PYPI %s latest=%s files=%d requires_python=%s" % (pkg, v, len(rel), d["info"].get("requires_python")))
    except Exception as e:
        out.append("PYPI %s FAIL %s" % (pkg, e))

# tokenizer.json sizes (proxy for vocab / multilingual coverage)
for name, u in [("gemma-3-270m-it","https://hf-mirror.com/google/gemma-3-270m-it/resolve/main/tokenizer.json"),
                ("SmolLM2-360M","https://hf-mirror.com/HuggingFaceTB/SmolLM2-360M-Instruct/resolve/main/tokenizer.json")]:
    try:
        d = get(u)
        out.append("TOK %s tokenizer.json %d bytes" % (name, len(d)))
    except Exception as e:
        out.append("TOK %s FAIL %s" % (name, e))

open(r"D:\cfb\.cfb-offline\_bases2.txt","w",encoding="utf-8").write("\n".join(out))
print("ok", len(out))
