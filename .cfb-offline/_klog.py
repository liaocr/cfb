
import json
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
kid = "liaocr/cfb-rwkv7-compressor"
st = api.kernels_status(kid)
print("STATUS:", st.status)
try:
    lg = api.kernels_logs(kid)
    print("logs chars:", len(lg or ''))
    print((lg or '')[-3000:])
except Exception as e:
    print("logs err:", repr(e)[:300])
