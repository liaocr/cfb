# -*- coding: utf-8 -*-
"""轮询 smoke v4 直到终态，然后把日志抓下来转成可读文本。"""
import json, pathlib, subprocess, sys, time

KID = "liaocr/cfb-rwkv7-compressor"
OUT = pathlib.Path(r"D:\cfb\.cfb-offline")

last = ""
for i in range(90):
    r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", KID],
                       capture_output=True, text=True)
    s = (r.stdout or "") + (r.stderr or "")
    for word in ("COMPLETE", "ERROR", "CANCEL"):
        if word in s:
            last = word
            break
    else:
        last = "RUNNING"
    print(f"[{i}] {last}", flush=True)
    if last in ("COMPLETE", "ERROR", "CANCEL"):
        break
    time.sleep(15)

print("terminal:", last, flush=True)

# 拉日志（PYTHONUTF8 由外层设置；这里直接调 SDK 更稳）
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi()
api.authenticate()
log = api.kernels_logs(KID) or ""
(OUT / "smoke4.log.txt").write_text(log, encoding="utf-8")
print("log chars:", len(log), flush=True)

# 转可读
try:
    evs = json.loads(log)
except Exception:
    evs = None
if isinstance(evs, list):
    lines = []
    for e in evs:
        t = e.get("time")
        lines.append(f"[{t}] {e.get('stream_name','?')}: {e.get('data','').rstrip()}")
    (OUT / "smoke4.pretty.txt").write_text("\n".join(lines), encoding="utf-8")
    print("pretty lines:", len(lines), flush=True)
    print("---- head ----")
    print("\n".join(lines[:32]))
    print("---- tail ----")
    print("\n".join(lines[-40:]))
else:
    print("---- raw ----")
    print(log[:4000])
