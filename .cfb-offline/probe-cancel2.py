# -*- coding: utf-8 -*-
import inspect
from kagglesdk.kernels.types import kernels_api_service as K
for name in ("ApiGetKernelSessionLogsStreamRequest", "ApiCancelKernelSessionRequest",
             "ApiGetKernelSessionStatusRequest", "ApiCancelKernelSessionResponse"):
    cls = getattr(K, name, None)
    if cls is None:
        print(name, "MISSING"); continue
    print("=====", name)
    try:
        print(inspect.getsource(cls)[:2500])
    except Exception as e:
        print("no source", repr(e), [a for a in dir(cls) if not a.startswith("_")])
