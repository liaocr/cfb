
# -*- coding: utf-8 -*-
"""盯 Kaggle v10 内核直到终态，用 SSE 流拉日志。

⚠ 不要用 api.kernels_logs() / kaggle CLI logs：**对正在跑的 script kernel 返回空**
（实测 CLI rc=0 而 stdout 只有 1 个换行）。真正的日志只在
GetKernelSessionLogsStream 这条 SSE 流里，而且它每次从**头**重放，所以
每轮整体覆盖写盘即可，不需要增量拼接。
"""
import io, json, os, sys, time
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelSessionLogsStreamRequest

KID = "liaocr/cfb-rwkv7-compressor"
user, slug = KID.split("/")
OUT = r"D:\cfb\.cfb-offline\kaggle-out\v10"
os.makedirs(OUT, exist_ok=True)
LOGP = os.path.join(OUT, "watch.log")
api = KaggleApi(); api.authenticate()
TERMINAL = {"COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED", "CANCELLED"}

def w(msg):
    line = time.strftime("%H:%M:%S ") + msg
    print(line, flush=True)
    with io.open(LOGP, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def pull_log():
    buf = b""
    try:
        with api.build_kaggle_client() as k:
            req = ApiGetKernelSessionLogsStreamRequest()
            req.user_name = user; req.kernel_slug = slug
            resp = k.kernels.kernels_api_client.get_kernel_session_logs_stream(req)
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk: buf += chunk
    except Exception:  # noqa: BLE001
        pass                      # 服务端掐流是常态，拿到多少算多少
    out = []
    for raw in buf.decode("utf-8", "replace").split("\n"):
        raw = raw.strip()
        if not raw.startswith("data:"): continue
        try: out.append(json.loads(raw[5:].strip()).get("data", ""))
        except Exception: pass
    return "".join(out)

w("=== watch start ===")
last = None
for _ in range(2160):
    try:
        s = str(api.kernels_status(KID).status).split(".")[-1]
    except Exception as e:
        w("status err: %r" % (e,)); time.sleep(60); continue
    if s != last:
        w("status -> " + s); last = s
    if s == "RUNNING":
        lg = pull_log()
        if lg:
            io.open(os.path.join(OUT, "kernel.log"), "w", encoding="utf-8").write(lg)
    if s in TERMINAL:
        lg = pull_log()
        io.open(os.path.join(OUT, "kernel.log"), "w", encoding="utf-8").write(lg)
        w("=== terminal %s · kernel.log %d chars ===" % (s, len(lg)))
        w(lg[-2000:])
        break
    time.sleep(60)
