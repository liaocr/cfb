
import json, inspect
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
with api.build_kaggle_client() as k:
    c = k.kernels.kernels_api_client
    names = [m for m in dir(c) if not m.startswith('_')]
    print("KernelsApiClient methods:")
    for n in names:
        print("  -", n)
