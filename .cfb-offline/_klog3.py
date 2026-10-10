
import json, sys
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelSessionLogsStreamRequest
api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    req = ApiGetKernelSessionLogsStreamRequest()
    req.user_name = "liaocr"; req.kernel_slug = "cfb-rwkv7-compressor"
    it = k.kernels.kernels_api_client.get_kernel_session_logs_stream(req)
    print("iter type:", type(it))
    n = 0
    for chunk in it:
        n += 1
        print("chunk", n, type(chunk), repr(chunk)[:300])
        if n >= 12: break
    print("total chunks seen:", n)
