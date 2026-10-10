
import json
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiCancelKernelSessionRequest
api = KaggleApi(); api.authenticate()
KID = "liaocr/cfb-rwkv7-compressor"
st = api.kernels_status(KID)
d = st.to_dict() if hasattr(st, "to_dict") else {}
print("status:", st.status, "| session:", d.get("kernel_session_id"), "| all keys:", sorted(d.keys()))
sid = d.get("kernel_session_id")
if sid:
    with api.build_kaggle_client() as k:
        req = ApiCancelKernelSessionRequest(); req.kernel_session_id = int(sid)
        r = k.kernels.kernels_api_client.cancel_kernel_session(req)
        print("cancel ->", json.dumps(r.to_dict(), ensure_ascii=False, default=str))
else:
    print("没有 session id —— 排队中没分到机器，取消不了也不需要取消（没花 GPU）")
