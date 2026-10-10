# -*- coding: utf-8 -*-
import inspect
from kaggle.api.kaggle_api_extended import KaggleApi
for n in ("kernels_status", "kernels_logs_stream", "kernels_logs", "build_kaggle_client"):
    f = getattr(KaggleApi, n, None)
    print("=====", n, inspect.signature(f) if f else "MISSING")
    try:
        print(inspect.getsource(f)[:1800])
    except Exception as e:
        print("nosrc", e)
