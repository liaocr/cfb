
import json, datetime
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
kid = "liaocr/cfb-rwkv7-compressor"
# 版本与运行历史
try:
    ks = api.kernels_list_with_response(user="liaocr", page_size=10)
    print("list_with_response:", json.dumps(ks.to_dict() if hasattr(ks,'to_dict') else str(ks), ensure_ascii=False, default=str)[:1200])
except Exception as e:
    print("lwr err", repr(e)[:200])
# 试着拉日志（排队时通常为空）
try:
    lg = api.kernels_logs(kid)
    print("logs len:", len(lg or ''))
    print((lg or '')[-1500:])
except Exception as e:
    print("logs err", repr(e)[:300])
