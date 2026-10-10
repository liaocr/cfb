# -*- coding: utf-8 -*-
import json, traceback
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetAcceleratorQuotaStatisticsRequest

api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    try:
        r = k.kernels.kernels_api_client.get_accelerator_quota_statistics(ApiGetAcceleratorQuotaStatisticsRequest())
        print("QUOTA:", json.dumps(r.to_dict(), ensure_ascii=False, indent=1, default=str))
    except Exception:
        print("QUOTA FAIL:\n" + traceback.format_exc())

# machine_shape 枚举
try:
    import kagglesdk.kernels.types.kernels_enums as E
    print("ENUMS:", [n for n in dir(E) if not n.startswith("_")])
    for n in dir(E):
        if "hape" in n or "Accel" in n or "Gpu" in n:
            obj = getattr(E, n)
            try:
                print(n, list(obj))
            except Exception:
                print(n, obj)
except Exception:
    print(traceback.format_exc())
