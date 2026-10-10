
import json
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import (
    ApiGetKernelSessionStatusRequest, ApiGetKernelRequest, ApiListKernelSessionOutputRequest)
api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    c = k.kernels.kernels_api_client
    # 1. 无版本号的会话状态
    r0 = ApiGetKernelSessionStatusRequest(); r0.user_name="liaocr"; r0.kernel_slug="cfb-rwkv7-compressor"
    print("status(no ver):", json.dumps(c.get_kernel_session_status(r0).to_dict(), ensure_ascii=False, default=str))
    # 2. 逐版本查
    for v in ("10","9","8"):
        try:
            rv = ApiGetKernelSessionStatusRequest(); rv.user_name="liaocr"; rv.kernel_slug="cfb-rwkv7-compressor"; rv.version_label=v
            print(f"status(v{v}):", json.dumps(c.get_kernel_session_status(rv).to_dict(), ensure_ascii=False, default=str))
        except Exception as e:
            print(f"status(v{v}) err:", repr(e)[:150])
    # 3. 内核本体
    try:
        g = ApiGetKernelRequest(); g.user_name="liaocr"; g.kernel_slug="cfb-rwkv7-compressor"
        d = c.get_kernel(g).to_dict()
        print("kernel:", json.dumps({kk:vv for kk,vv in d.items() if kk in ('id','ref','title','lastRunTime','totalVotes','language','kernelType','isPrivate','enableGpu','enableInternet','machineShape','currentVersionNumber','lastRunTime')}, ensure_ascii=False, default=str))
    except Exception as e:
        print("get_kernel err:", repr(e)[:200])
    # 4. 会话输出列表（有活跃会话时才有内容）
    try:
        o = ApiListKernelSessionOutputRequest(); o.user_name="liaocr"; o.kernel_slug="cfb-rwkv7-compressor"
        print("session output:", json.dumps(c.list_kernel_session_output(o).to_dict(), ensure_ascii=False, default=str)[:600])
    except Exception as e:
        print("session output err:", repr(e)[:200])
