# -*- coding: utf-8 -*-
import inspect, json, sys
from kagglesdk.common.types.file_download import FileDownload
print("FileDownload attrs:", [a for a in dir(FileDownload) if not a.startswith("_")])
try:
    print(inspect.getsource(FileDownload)[:1200])
except Exception as e:
    print("nosrc", e)

from kaggle.api.kaggle_api_extended import KaggleApi
print("KaggleApi methods with 'client'/'kernel':",
      [a for a in dir(KaggleApi) if ("client" in a.lower() or "kernel" in a.lower())])
api = KaggleApi()
api.authenticate()
print("authed. attrs:", [a for a in vars(api) if "client" in a.lower() or "http" in a.lower()])
