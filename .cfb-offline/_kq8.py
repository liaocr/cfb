
import json
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.kernels.types.kernels_api_service import ApiGetAcceleratorQuotaStatisticsRequest
api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    req = ApiGetAcceleratorQuotaStatisticsRequest()
    try:
        resp = k.kernels.kernels_api_client.get_accelerator_quota_statistics(req)
        d = resp.to_dict() if hasattr(resp,'to_dict') else dict(vars(resp))
        print("ACCEL QUOTA:", json.dumps(d, ensure_ascii=False, default=str, indent=1))
    except Exception as e:
        print("err:", repr(e)[:400])
