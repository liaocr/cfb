
import json, datetime
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
print("NOW(local):", datetime.datetime.now().isoformat())
print("NOW(utc)  :", datetime.datetime.utcnow().isoformat())
kid = "liaocr/cfb-rwkv7-compressor"
st = api.kernels_status(kid)
print("status type:", type(st))
try:
    print("raw:", st)
except Exception as e:
    print("raw err", e)
for attr in ('status','failure_message','failureMessage','kernel_session_id','session_id'):
    print(" ", attr, "=", getattr(st, attr, None))
# 直接看 SDK 原始响应
with api.build_kaggle_client() as k:
    from kagglesdk.kernels.types.kernels_api_service import ApiGetKernelSessionStatusRequest
    req = ApiGetKernelSessionStatusRequest()
    req.user_name = "liaocr"; req.kernel_slug = "cfb-rwkv7-compressor"
    resp = k.kernels.kernels_api_client.get_kernel_session_status(req)
    d = resp.to_dict() if hasattr(resp,'to_dict') else dict(vars(resp))
    print("SDK status:", json.dumps(d, ensure_ascii=False, default=str, indent=1))
