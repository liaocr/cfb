
import json, sys
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelSessionLogsStreamRequest
api = KaggleApi(); api.authenticate()
kid = "liaocr/cfb-rwkv7-compressor"
# 1) CLI 原样
import subprocess
r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "logs", kid],
                   capture_output=True, text=True, encoding="utf-8")
print("CLI rc=%s stdout=%d stderr=%d" % (r.returncode, len(r.stdout or ""), len(r.stderr or "")))
print("--- stdout tail ---"); print((r.stdout or "")[-3000:])
print("--- stderr tail ---"); print((r.stderr or "")[-1500:])
# 2) 流式接口
try:
    with api.build_kaggle_client() as k:
        req = ApiGetKernelSessionLogsStreamRequest()
        req.user_name = "liaocr"; req.kernel_slug = "cfb-rwkv7-compressor"
        it = k.kernels.kernels_api_client.get_kernel_session_logs_stream(req)
        n = 0; buf = []
        for chunk in it:
            n += 1
            d = chunk.to_dict() if hasattr(chunk, "to_dict") else dict(vars(chunk))
            buf.append(json.dumps(d, ensure_ascii=False, default=str))
            if n >= 200: break
        print("stream chunks:", n)
        print("\n".join(buf[-40:])[-4000:])
except Exception as e:
    print("stream err:", repr(e)[:400])
