
import json, sys
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
kid = "liaocr/cfb-rwkv7-compressor"
st = api.kernels_status(kid)
d = st.to_dict() if hasattr(st, "to_dict") else dict(vars(st))
print("STATUS:", json.dumps(d, ensure_ascii=False, default=str))
# 账号级：配额与并发
try:
    q = api.get_quota()
    print("QUOTA:", json.dumps(q, ensure_ascii=False, default=str)[:2000])
except Exception as e:
    print("quota err:", repr(e))
