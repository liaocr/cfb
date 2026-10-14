#!/usr/bin/env python3
"""Retired legacy Qwen/Kaggle launcher. This file is deliberately inert.

The former implementation fetched mutable GitHub main, read Kaggle credentials,
and pushed an Internet-enabled GPU kernel. That route is permanently disabled.
Use deploy/kaggle/start-rwkv7.py for the current offline-first bundle workflow;
its remote push remains separately gated and requires explicit authorization.
"""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Retired legacy Kaggle launcher (no network, credentials, install, or GPU side effects).",
        allow_abbrev=False,
    )
    parser.add_argument("--prepare-only", action="store_true", help="show the retirement notice; no bundle is created")
    parser.add_argument("--execute", action="store_true", help="disabled: this legacy push path cannot be re-enabled")
    args = parser.parse_args(argv)
    if args.execute:
        parser.error("legacy launcher retired: use start-rwkv7.py with an authorized, hash-bound bundle")
    print("Legacy Kaggle launcher retired. No credentials read; no network, installation, bundle write, kernel push, or GPU run.")
    print("Current entry: python3 deploy/kaggle/start-rwkv7.py --prepare-only (offline preparation only).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
