
import json
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
for ref in ["liaocr/cfb-rwkv7-compressor","liaocr/notebookf317990c8f","liaocr/notebook0deb2953e7"]:
    try:
        st = api.kernels_status(ref)
        print(ref, "->", st.status, "| session:", getattr(st,'kernel_session_id',None), "| fail:", repr(getattr(st,'failure_message','')))
    except Exception as e:
        print(ref, "ERR", repr(e)[:120])
# 所有内核（含未跑过的），看有没有别的在排队/运行
try:
    ks = api.kernels_list(user="liaocr", page_size=50)
    print("total kernels:", len(ks))
except Exception as e:
    print("list err", repr(e))
