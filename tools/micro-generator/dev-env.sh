#!/usr/bin/env bash
# 本地（CPU）研发环境：装到 ~/.local（不进 git、不进工作区快照）。
# 每个新会话/sandbox 重建后跑一次即可：
#   bash tools/micro-generator/dev-env.sh && eval "$(bash tools/micro-generator/dev-env.sh --print-path)"
set -euo pipefail
DEST="${CFB_PY_ENV:-$HOME/.local/py}"
TORCH_DEST="$HOME/.local/torch"
TOK_DIR="$HOME/.local/tok"
mkdir -p "$DEST" "$TOK_DIR" "$HOME/.local/pip-tmp"
export TMPDIR="$HOME/.local/pip-tmp"   # /tmp 常是小容量 tmpfs，pip 别用它

pip install --quiet --target "$DEST" tokenizers==0.23.2 numpy pyarrow
[ -d "$TORCH_DEST/torch" ] || TMPDIR="$HOME/.local/pip-tmp" pip install --quiet \
  --index-url https://download.pytorch.org/whl/cpu --target "$TORCH_DEST" torch
[ -s "$TOK_DIR/qwen3-tokenizer.json" ] || curl -sSL --fail \
  -o "$TOK_DIR/qwen3-tokenizer.json" https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/tokenizer.json

if [ "${1:-}" = "--print-path" ]; then
  echo "export PYTHONPATH=$DEST:$TORCH_DEST:\${PYTHONPATH:-}"
else
  echo "ok: $DEST + $TORCH_DEST + $TOK_DIR"
fi
