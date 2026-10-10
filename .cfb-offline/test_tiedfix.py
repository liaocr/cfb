# -*- coding: utf-8 -*-
"""把 train_rwkv7.py 里的 fix_tied_weight_keys 抽出来单测（本地没有 torch）。"""
import ast, types
from pathlib import Path

src = Path(r"D:\cfb\deploy\kaggle\train_rwkv7.py").read_text(encoding="utf-8")
tree = ast.parse(src)
want = {"fix_tied_weight_keys", "verify_saved_weights"}
fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in want]
assert len(fns) == 2, [n.name for n in fns]
ns = {"Path": Path}
exec(compile(ast.Module(body=fns, type_ignores=[]), "<extract>", "exec"), ns)
fix = ns["fix_tied_weight_keys"]

def tied_keys_like_transformers5(model):
    """逐字照抄 transformers 5.16.1 modeling_utils.py:377-382"""
    out = []
    for name, sub in model.named_modules():
        tied = getattr(sub, "_tied_weights_keys", {}) or {}
        out.extend([f"{name}.{k}" if name else k for k in tied.keys()])
    return out

class W:
    def __init__(self, ptr): self._p = ptr
    def data_ptr(self): return self._p

class Lin:
    def __init__(self, ptr): self.weight = W(ptr)

class Root:
    _tied_weights_keys = ["lm_head.weight"]          # fla 的写法
    def __init__(self, shared):
        self.lm_head = Lin(1)
        self.emb = Lin(1 if shared else 2)
        self._m = [("", self), ("lm_head", self.lm_head), ("model.embeddings", self.emb)]
    def named_modules(self): return iter(self._m)
    def get_output_embeddings(self): return self.lm_head
    def get_input_embeddings(self): return self.emb

# 0. 复现 v8 的崩溃
try:
    tied_keys_like_transformers5(Root(False)); raise SystemExit("FAIL 复现失败：居然没抛")
except AttributeError as e:
    assert "'list' object has no attribute 'keys'" in str(e), e

# 1. 不共享 -> {}，且 transformers 那行不再抛
m = Root(False); n, shared = fix(m)
assert shared is False and n == 1, (n, shared)
assert m._tied_weights_keys == {}
assert tied_keys_like_transformers5(m) == []

# 2. 真共享 -> 必须给映射，不能给 {}（给了会删掉 lm_head.weight）
m2 = Root(True); n2, s2 = fix(m2)
assert s2 is True and n2 == 1, (n2, s2)
assert m2._tied_weights_keys == {"lm_head.weight": "model.embeddings.weight"}
assert tied_keys_like_transformers5(m2) == ["lm_head.weight"]

# 3. 没有该属性的模型不该被写脏
class Plain:
    def named_modules(self): return iter([("", self)])
    def get_output_embeddings(self): raise AttributeError("nope")
    def get_input_embeddings(self): raise AttributeError("nope")
p = Plain(); n3, s3 = fix(p)
assert n3 == 0 and s3 is None and not hasattr(p, "_tied_weights_keys"), (n3, s3)

# 4. 已经是 dict 的原样不动
class D:
    _tied_weights_keys = {"a": "b"}
    def named_modules(self): return iter([("", self)])
    def get_output_embeddings(self): raise AttributeError("nope")
    def get_input_embeddings(self): raise AttributeError("nope")
d = D(); n4, _ = fix(d)
assert n4 == 0 and d._tied_weights_keys == {"a": "b"}, (n4, d._tied_weights_keys)

print("PASS 5/5")


# ── fixup_tokenizer_dir ──────────────────────────────────────────────
import os, shutil, tempfile
fns2 = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "fixup_tokenizer_dir"]
assert len(fns2) == 1
ns2 = {"Path": Path, "os": os, "shutil": shutil}
exec(compile(ast.Module(body=fns2, type_ignores=[]), "<extract2>", "exec"), ns2)
fixup = ns2["fixup_tokenizer_dir"]

real_vocab = Path(r"D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt")
assert real_vocab.is_file(), real_vocab

class FakeTok:
    vocab_files_names = {"vocab_file": "rwkv_vocab_v20230424.txt"}
    def __init__(self, ik): self.init_kwargs = ik

tmp = Path(tempfile.mkdtemp())
(tmp / "vocab.txt").write_text("wrong\n", encoding="utf-8")

msg = fixup(tmp, FakeTok({"vocab_file": str(real_vocab)}))
dst = tmp / "rwkv_vocab_v20230424.txt"
assert dst.is_file(), msg
assert dst.read_bytes() == real_vocab.read_bytes(), "vocab content mismatch"
assert (tmp / "vocab.txt").read_text(encoding="utf-8") == "wrong\n", "should not touch vocab.txt"
print("  fixup ok:", msg)

class NoNames(FakeTok): vocab_files_names = {}
m2 = fixup(tmp, NoNames({}))
assert "not-fixed" in m2 or "\u672a\u8865" in m2, m2
m3 = fixup(tmp, FakeTok({"vocab_file": str(tmp / "nope.txt")}))
assert "\u672a\u8865" in m3, m3
print("  edge:", m2, "|", m3)

shutil.rmtree(tmp, ignore_errors=True)
print("PASS 8/8")
