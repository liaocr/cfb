#!/bin/sh
cd /home/user/cfb || exit 9
set -a; . /home/user/.secrets/keys.env; set +a
exec node tools/traj-run.mjs \
  --plan .cfb-runtime/traj/t17/plan.json \
  --store-text \
  --fork-from .cfb-runtime/traj/t15/results.jsonl \
  --variants raw,hand \
  --only sse-truncated:decoy \
  --samples 1 --max-rounds 7 --fork --max-tokens 8000 \
  --base-url "$DEEPSEEK_BASE_URL" --model "$DEEPSEEK_MODEL" \
  --out .cfb-runtime/traj/t17 "$@"
