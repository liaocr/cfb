# -*- coding: utf-8 -*-
"""检查训练序列末尾是否把 eos 拼了两遍。

train_rwkv7.py 里：
    full = prompt + assistant + "\n\n"
    ids  = tok(full) + [eos_id]
而 tokenizer_config.json 的 eos_token 就是 "\n\n"。若 "\n\n" 编码出来就是
eos_id，那么每条训练样本末尾都会有两个 eos。
"""
import json, pathlib, sys
sys.path.insert(0, r"D:\cfb\.cfb-offline\rwkv7")
from hf_rwkv_tokenizer import RwkvTokenizer

d = pathlib.Path(r"D:\cfb\.cfb-offline\rwkv7")
tok = RwkvTokenizer(vocab_file=str(d / "rwkv_vocab_v20230424.txt"))
print("class:", type(tok).__name__)
print("vocab_size:", tok.vocab_size)
print("eos_token:", repr(tok.eos_token), "eos_token_id:", tok.eos_token_id)
print("bos_token_id:", tok.bos_token_id, "pad_token_id:", tok.pad_token_id)

for s in ["\n\n", "\n", "Assistant: ", "</think>\n\n", "abc\n\n"]:
    ids = tok(s, add_special_tokens=False)["input_ids"]
    print(f"{s!r:24} -> {ids}  (len {len(ids)})")

print()
print("末尾双 eos 检查：")
full = "Assistant: 一段压缩稿\n\n"
ids = tok(full, add_special_tokens=False)["input_ids"]
print("  tok(full)      =", ids)
print("  + [eos_id]     =", ids + [tok.eos_token_id])
print("  双 eos ？", ids[-1] == tok.eos_token_id)

print()
print("token 65530 是什么：", repr(tok.decode([65530])))
print("token 0 是什么：", repr(tok.decode([0])))
