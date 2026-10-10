
# -*- coding: utf-8 -*-
"""把 Kaggle 日志从乱码里救回来，并抽出全部配置与损失行。

日志是 JSON-lines，但 data 字段里的 UTF-8 字节被按 GBK 解过一道，
所以 "·" 变成了 "路"。修法：encode('gbk') 再 decode('utf-8')。
"""
import io, json, sys

p = r"D:\cfb\.cfb-offline\kaggle-out\v10\cfb-rwkv7-compressor.log"
raw = io.open(p, "rb").read()
txt = raw.decode("utf-8", "replace")

def fix(s):
    try:
        return s.encode("gbk", "strict").decode("utf-8", "strict")
    except Exception:
        return s

out = []
for line in txt.split("\n"):
    line = line.strip()
    if not line or line in ("[", "]"):
        continue
    if line.startswith(","):
        line = line[1:]
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("stream_name") != "stdout":
        continue
    out.append(fix(o.get("data", "")))

lines = "".join(out).split("\n")
print("总 stdout 行数:", len(lines))
print("=" * 96)
for l in lines:
    s = l.rstrip()
    if not s:
        continue
    if s.startswith("  gen "):      # 生成逐条进度，噪声，跳过
        continue
    print(s)
