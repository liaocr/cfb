
import json, inspect
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
print("kernels_push signature:", inspect.signature(KaggleApi.kernels_push))
# CLI 层有没有 --accelerator
import kaggle
from kaggle.cli import main as _m
import subprocess, sys
r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "push", "--help"],
                   capture_output=True, text=True)
print(r.stdout or r.stderr)
