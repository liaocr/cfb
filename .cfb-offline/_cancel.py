
import json
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiCancelKernelSessionRequest
api = KaggleApi(); api.authenticate()
print("status before:", api.kernels_status("liaocr/cfb-rwkv7-compressor").status)
try:
    with api.build_kaggle_client() as k:
        req = ApiCancelKernelSessionRequest()
        req.user_name = "liaocr"; req.kernel_slug = "cfb-rwkv7-compressor"
        r = k.kernels.kernels_api_client.cancel_kernel_session(req)
        print("cancel ->", json.dumps(r.to_dict(), ensure_ascii=False, default=str))
except Exception as e:
    print("cancel err:", repr(e)[:300])
