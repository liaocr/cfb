#!/usr/bin/env python3
"""Retired legacy Qwen/QLoRA training entrypoint; deliberately inert.

The former direct Kaggle command installed packages, cloned mutable Git refs,
and launched GPU training. Those actions are disabled here, including when this
file is piped to ``python3 -`` from an old notebook. No compatibility switch
can re-enable this entrypoint.
"""
import sys


def main() -> int:
    print(
        "Retired: deploy/kaggle/train_gen.py performs no install, network access, clone, or training.\n"
        "Do not run historical curl|python notebook cells. See the current project gates before any training."
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
