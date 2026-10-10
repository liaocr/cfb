
import json, inspect
import kagglesdk.kernels.types.kernels_api_service as K
for cls in ('ApiCreateKernelSessionRequest','ApiGetKernelSessionStatusRequest'):
    C = getattr(K, cls)
    print("==", cls)
    try:
        print("  fields:", json.dumps(C.__dataclass_fields__.keys().__iter__().__length_hint__() and list(C.__dataclass_fields__.keys()), ensure_ascii=False))
    except Exception as e:
        print("  fields err", e)
    print("  src:", inspect.getsource(C)[:700])
