#!/bin/bash
set -e
cd "$(dirname "$0")"
echo 'reassembling model.safetensors ...'
cat model.safetensors.part_* > model.safetensors
ACTUAL=$(sha256sum model.safetensors | cut -d' ' -f1)
echo "  actual = $ACTUAL"
echo "  expect = f0258ae4cdc264ba09c42d938ff3e24bc7cf9c660d15707d4bcd414e8e6f7595"
[ "$ACTUAL" = "f0258ae4cdc264ba09c42d938ff3e24bc7cf9c660d15707d4bcd414e8e6f7595" ] && echo OK || { echo MISMATCH; exit 1; }
rm -f model.safetensors.part_*
echo 'done: model.safetensors'
