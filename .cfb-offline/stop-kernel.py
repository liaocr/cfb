# -*- coding: utf-8 -*-
"""抓一次实时日志，然后把这次 Kaggle session 停掉。"""
import json, pathlib, threading, time, traceback

from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiCancelKernelSessionRequest

KERNEL = "liaocr/cfb-rwkv7-compressor"
OUT = pathlib.Path(r"D:\cfb\.cfb-offline\live-stream.txt")

api = KaggleApi()
api.authenticate()

st = api.kernels_status(KERNEL)
d = st.to_dict() if hasattr(st, "to_dict") else vars(st)
print("STATUS:", json.dumps(d, ensure_ascii=False, default=str))

sid = None
for k in ("kernel_session_id", "session_id", "id"):
    v = d.get(k) if isinstance(d, dict) else None
    if isinstance(v, int) and v:
        sid = v
        break
print("session id:", sid)

# ---- 实时日志：最多看 25 秒 ----
buf = []
def pump():
    try:
        for ev in api.kernels_logs_stream(KERNEL):
            buf.append(ev)
            if len(buf) > 4000:
                break
    except Exception:
        buf.append({"data": "\n[stream error]\n" + traceback.format_exc()})

t = threading.Thread(target=pump, daemon=True)
t.start()
t.join(timeout=25)
OUT.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in buf), encoding="utf-8")
print(f"streamed {len(buf)} events -> {OUT}")

tail = "".join(e.get("data", "") for e in buf)
print("---- tail ----")
print(tail[-3000:])
print("---- /tail ----")

if sid:
    with api.build_kaggle_client() as k:
        req = ApiCancelKernelSessionRequest()
        req.kernel_session_id = sid
        try:
            resp = k.kernels.kernels_api_client.cancel_kernel_session(req)
            print("CANCEL:", json.dumps(resp.to_dict() if hasattr(resp, "to_dict") else vars(resp),
                                        ensure_ascii=False, default=str))
        except Exception:
            print("CANCEL FAILED:\n" + traceback.format_exc())
else:
    print("NO SESSION ID -> 没停成")
