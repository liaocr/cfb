
# -*- coding: utf-8 -*-
"""拉 Kaggle 内核日志（SSE 流）。

为什么不用 kaggle CLI / api.kernels_logs()：**它们对正在跑的 script kernel 返回空**
（实测 CLI rc=0 但 stdout 只有 1 个换行）。真正的日志在 SSE 流式接口里：
  POST /v1/kernels.KernelsApiService/GetKernelSessionLogsStream
它返回 requests.Response，逐行 'data: {json}\n\n'，从**头**开始重放。

⚠ 这条流会在服务端某一刻被掐断（urllib3 ProtocolError: Response ended prematurely）。
  那是**正常的**，不是错误 —— 拿到多少算多少。所以必须 try/except 包住迭代，
  否则一次网络抖动会把已经拿到的几万字全丢掉。
"""
import io, json, os, sys
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelSessionLogsStreamRequest

KID = sys.argv[1] if len(sys.argv) > 1 else "liaocr/cfb-rwkv7-compressor"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"D:\cfb\.cfb-offline\kaggle-out\v10\kernel.log"
user, slug = KID.split("/")

api = KaggleApi(); api.authenticate()
buf = b""
try:
    with api.build_kaggle_client() as k:
        req = ApiGetKernelSessionLogsStreamRequest()
        req.user_name = user; req.kernel_slug = slug
        resp = k.kernels.kernels_api_client.get_kernel_session_logs_stream(req)
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                buf += chunk
except Exception as exc:  # noqa: BLE001
    print("stream ended: %r（正常，拿到多少算多少）" % (type(exc).__name__,))

text = buf.decode("utf-8", "replace")
lines = []
for raw in text.split("\n"):
    raw = raw.strip()
    if not raw.startswith("data:"):
        continue
    try:
        o = json.loads(raw[5:].strip())
    except Exception:
        continue
    lines.append(o.get("data", ""))
log = "".join(lines)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8").write(log)
print("bytes=%d lines=%d -> %s" % (len(log), log.count("\n"), OUT))
print("--- tail ---")
print(log[-3500:])
