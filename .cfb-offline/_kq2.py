
import json
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
print("api methods with 'quota'/'kernel'/'session':")
print([m for m in dir(api) if any(k in m.lower() for k in ('quota','kernel','session','accel'))])
import kagglesdk
print("kagglesdk:", getattr(kagglesdk,'__version__','?'))
from kagglesdk import KaggleClient
with api.build_kaggle_client() as k:
    print("client attrs:", [a for a in dir(k) if not a.startswith('_')])
    print("kernels attrs:", [a for a in dir(k.kernels) if not a.startswith('_')])
