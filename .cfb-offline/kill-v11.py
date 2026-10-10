
# -*- coding: utf-8 -*-
"""v11 看守：一拿到 kernel_session_id 就立刻取消。

为什么不能用 kernels_status 直接取消：ApiCancelKernelSessionRequest **只认
kernel_session_id**，而排队中的内核 kernel_session_id 为空 —— 没分到机器就没有
可取消的会话。所以只能等它被调度到的那一刻再取消。
"""
import json, sys, time
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiCancelKernelSessionRequest

KID = "liaocr/cfb-rwkv7-compressor"
api = KaggleApi(); api.authenticate()
for i in range(720):          # 12 小时
    try:
        st = api.kernels_status(KID)
        s = str(st.status).split(".")[-1]
        d = st.to_dict() if hasattr(st, "to_dict") else {}
        sid = d.get("kernel_session_id")
        print(time.strftime("%H:%M:%S"), s, "session=", sid, flush=True)
        if sid:
            with api.build_kaggle_client() as k:
                req = ApiCancelKernelSessionRequest(); req.kernel_session_id = int(sid)
                r = k.kernels.kernels_api_client.cancel_kernel_session(req)
                print("CANCELLED ->", json.dumps(r.to_dict(), ensure_ascii=False, default=str), flush=True)
            break
        if s in ("COMPLETE", "ERROR", "CANCELLED", "CANCEL_ACKNOWLEDGED"):
            print("already terminal:", s, flush=True); break
    except Exception as e:
        print("err", repr(e)[:160], flush=True)
    time.sleep(60)
