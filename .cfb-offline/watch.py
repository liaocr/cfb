# -*- coding: utf-8 -*-
"""轮询 Kaggle 内核到终态，抓日志并转可读。用法: python watch.py <tag>"""
import json, pathlib, subprocess, sys, time

KID = "liaocr/cfb-rwkv7-compressor"
TAG = sys.argv[1] if len(sys.argv) > 1 else "run"
OUT = pathlib.Path(r"D:\cfb\.cfb-offline")

last = ""
for i in range(1080):  # 20s x 1080 = 6 小时：排队可能要等很久
    r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", KID],
                       capture_output=True, text=True)
    s = (r.stdout or "") + (r.stderr or "")
    for w in ("COMPLETE", "ERROR", "CANCEL"):
        if w in s:
            last = w
            break
    else:
        last = "RUNNING" if "RUNNING" in s else "QUEUED/?"
    print(f"[{i}] {last}", flush=True)
    if last in ("COMPLETE", "ERROR", "CANCEL"):
        break
    time.sleep(20)
print("terminal:", last, flush=True)

from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
log = api.kernels_logs(KID) or ""
(OUT / f"{TAG}.log.txt").write_text(log, encoding="utf-8")
print("log chars:", len(log), flush=True)
try:
    evs = json.loads(log)
except Exception:
    evs = None
if isinstance(evs, list):
    lines = [f"[{e.get('time')}] {e.get('stream_name','?')}: {e.get('data','').rstrip()}"
             for e in evs]
    (OUT / f"{TAG}.pretty.txt").write_text("\n".join(lines), encoding="utf-8")
    print("---- head ----"); print("\n".join(lines[:30]))
    print("---- tail ----"); print("\n".join(lines[-35:]))
else:
    print("---- raw ----"); print(log[:4000])
