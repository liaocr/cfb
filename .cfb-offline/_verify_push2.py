
# -*- coding: utf-8 -*-
import hashlib, pathlib
pushed = pathlib.Path(r"C:\Users\Liaocr\AppData\Local\Temp\cfb-rwkv7-23_5exm1\kernel.py")
pulled = pathlib.Path(r"D:\cfb\.cfb-offline\_kaggle-pull\cfb-rwkv7-compressor.py")
pb, gb = pushed.read_bytes(), pulled.read_bytes()
print("pushed bytes =", len(pb), "sha256 =", hashlib.sha256(pb).hexdigest()[:16])
print("pulled bytes =", len(gb), "sha256 =", hashlib.sha256(gb).hexdigest()[:16])
print("BYTE-IDENTICAL =", pb == gb)

# 行尾确认（上面那个 877 的差就是它）
print("pushed CRLF lines =", pb.count(b"\r\n"), " bare LF =", pb.count(b"\n") - pb.count(b"\r\n"))

t = gb.decode("utf-8")
print("--- Kaggle 上这一版是不是带着修复 ---")
for m in ["fix_tied_weight_keys", "fixup_tokenizer_dir", "verify_saved_weights",
          "datetime.timedelta(hours=3)", '"--gen-budget",\n        "3600"',
          "lm_head 与输入嵌入共享存储"]:
    print("  ", repr(m[:44]), "->", m in t)
# 旧版特征：不该再有
print("--- 旧版特征（应为 False）---")
print("   旧存档块 base_model.save_pretrained(out_dir / \"model\") ->",
      'save_pretrained(out_dir / "model")' in t)
