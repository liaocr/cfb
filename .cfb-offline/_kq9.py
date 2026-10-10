
import json, inspect
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    c = k.kernels.kernels_api_client
    for m in ('create_kernel_session','cancel_kernel_session','get_kernel_session_status','get_accelerator_quota_statistics'):
        f = getattr(c, m)
        try:
            print("==", m, inspect.signature(f))
        except Exception as e:
            print("==", m, "sig?", e)
        doc = (f.__doc__ or '').strip().splitlines()
        print("   doc:", " | ".join(doc[:4]))
import kagglesdk.kernels.types.kernels_api_service as K
print()
print("request classes:", [n for n in dir(K) if n.startswith('Api') and 'Request' in n])
