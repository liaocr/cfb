
import json
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
try:
    q = api.quota_view()
    print("QUOTA:", json.dumps(q, ensure_ascii=False, default=str, indent=1)[:3000])
except Exception as e:
    print("quota_view err:", repr(e))
# 最近的内核列表（看有没有别的在占 GPU）
try:
    ks = api.kernels_list(user="liaocr", page_size=20, sort_by="dateRun")
    for k in ks:
        print(" -", getattr(k,'ref',None), "|", getattr(k,'last_run_time',None), "|", getattr(k,'status',None))
except Exception as e:
    print("list err:", repr(e))
