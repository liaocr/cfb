#!/usr/bin/env python3
"""任务专用微模型的统一文本格式（只有一个实现：词表训练、训练、评测三处共用）。

格式（纯文本、4 个特殊 token）：
  <|sys|>{system}
  <|user|>{user}
  <|asst|>{assistant}<|end|>

不依赖任何 chat template —— 这是任务专用模型，不是通用助手。
"""
from __future__ import annotations

SYS_OPEN = "<|sys|>"
USER_OPEN = "<|user|>"
ASST_OPEN = "<|asst|>"
END = "<|end|>"
PAD = "<|pad|>"
SPECIAL_TOKENS = [SYS_OPEN, USER_OPEN, ASST_OPEN, END, PAD]

SYSTEM = (
    "You are the CFB birth-compressor. You receive the CONTEXT visible at the moment a model "
    "produced a long reasoning block (RAW), and you output the compressed version of that block.\n"
    "Rules: keep every fact-bearing sentence verbatim — identifiers, file paths, numbers, verdict "
    "lines (test results) and commands must survive unchanged. Drop only hesitation, restatement "
    "and filler. Never invent an identifier that is not in CONTEXT or RAW. Never lose a fact."
)
USER_TMPL = "【CONTEXT】\n{ctx}\n\n【RAW】\n{raw}"


def user_text(row: dict) -> str:
    """从语料行取 user 段（与 build-teacher-corpus 写入的一致）。"""
    return row["messages"][1]["content"]


def assistant_text(row: dict) -> str:
    return row["messages"][2]["content"]


def full_text(user: str, assistant: str, system: str = SYSTEM) -> str:
    return f"{SYS_OPEN}{system}\n{USER_OPEN}{user}\n{ASST_OPEN}{assistant}{END}"


def prompt_text(user: str, system: str = SYSTEM) -> str:
    return f"{SYS_OPEN}{system}\n{USER_OPEN}{user}\n{ASST_OPEN}"


def row_to_texts(row: dict, system: str = SYSTEM):
    """返回 (prompt, full)：prompt 用于 label 掩码边界，full 用于整段训练。"""
    u, a = user_text(row), assistant_text(row)
    return prompt_text(u, system), full_text(u, a, system)
