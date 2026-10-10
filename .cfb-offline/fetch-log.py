# -*- coding: utf-8 -*-
import json, pathlib, urllib.request, base64, sys

tok = pathlib.Path(r"C:\Users\Liaocr\.kaggle\access_token").read_text(encoding="utf-8").strip()
url = "https://www.kaggle.com/api/v1/kernels/output?userName=liaocr&kernelName=cfb-rwkv7-compressor"
req = urllib.request.Request(url)
req.add_header("Authorization", "Basic " + base64.b64encode(f"liaocr:{tok}".encode()).decode())
raw = urllib.request.urlopen(req, timeout=120).read()
d = json.loads(raw.decode("utf-8"))
print("keys:", sorted(d.keys()))
print("status:", d.get("status"))
log = d.get("log") or ""
out = pathlib.Path(r"D:\cfb\.cfb-offline\smoke2.log.txt")
out.write_text(log, encoding="utf-8")
print("log chars:", len(log))
files = d.get("files") or []
print("files:", [(f.get("fileName"), f.get("fileSize")) for f in files][:20])
