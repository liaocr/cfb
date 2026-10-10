
# -*- coding: utf-8 -*-
import hashlib, json, pathlib, re, subprocess, sys, time

loc = pathlib.Path(r"D:\cfb\deploy\kaggle\train_rwkv7.py")
pushed = pathlib.Path(r"C:\Users\Liaocr\AppData\Local\Temp\cfb-rwkv7-23_5exm1\kernel.py")
meta = pushed.parent / "kernel-metadata.json"

L = loc.read_text(encoding="utf-8")
P = pushed.read_text(encoding="utf-8")
print("local  chars =", len(L))
print("pushed chars =", len(P))

# kernel.py = local 去掉 __main__ 块 + 注入的入口
body = L[: L.index('if __name__ == "__main__":')].rstrip() + "\n"
print("pushed startswith(local body) =", P.startswith(body))
print("body chars =", len(body), " tail =", repr(P[len(body):len(body)+60]))

print("--- kernel-metadata.json ---")
print(meta.read_text(encoding="utf-8"))

print("--- git HEAD vs working tree for the trainer ---")
r = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "deploy/kaggle/train_rwkv7.py"], cwd=r"D:\cfb")
print("diff vs HEAD exit =", r.returncode, "(0 = 与已提交版本一致)")
r2 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=r"D:\cfb", capture_output=True, text=True)
print("HEAD =", r2.stdout.strip())
