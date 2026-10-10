
import inspect, json
from kaggle.api.kaggle_api_extended import KaggleApi
src = inspect.getsource(KaggleApi.kernels_push)
print(src)
