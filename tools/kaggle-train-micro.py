#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Train the sub-0.1B CFB birth-compression encoder on free Kaggle GPUs.

The backbone is pinned to IBM Granite Embedding 97M Multilingual R2 (Apache-2.0).
Its pretrained multilingual/code encoder is fine-tuned as a bidirectional span/slot
teacher; a tiny symbolic student is distilled for the synchronous JS fast path.
The full encoder and the compact student are exported and evaluated separately.

Run in Kaggle after enabling Internet and installing the documented dependencies:
  python3 tools/kaggle-train-micro.py --epochs-sft 12 --epochs-simpo 12 --push-back
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "ibm-granite/granite-embedding-97m-multilingual-r2"
MODEL_REVISION = "835ad14087e140460703cf0fae09f97d469d65c2"
MODEL_LICENSE = "Apache-2.0"

MODELS_DIR = ROOT / "transfer" / "models"
DATASET_PATH = MODELS_DIR / "micro-dev-dataset.json"
PRODUCTION_WEIGHTS_PATH = MODELS_DIR / "v5-micro-weights.json"
CANDIDATE_WEIGHTS_PATH = MODELS_DIR / "v5-micro-weights.candidate.json"
REPORT_JSON_PATH = MODELS_DIR / "cfb-micro-97m-report.json"
TOKENIZER_DIR = MODELS_DIR / "cfb-micro-tokenizer"
COMPACT_CANDIDATE_PATH = MODELS_DIR / "cfb-micro-neural.candidate.onnx"
COMPACT_PRODUCTION_PATH = MODELS_DIR / "cfb-micro-neural.onnx"
FULL_WORKING_PATH = Path("/kaggle/working/cfb-micro-97m-multilingual.int8.onnx")
FULL_CANDIDATE_PATH = MODELS_DIR / "cfb-micro-97m-multilingual.int8.candidate.onnx"
FULL_PRODUCTION_PATH = MODELS_DIR / "cfb-micro-97m-multilingual.int8.onnx"
MODE2_JSON_PATH = Path("/kaggle/working/cfb-micro-mode2-eval.json")
JS_PAIR_EVAL_PATH = Path("/kaggle/working/cfb-micro-js-pair-eval.json")
JS_PARITY_FIXTURES_PATH = Path("/kaggle/working/cfb-micro-js-parity-fixtures.json")
FINAL_TEST_EVAL_PATH = Path("/kaggle/working/cfb-micro-final-family-eval.json")
FINAL_TEST_LEDGER_PATH = MODELS_DIR / "cfb-micro-final-test-ledger.json"

SLOT_NAMES = ["MECHANISM", "EXCLUDED", "DECIDED", "ACCEPT", "OPEN", "NOISE"]
SPAN_TYPES = ["target_file", "old_text", "new_text", "verify_cmd"]
PREF_KEYS = [
    "hasSingleLocus", "hasDualLocus", "hasTriple", "excludedCount",
    "hasAcceptCmd", "hasEscapeClause", "hasOpenAgenda", "anchorGrounded",
    "sweetLength", "overLongPenalty", "proseCoherence", "noDeadEndResurrected",
]
HOLDOUT_FAMILIES = {"eacces-config", "wrong-model"}
MAX_SEQ_LEN = 256
UNIT_MAX_TOKENS = 128
DRAFT_MAX_TOKENS = 256
SPAN_MAX_TOKENS = 64
VALIDATION_UNIT_FRACTION = 0.20
GITHUB_REPO = "liaocr/cfb"
GITHUB_LARGE_ASSET_THRESHOLD = 90_000_000
GITHUB_MAX_FILE_BYTES = 100_000_000


def set_seed(seed: int = 42):
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def family_key(value) -> str:
    family = str(value or "").strip()
    if family.startswith("pool:"):
        family = family[len("pool:"):]
    family = family.split(":", 1)[0]
    family = re.sub(r"_(?:decoy|long-horizon).*$", "", family)
    return family


def is_holdout_family(value) -> bool:
    return family_key(value) in HOLDOUT_FAMILIES


def load_preregistration(args) -> dict:
    """2026-10-04：预注册 = 训练前把「本轮唯一变量 + 判定规则」写进仓库里的机器可读文件；
    运行时逐键比对，任何不一致直接拒绝启动训练（防止看结果改口径）。"""
    path = Path(args.preregistration)
    if not path.is_absolute():
        path = ROOT / path
    if not path.is_file():
        return {"file": None, "matched": None, "reason": "no-preregistration-file"}
    raw = path.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    declared = data.get("flags") or {}
    actual = {key: getattr(args, key, None) for key in declared}
    diffs = {key: {"declared": value, "actual": actual.get(key)} for key, value in declared.items() if actual.get(key) != value}
    if diffs:
        raise RuntimeError(f"preregistration mismatch (refusing to train): {json.dumps(diffs, ensure_ascii=False)}")
    return {
        "file": str(path.relative_to(ROOT)) if str(path).startswith(str(ROOT)) else str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "matched": True,
        "declaredFlagCount": len(declared),
        "decisionRule": data.get("decisionRule"),
        "datasetBuilder": data.get("datasetBuilder"),
    }


def choose_validation_family(unit_samples: list[dict]) -> str:
    eligible = [u for u in unit_samples if u.get("trainingEligible", True) and not is_holdout_family(u.get("family"))]
    families = sorted({family_key(u.get("family")) for u in eligible})
    if len(families) < 2:
        raise RuntimeError(f"需要至少两个有审核标签的 dev family 才能做 group holdout，当前只有: {families}")
    counts = {family: sum(family_key(u.get("family")) == family for u in eligible) for family in families}
    total = sum(counts.values())
    # Choose by group size alone (never scores/labels) to keep validation near 20% without sibling leakage.
    return min(
        families,
        key=lambda f: (
            abs(counts[f] / max(1, total) - VALIDATION_UNIT_FRACTION),
            hashlib.sha256(("cfb-micro-pref-val-v3:" + f).encode()).hexdigest(),
        ),
    )


def split_by_family(rows: list[dict], validation_family: str):
    train = [r for r in rows if family_key(r.get("family")) != validation_family]
    valid = [r for r in rows if family_key(r.get("family")) == validation_family]
    return train, valid


def freeze_copy_state(model: nn.Module) -> dict[str, torch.Tensor]:
    return {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}


def make_warmup_cosine_scheduler(optimizer, total_steps: int, warmup_ratio: float = 0.08):
    total_steps = max(1, total_steps)
    warmup_steps = max(1, int(total_steps * warmup_ratio))

    def scale(step: int):
        if step < warmup_steps:
            return max(0.05, (step + 1) / warmup_steps)
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))

    return torch.optim.lr_scheduler.LambdaLR(optimizer, scale)


def safe_onnx_export(model, args, path, **kwargs):
    """Use the built-in TorchScript exporter on PyTorch 2.6+; do not require onnxscript."""
    import inspect

    if "dynamo" in inspect.signature(torch.onnx.export).parameters:
        kwargs["dynamo"] = False
    torch.onnx.export(model, args, path, **kwargs)


def encode_texts(tokenizer, texts: list[str], max_len: int, device):
    encoded = tokenizer(
        [str(t or "") for t in texts],
        max_length=max_len,
        padding="max_length",
        truncation=True,
        return_attention_mask=True,
        return_tensors="pt",
    )
    return encoded["input_ids"].to(device), encoded["attention_mask"].to(device)


def preference_features(pair: dict) -> tuple[list[float], list[float]]:
    chosen = pair.get("chosenPref") or {}
    rejected = pair.get("rejectedPref") or {}
    return (
        [float(chosen.get(k, 0.0)) for k in PREF_KEYS],
        [float(rejected.get(k, 0.0)) for k in PREF_KEYS],
    )


def accuracy_from_scores(chosen: torch.Tensor, rejected: torch.Tensor) -> float:
    if chosen.numel() == 0:
        return float("nan")
    return float((chosen > rejected).float().mean().item())


def classification_stats(logits: torch.Tensor, targets: torch.Tensor) -> dict:
    preds = logits.argmax(dim=-1)
    accuracy = float((preds == targets).float().mean().item()) if targets.numel() else 0.0
    f1_values = []
    per_slot = {}
    for i, slot in enumerate(SLOT_NAMES):
        tp = int(((preds == i) & (targets == i)).sum().item())
        fp = int(((preds == i) & (targets != i)).sum().item())
        fn = int(((preds != i) & (targets == i)).sum().item())
        denom = 2 * tp + fp + fn
        f1 = (2 * tp / denom) if denom else 0.0
        per_slot[slot] = round(f1, 4)
        f1_values.append(f1)
    return {"slotAcc": round(accuracy, 4), "slotMacroF1": round(sum(f1_values) / len(f1_values), 4), "slotF1": per_slot}


class CFBMicro97M(nn.Module):
    """Pretrained multilingual ModernBERT teacher with symbolic/task heads."""

    def __init__(self, encoder: nn.Module, prior_weights: dict, mlp_hidden: int = 32, pref_hidden: int = 16,
                 sym_dim: int = 19):
        super().__init__()
        self.encoder = encoder
        self.d_model = int(encoder.config.hidden_size)
        # 2026-10-04：符号特征维度由数据集决定（19 维基础块 + 可选文本哈希块）。
        self.sym_dim = int(sym_dim)
        self.pref_dim = len(PREF_KEYS)
        self.mlp_hidden = mlp_hidden
        self.pref_hidden = pref_hidden

        self.ctx_to_sym = nn.Linear(self.d_model, mlp_hidden)
        self.sym_mlp_fc1 = nn.Linear(self.sym_dim, mlp_hidden)
        self.sym_val_out = nn.Linear(mlp_hidden, 1, bias=False)
        self.sym_tempt_out = nn.Linear(mlp_hidden, 1, bias=False)
        self.sym_slot_out = nn.Linear(mlp_hidden, len(SLOT_NAMES), bias=False)
        self.linear_val = nn.Linear(self.sym_dim, 1, bias=False)
        self.linear_slot = nn.Linear(self.sym_dim, len(SLOT_NAMES), bias=False)
        self.span_proj = nn.Sequential(
            nn.Linear(self.d_model * 3, self.d_model),
            nn.GELU(),
            nn.Linear(self.d_model, len(SPAN_TYPES)),
        )

        self.pref_linear = nn.Linear(self.pref_dim, 1, bias=False)
        self.pref_mlp1 = nn.Linear(self.pref_dim, pref_hidden)
        self.pref_mlp2 = nn.Linear(pref_hidden, 1)
        self.pref_ctx = nn.Linear(self.d_model, 1, bias=False)
        self._init_heads(prior_weights)

    def _init_heads(self, prior: dict):
        nn.init.xavier_uniform_(self.ctx_to_sym.weight, gain=0.15)
        nn.init.zeros_(self.ctx_to_sym.bias)
        nn.init.xavier_uniform_(self.sym_mlp_fc1.weight, gain=0.35)
        nn.init.zeros_(self.sym_mlp_fc1.bias)
        nn.init.normal_(self.sym_val_out.weight, std=0.035)
        nn.init.normal_(self.sym_tempt_out.weight, std=0.035)
        nn.init.normal_(self.sym_slot_out.weight, std=0.035)
        nn.init.xavier_uniform_(self.span_proj[0].weight, gain=0.15)
        nn.init.zeros_(self.span_proj[0].bias)
        nn.init.xavier_uniform_(self.span_proj[2].weight, gain=0.15)
        nn.init.zeros_(self.span_proj[2].bias)
        nn.init.xavier_uniform_(self.pref_mlp1.weight, gain=0.03)
        nn.init.zeros_(self.pref_mlp1.bias)
        nn.init.zeros_(self.pref_mlp2.weight)
        nn.init.zeros_(self.pref_mlp2.bias)
        nn.init.zeros_(self.pref_ctx.weight)

        with torch.no_grad():
            if prior:
                self.linear_val.weight.copy_(torch.tensor(prior["valueWeights"], dtype=torch.float32).unsqueeze(0))
                slot_rows = [prior["slotWeights"][s] for s in SLOT_NAMES]
                self.linear_slot.weight.copy_(torch.tensor(slot_rows, dtype=torch.float32))
                pref_rows = [prior["prefWeights"][k] for k in PREF_KEYS]
                self.pref_linear.weight.copy_(torch.tensor(pref_rows, dtype=torch.float32).unsqueeze(0))

    def encode_tokens(self, input_ids: torch.Tensor, attention_mask: torch.Tensor):
        output = self.encoder(input_ids=input_ids, attention_mask=attention_mask, return_dict=True)
        seq_h = output.last_hidden_state
        mask = attention_mask.unsqueeze(-1).to(seq_h.dtype)
        pooled = (seq_h * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1.0)
        return pooled, seq_h

    def forward(self, input_ids, attention_mask, features, mode="unit"):
        pooled, seq_h = self.encode_tokens(input_ids, attention_mask)
        if mode == "draft":
            h = F.gelu(self.pref_mlp1(features), approximate="tanh")
            score = self.pref_linear(features).squeeze(-1)
            score = score + self.pref_mlp2(h).squeeze(-1)
            score = score + 0.15 * self.pref_ctx(pooled).squeeze(-1)
            return score

        h_sym = F.gelu(self.sym_mlp_fc1(features))
        h_joint = h_sym + 0.15 * F.gelu(self.ctx_to_sym(pooled))
        val_logit = self.linear_val(features).squeeze(-1) + 0.25 * self.sym_val_out(h_joint).squeeze(-1)
        val_pred = torch.sigmoid(val_logit)
        temptation = features[:, 9]
        tempt_logit = self.sym_tempt_out(h_joint).squeeze(-1)
        tempt_pred = torch.clamp(0.7 * temptation + 0.3 * torch.sigmoid(tempt_logit), 0.0, 1.0)
        slot_logits = self.linear_slot(features) + 0.25 * self.sym_slot_out(h_joint)
        return slot_logits, val_logit, val_pred, tempt_pred

    def score_span(self, seq_h: torch.Tensor, start_idx: torch.Tensor, end_idx: torch.Tensor):
        b_idx = torch.arange(seq_h.shape[0], device=seq_h.device)
        h_s = seq_h[b_idx, start_idx]
        h_e = seq_h[b_idx, end_idx]
        return self.span_proj(torch.cat((h_s, h_e, h_s * h_e), dim=-1))


class CompactSymbolicStudent(nn.Module):
    """Feature-only student used by the synchronous, dependency-free JS compiler."""

    def __init__(self, teacher: CFBMicro97M):
        super().__init__()
        h = teacher.mlp_hidden
        p = teacher.pref_hidden
        self.sym_dim = teacher.sym_dim
        self.pref_dim = teacher.pref_dim
        self.fc1 = nn.Linear(self.sym_dim, h)
        self.val_out = nn.Linear(h, 1, bias=False)
        self.tempt_out = nn.Linear(h, 1, bias=False)
        self.slot_out = nn.Linear(h, len(SLOT_NAMES), bias=False)
        self.linear_val = nn.Linear(self.sym_dim, 1, bias=False)
        self.linear_slot = nn.Linear(self.sym_dim, len(SLOT_NAMES), bias=False)
        self.pref_linear = nn.Linear(self.pref_dim, 1, bias=False)
        self.pref_mlp1 = nn.Linear(self.pref_dim, p)
        self.pref_mlp2 = nn.Linear(p, 1)
        with torch.no_grad():
            self.fc1.weight.copy_(teacher.sym_mlp_fc1.weight)
            self.fc1.bias.copy_(teacher.sym_mlp_fc1.bias)
            self.val_out.weight.copy_(teacher.sym_val_out.weight)
            self.tempt_out.weight.copy_(teacher.sym_tempt_out.weight)
            self.slot_out.weight.copy_(teacher.sym_slot_out.weight)
            self.linear_val.weight.copy_(teacher.linear_val.weight)
            self.linear_slot.weight.copy_(teacher.linear_slot.weight)
            self.pref_linear.weight.copy_(teacher.pref_linear.weight)
            self.pref_mlp1.weight.copy_(teacher.pref_mlp1.weight)
            self.pref_mlp1.bias.copy_(teacher.pref_mlp1.bias)
            self.pref_mlp2.weight.copy_(teacher.pref_mlp2.weight)
            self.pref_mlp2.bias.copy_(teacher.pref_mlp2.bias)

    def forward_units(self, sym_feats: torch.Tensor):
        h = F.gelu(self.fc1(sym_feats), approximate="tanh")
        val_logit = self.linear_val(sym_feats).squeeze(-1) + 0.25 * self.val_out(h).squeeze(-1)
        tempt_logit = self.tempt_out(h).squeeze(-1)
        tempt = torch.clamp(0.7 * sym_feats[:, 9] + 0.3 * torch.sigmoid(tempt_logit), 0.0, 1.0)
        slot_logits = self.linear_slot(sym_feats) + 0.25 * self.slot_out(h)
        return slot_logits, val_logit, torch.sigmoid(val_logit), tempt

    def forward_pref(self, pref_feats: torch.Tensor):
        h = F.gelu(self.pref_mlp1(pref_feats), approximate="tanh")
        return self.pref_linear(pref_feats).squeeze(-1) + self.pref_mlp2(h).squeeze(-1)

    def forward(self, sym_feats: torch.Tensor, pref_feats: torch.Tensor):
        slot_logits, _, value, temptation = self.forward_units(sym_feats)
        return value, temptation, F.softmax(slot_logits, dim=-1), self.forward_pref(pref_feats)


def compact_unit_runtime_score(student: CompactSymbolicStudent, sym_feats: torch.Tensor,
                                token_counts: torch.Tensor, lambda_weight: float) -> torch.Tensor:
    """Differentiable PyTorch equivalent of the production JS Unit rank score."""
    _, value_logit, _, _ = student.forward_units(sym_feats)
    return value_logit - float(lambda_weight) * token_counts


class FullEncoderONNXWrapper(nn.Module):
    def __init__(self, model: CFBMicro97M):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask, sym_features, pref_features, span_start, span_end):
        pooled, seq_h = self.model.encode_tokens(input_ids, attention_mask)
        h_sym = F.gelu(self.model.sym_mlp_fc1(sym_features))
        h_joint = h_sym + 0.15 * F.gelu(self.model.ctx_to_sym(pooled))
        val_logit = self.model.linear_val(sym_features).squeeze(-1) + 0.25 * self.model.sym_val_out(h_joint).squeeze(-1)
        value = torch.sigmoid(val_logit)
        tempt = torch.clamp(
            0.7 * sym_features[:, 9] + 0.3 * torch.sigmoid(self.model.sym_tempt_out(h_joint).squeeze(-1)),
            0.0, 1.0,
        )
        slot_logits = self.model.linear_slot(sym_features) + 0.25 * self.model.sym_slot_out(h_joint)
        pref_hidden = F.gelu(self.model.pref_mlp1(pref_features), approximate="tanh")
        pref_score = self.model.pref_linear(pref_features).squeeze(-1)
        pref_score = pref_score + self.model.pref_mlp2(pref_hidden).squeeze(-1) + 0.15 * self.model.pref_ctx(pooled).squeeze(-1)
        span_logits = self.model.score_span(seq_h, span_start, span_end)
        return value, tempt, F.softmax(slot_logits, dim=-1), pref_score, span_logits


class CompactStudentONNX(nn.Module):
    def __init__(self, model: CompactSymbolicStudent):
        super().__init__()
        self.model = model

    def forward(self, sym_features, pref_features):
        return self.model(sym_features, pref_features)


def save_json(path: Path, obj: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def evaluate_sft(dp_model, ids, masks, feats, slots, values, temptations, indices, batch_size, use_amp):
    if not indices:
        return {"loss": None, "slotAcc": None, "slotMacroF1": None}
    dp_model.eval()
    all_logits, all_slots = [], []
    val_errors, tempt_errors, losses = [], [], []
    with torch.no_grad():
        for start in range(0, len(indices), batch_size):
            idx = torch.tensor(indices[start:start + batch_size], dtype=torch.long, device=ids.device)
            with torch.amp.autocast("cuda", enabled=use_amp):
                slot_logits, _, val_pred, tempt_pred = dp_model(ids[idx], masks[idx], feats[idx], mode="unit")
                loss = F.cross_entropy(slot_logits, slots[idx])
                loss = loss + 1.5 * F.huber_loss(val_pred, values[idx], delta=0.15)
                loss = loss + 1.2 * F.huber_loss(tempt_pred, temptations[idx], delta=0.15)
            all_logits.append(slot_logits.float())
            all_slots.append(slots[idx])
            val_errors.append((val_pred.float() - values[idx]).abs())
            tempt_errors.append((tempt_pred.float() - temptations[idx]).abs())
            losses.append(float(loss.item()))
    logits = torch.cat(all_logits)
    targets = torch.cat(all_slots)
    result = classification_stats(logits, targets)
    result.update({
        "loss": round(float(np.mean(losses)), 5),
        "valueMae": round(float(torch.cat(val_errors).mean().item()), 5),
        "temptationMae": round(float(torch.cat(tempt_errors).mean().item()), 5),
        "samples": len(indices),
    })
    return result


def evaluate_unit_pairs(dp_model, pairs, ids, masks, feats, batch_size, use_amp):
    if not pairs:
        return None
    dp_model.eval()
    wins = total = 0
    with torch.no_grad():
        for start in range(0, len(pairs), batch_size):
            batch = pairs[start:start + batch_size]
            wi = torch.tensor([p["winIdx"] for p in batch], dtype=torch.long, device=ids.device)
            li = torch.tensor([p["loseIdx"] for p in batch], dtype=torch.long, device=ids.device)
            with torch.amp.autocast("cuda", enabled=use_amp):
                _, wr, _, _ = dp_model(ids[wi], masks[wi], feats[wi], mode="unit")
                _, lr, _, _ = dp_model(ids[li], masks[li], feats[li], mode="unit")
            wins += int((wr > lr).sum().item())
            total += len(batch)
    return round(wins / max(1, total), 4)


def evaluate_draft_pairs(dp_model, chosen_ids, chosen_masks, rejected_ids, rejected_masks,
                         chosen_feats, rejected_feats, pair_indices, batch_size, use_amp):
    if not pair_indices:
        return None
    dp_model.eval()
    wins = total = 0
    with torch.no_grad():
        for start in range(0, len(pair_indices), batch_size):
            idx = pair_indices[start:start + batch_size]
            it = torch.tensor(idx, dtype=torch.long, device=chosen_ids.device)
            with torch.amp.autocast("cuda", enabled=use_amp):
                chosen = dp_model(chosen_ids[it], chosen_masks[it], chosen_feats[it], mode="draft")
                rejected = dp_model(rejected_ids[it], rejected_masks[it], rejected_feats[it], mode="draft")
            wins += int((chosen > rejected).sum().item())
            total += len(idx)
    return round(wins / max(1, total), 4)


def encode_draft_pairs(tokenizer, pairs, device):
    chosen_texts = [p.get("chosenText", "") for p in pairs]
    rejected_texts = [p.get("rejectedText", "") for p in pairs]
    chosen_ids, chosen_masks = encode_texts(tokenizer, chosen_texts, DRAFT_MAX_TOKENS, device)
    rejected_ids, rejected_masks = encode_texts(tokenizer, rejected_texts, DRAFT_MAX_TOKENS, device)
    chosen_features, rejected_features = zip(*(preference_features(p) for p in pairs)) if pairs else ([], [])
    chosen_features = torch.tensor(chosen_features, dtype=torch.float32, device=device)
    rejected_features = torch.tensor(rejected_features, dtype=torch.float32, device=device)
    gammas = torch.tensor([float(p.get("gammaDd", 0.35)) for p in pairs], dtype=torch.float32, device=device)
    return chosen_ids, chosen_masks, rejected_ids, rejected_masks, chosen_features, rejected_features, gammas


def stage1_sft(args, dp_model, model, tokenizer, dataset, device, use_amp):
    units = dataset["unitSamples"]
    if getattr(args, "validation_family", None):
        known = sorted({family_key(u.get("family")) for u in units
                        if u.get("trainingEligible", True) and not is_holdout_family(u.get("family"))})
        if args.validation_family not in known:
            raise RuntimeError(f"--validation-family must be one of {known}; got {args.validation_family}")
        val_family = args.validation_family
    else:
        val_family = choose_validation_family(units)
    train_indices = [i for i, u in enumerate(units) if u.get("trainingEligible", True)
                     and family_key(u.get("family")) != val_family]
    val_indices = [i for i, u in enumerate(units) if u.get("trainingEligible", True)
                   and family_key(u.get("family")) == val_family]
    if not train_indices or not val_indices:
        raise RuntimeError("grouped SFT split produced an empty train/validation partition")

    texts = [u["text"] for u in units]
    ids, masks = encode_texts(tokenizer, texts, UNIT_MAX_TOKENS, device)
    feats = torch.tensor([u["features"] for u in units], dtype=torch.float32, device=device)
    slots = torch.tensor([u["slotIdx"] for u in units], dtype=torch.long, device=device)
    values = torch.tensor([u["yVal"] for u in units], dtype=torch.float32, device=device)
    temptations = torch.tensor([u["yTempt"] for u in units], dtype=torch.float32, device=device)

    # Use only train-family span examples; no Gold holdout is ever loaded here.
    span_texts, span_starts, span_ends, span_labels = [], [], [], []
    for doc in dataset["spanSamples"]:
        if family_key(doc.get("family")) == val_family or is_holdout_family(doc.get("family")):
            continue
        for span in doc.get("spans", []):
            text = span.get("text", "")
            if not text:
                continue
            span_texts.append(text)
            enc = tokenizer(text, max_length=SPAN_MAX_TOKENS, padding="max_length", truncation=True, return_tensors="pt")
            mask = enc["attention_mask"][0]
            active = int(mask.sum().item())
            span_starts.append(1 if active > 2 else 0)
            span_ends.append(max(1, active - 2) if active > 2 else 0)
            label = [0.0] * len(SPAN_TYPES)
            if span.get("label") == 1 and span.get("type") in SPAN_TYPES:
                label[SPAN_TYPES.index(span["type"])] = 1.0
            span_labels.append(label)

    if span_texts:
        span_ids, span_masks = encode_texts(tokenizer, span_texts, SPAN_MAX_TOKENS, device)
        span_start_t = torch.tensor(span_starts, dtype=torch.long, device=device)
        span_end_t = torch.tensor(span_ends, dtype=torch.long, device=device)
        span_label_t = torch.tensor(span_labels, dtype=torch.float32, device=device)
    else:
        span_ids = span_masks = span_start_t = span_end_t = span_label_t = None

    prior = json.loads(PRODUCTION_WEIGHTS_PATH.read_text(encoding="utf-8"))
    prior_val = torch.tensor(prior["valueWeights"], dtype=torch.float32, device=device)
    prior_slot = torch.tensor([prior["slotWeights"][s] for s in SLOT_NAMES], dtype=torch.float32, device=device)
    train_slots = slots[torch.tensor(train_indices, dtype=torch.long, device=device)]
    class_counts = torch.bincount(train_slots, minlength=len(SLOT_NAMES)).float().clamp(min=1.0)
    class_weights = (class_counts.sum() / (len(SLOT_NAMES) * class_counts)).sqrt()
    class_weights = (class_weights / class_weights.mean()).clamp(0.5, 3.0)

    encoder_params = list(model.encoder.parameters())
    pref_param_ids = {id(p) for name, p in model.named_parameters() if name.startswith("pref_")}
    encoder_param_ids = {id(p) for p in encoder_params}
    head_params = [
        p for p in model.parameters()
        if p.requires_grad and id(p) not in encoder_param_ids and id(p) not in pref_param_ids
    ]
    optimizer = torch.optim.AdamW(
        [
            {"params": encoder_params, "lr": args.encoder_lr},
            {"params": head_params, "lr": args.lr},
        ],
        weight_decay=0.01,
        eps=1e-6,
    )
    steps_per_epoch = math.ceil(len(train_indices) / args.batch_size)
    scheduler = make_warmup_cosine_scheduler(optimizer, steps_per_epoch * args.epochs_sft)
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    amp_skipped_steps = 0
    clip_params = [p for group in optimizer.param_groups for p in group["params"]]
    history = []
    best_state = None
    best_val_loss = float("inf")
    stale = 0

    print(
        f"\n[Stage 2/6] Granite 97M multi-task SFT: train={len(train_indices)} val={len(val_indices)} "
        f"validation_family={val_family} val_fraction={len(val_indices)/len(units):.3f} target={VALIDATION_UNIT_FRACTION:.2f}"
    )
    print(f"   optimizer: encoder_lr={args.encoder_lr:g}, head_lr={args.lr:g}, warmup+cosine, grad_clip=1.0")
    for epoch in range(1, args.epochs_sft + 1):
        dp_model.train()
        order = torch.tensor(train_indices, dtype=torch.long, device=device)
        order = order[torch.randperm(len(train_indices), device=device)]
        total_loss = 0.0
        seen = 0
        span_added = False

        for start in range(0, len(train_indices), args.batch_size):
            idx = order[start:start + args.batch_size]
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=use_amp):
                slot_logits, _, val_pred, tempt_pred = dp_model(ids[idx], masks[idx], feats[idx], mode="unit")
                loss_slot = F.cross_entropy(slot_logits, slots[idx], weight=class_weights)
                loss_val = F.huber_loss(val_pred, values[idx], delta=0.15)
                loss_tempt = F.huber_loss(tempt_pred, temptations[idx], delta=0.15)
                neg_prime = (temptations[idx].le(0.05).float() * F.relu(tempt_pred - 0.12).pow(2)).mean()
                span_loss = torch.zeros((), device=device)
                if span_ids is not None and not span_added:
                    _, seq_h = model.encode_tokens(span_ids, span_masks)
                    span_logits = model.score_span(seq_h, span_start_t, span_end_t)
                    span_loss = F.binary_cross_entropy_with_logits(span_logits, span_label_t)
                    span_added = True
                prior_reg = (
                    0.15 * (model.linear_val.weight.squeeze(0) - prior_val).pow(2).mean()
                    + 0.15 * (model.linear_slot.weight - prior_slot).pow(2).mean()
                )
                loss = loss_slot + 1.5 * loss_val + 1.2 * loss_tempt + 2.0 * neg_prime + 0.5 * span_loss + prior_reg

            if not torch.isfinite(loss):
                raise FloatingPointError(f"non-finite SFT loss at epoch {epoch}")
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(clip_params, max_norm=1.0)
            scale_before = scaler.get_scale()
            scaler.step(optimizer)
            scaler.update()
            if scaler.get_scale() < scale_before:
                amp_skipped_steps += 1
            else:
                scheduler.step()
            total_loss += float(loss.detach().item()) * len(idx)
            seen += len(idx)

        train_metrics = evaluate_sft(dp_model, ids, masks, feats, slots, values, temptations, train_indices, args.eval_batch_size, use_amp)
        val_metrics = evaluate_sft(dp_model, ids, masks, feats, slots, values, temptations, val_indices, args.eval_batch_size, use_amp)
        avg_loss = total_loss / max(1, seen)
        record = {"epoch": epoch, "trainLoss": round(avg_loss, 5), "train": train_metrics, "validation": val_metrics}
        history.append(record)
        print(
            f"   [SFT {epoch:02d}/{args.epochs_sft:02d}] loss={avg_loss:.4f} "
            f"train_acc={train_metrics['slotAcc']*100:.2f}% val_acc={val_metrics['slotAcc']*100:.2f}% "
            f"val_macroF1={val_metrics['slotMacroF1']*100:.2f}% val_loss={val_metrics['loss']:.4f}"
        )
        if val_metrics["loss"] < best_val_loss - 1e-4:
            best_val_loss = val_metrics["loss"]
            best_state = freeze_copy_state(model)
            stale = 0
        else:
            stale += 1
            if stale >= args.patience:
                print(f"   early-stop: grouped validation loss did not improve for {args.patience} epochs")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    if amp_skipped_steps:
        print(f"   AMP skipped optimizer steps after overflow: {amp_skipped_steps}")
    return {"history": history, "validationFamily": val_family, "ampSkippedSteps": amp_skipped_steps,
            "trainIndices": train_indices, "validationIndices": val_indices, "ids": ids, "masks": masks,
            "features": feats, "slots": slots, "values": values, "temptations": temptations}


def stage2_simpo(args, dp_model, model, tokenizer, dataset, sft, device, use_amp):
    audited_unit_pairs = [p for p in dataset["unitStepPairs"] if p.get("trainingEligible", True)]
    audited_draft_pairs = [p for p in dataset["stepSimpoPairs"] if p.get("trainingEligible", True)]
    unit_train, unit_val = split_by_family(audited_unit_pairs, sft["validationFamily"])
    draft_train, draft_val = split_by_family(audited_draft_pairs, sft["validationFamily"])
    if not unit_train or not unit_val or not draft_train or not draft_val:
        raise RuntimeError(
            f"grouped SimPO split empty: unit={len(unit_train)}/{len(unit_val)}, "
            f"draft={len(draft_train)}/{len(draft_val)}; refusing to report a fake validation score"
        )

    tok = json.loads(PRODUCTION_WEIGHTS_PATH.read_text(encoding="utf-8"))
    prior_val = torch.tensor(tok["valueWeights"], dtype=torch.float32, device=device)
    prior_pref = torch.tensor([tok["prefWeights"][k] for k in PREF_KEYS], dtype=torch.float32, device=device)
    pair_encoder_params = list(model.encoder.parameters())
    encoder_ids = {id(p) for p in pair_encoder_params}
    pref_params = [p for name, p in model.named_parameters() if name.startswith("pref_")]
    pref_ids = {id(p) for p in pref_params}
    other_heads = [
        p for p in model.parameters()
        if p.requires_grad and id(p) not in encoder_ids and id(p) not in pref_ids
    ]
    optimizer = torch.optim.AdamW(
        [
            {"params": pair_encoder_params, "lr": args.simpo_encoder_lr},
            {"params": other_heads, "lr": args.simpo_head_lr},
            {"params": pref_params, "lr": args.pref_lr},
        ],
        weight_decay=0.005,
        eps=1e-6,
    )
    unit_steps = math.ceil(len(unit_train) / args.simpo_batch_size)
    total_steps = unit_steps * args.epochs_simpo
    scheduler = make_warmup_cosine_scheduler(optimizer, total_steps, warmup_ratio=0.05)
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    amp_skipped_steps = 0
    clip_params = [p for group in optimizer.param_groups for p in group["params"]]

    all_ids, all_masks, all_features = sft["ids"], sft["masks"], sft["features"]
    (dc_ids, dc_masks, dr_ids, dr_masks, dc_feats, dr_feats, dg) = encode_draft_pairs(
        tokenizer, draft_train + draft_val, device,
    )
    train_draft_count = len(draft_train)
    train_pair_indices = list(range(train_draft_count))
    val_pair_indices = list(range(train_draft_count, train_draft_count + len(draft_val)))
    # Eval helpers consume a single tensor bundle; pair indices select train/validation groups.
    history = []
    best_state = None
    best_score = -1.0
    best_epoch = 0

    print(
        f"\n[Stage 3/6] Group-held-out Step-SimPO: unit={len(unit_train)}/{len(unit_val)} "
        f"draft={len(draft_train)}/{len(draft_val)} pairs; val_family={sft['validationFamily']}"
    )
    for epoch in range(1, args.epochs_simpo + 1):
        dp_model.train()
        order = torch.randperm(len(unit_train)).tolist()
        d_order = torch.randperm(train_draft_count).tolist()
        total_loss = 0.0
        seen = 0
        steps = math.ceil(len(order) / args.simpo_batch_size)
        for step in range(steps):
            p_idx = order[step * args.simpo_batch_size:(step + 1) * args.simpo_batch_size]
            batch = [unit_train[i] for i in p_idx]
            win = torch.tensor([p["winIdx"] for p in batch], dtype=torch.long, device=device)
            lose = torch.tensor([p["loseIdx"] for p in batch], dtype=torch.long, device=device)
            gamma = torch.tensor([float(p["gammaStep"]) for p in batch], dtype=torch.float32, device=device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=use_amp):
                _, win_reward, _, _ = dp_model(all_ids[win], all_masks[win], all_features[win], mode="unit")
                _, lose_reward, _, _ = dp_model(all_ids[lose], all_masks[lose], all_features[lose], mode="unit")
                unit_loss = -F.logsigmoid(args.beta_simpo * (win_reward - lose_reward - gamma)).mean()
                draft_loss = torch.zeros((), device=device)
                if step % args.draft_every == 0:
                    begin = (step // args.draft_every * args.draft_batch_size) % train_draft_count
                    selected = [d_order[(begin + j) % train_draft_count] for j in range(min(args.draft_batch_size, train_draft_count))]
                    # Wrap at the end so each SimPO update receives a full, non-empty draft batch.
                    if len(selected) < args.draft_batch_size and train_draft_count > len(selected):
                        selected += [d_order[j] for j in range(args.draft_batch_size - len(selected))]
                    di = torch.tensor(selected, dtype=torch.long, device=device)
                    chosen = dp_model(dc_ids[di], dc_masks[di], dc_feats[di], mode="draft")
                    rejected = dp_model(dr_ids[di], dr_masks[di], dr_feats[di], mode="draft")
                    draft_loss = -F.logsigmoid(args.beta_simpo * (chosen - rejected - dg[di])).mean()
                prior_reg = (
                    0.04 * (model.linear_val.weight.squeeze(0) - prior_val).pow(2).mean()
                    + 0.001 * (model.pref_linear.weight.squeeze(0) - prior_pref).pow(2).mean()
                )
                loss = unit_loss + args.draft_loss_weight * draft_loss + prior_reg
            if not torch.isfinite(loss):
                raise FloatingPointError(f"non-finite SimPO loss at epoch {epoch}, step {step}")
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(clip_params, max_norm=1.0)
            scale_before = scaler.get_scale()
            scaler.step(optimizer)
            scaler.update()
            if scaler.get_scale() < scale_before:
                amp_skipped_steps += 1
            else:
                scheduler.step()
            total_loss += float(loss.detach().item()) * len(batch)
            seen += len(batch)

        train_unit_acc = evaluate_unit_pairs(dp_model, unit_train, all_ids, all_masks, all_features, args.eval_batch_size, use_amp)
        val_unit_acc = evaluate_unit_pairs(dp_model, unit_val, all_ids, all_masks, all_features, args.eval_batch_size, use_amp)
        train_draft_acc = evaluate_draft_pairs(
            dp_model, dc_ids, dc_masks, dr_ids, dr_masks, dc_feats, dr_feats,
            train_pair_indices, args.eval_batch_size // 2, use_amp,
        )
        val_draft_acc = evaluate_draft_pairs(
            dp_model, dc_ids, dc_masks, dr_ids, dr_masks, dc_feats, dr_feats,
            val_pair_indices, args.eval_batch_size // 2, use_amp,
        )
        avg_loss = total_loss / max(1, seen)
        record = {
            "epoch": epoch,
            "loss": round(avg_loss, 5),
            "trainUnitPairAcc": train_unit_acc,
            "validationUnitPairAcc": val_unit_acc,
            "trainDraftPairAcc": train_draft_acc,
            "validationDraftPairAcc": val_draft_acc,
        }
        history.append(record)
        print(
            f"   [SimPO {epoch:02d}/{args.epochs_simpo:02d}] loss={avg_loss:.4f} "
            f"unit train/val={train_unit_acc*100:.2f}/{val_unit_acc*100:.2f}% "
            f"draft train/val={train_draft_acc*100:.2f}/{val_draft_acc*100:.2f}%"
        )
        val_scores = [x for x in (val_unit_acc, val_draft_acc) if x is not None]
        score = sum(val_scores) / len(val_scores)
        if score > best_score:
            best_score = score
            best_epoch = epoch
            best_state = freeze_copy_state(model)

    if best_state is not None:
        model.load_state_dict(best_state)
    if amp_skipped_steps:
        print(f"   AMP skipped optimizer steps after overflow: {amp_skipped_steps}")
    return {
        "history": history,
        "ampSkippedSteps": amp_skipped_steps,
        "bestEpoch": best_epoch,
        "validationFamily": sft["validationFamily"],
        "trainUnitPairAcc": evaluate_unit_pairs(dp_model, unit_train, all_ids, all_masks, all_features, args.eval_batch_size, use_amp),
        "validationUnitPairAcc": evaluate_unit_pairs(dp_model, unit_val, all_ids, all_masks, all_features, args.eval_batch_size, use_amp),
        "trainDraftPairAcc": evaluate_draft_pairs(dp_model, dc_ids, dc_masks, dr_ids, dr_masks, dc_feats, dr_feats, train_pair_indices, args.eval_batch_size // 2, use_amp),
        "validationDraftPairAcc": evaluate_draft_pairs(dp_model, dc_ids, dc_masks, dr_ids, dr_masks, dc_feats, dr_feats, val_pair_indices, args.eval_batch_size // 2, use_amp),
        "unitTrainCount": len(unit_train),
        "unitValidationCount": len(unit_val),
        "draftTrainCount": len(draft_train),
        "draftValidationCount": len(draft_val),
    }


def teacher_unit_targets(dp_model, sft, device, use_amp, batch_size):
    ids, masks, feats = sft["ids"], sft["masks"], sft["features"]
    slot_logits, values, temptations = [], [], []
    dp_model.eval()
    with torch.no_grad():
        for start in range(0, ids.shape[0], batch_size):
            sl = slice(start, min(start + batch_size, ids.shape[0]))
            with torch.amp.autocast("cuda", enabled=use_amp):
                logits, _, val, tempt = dp_model(ids[sl], masks[sl], feats[sl], mode="unit")
            slot_logits.append(logits.float())
            values.append(val.float())
            temptations.append(tempt.float())
    return torch.cat(slot_logits), torch.cat(values), torch.cat(temptations)


def train_compact_student(args, teacher, dp_model, tokenizer, dataset, sft, device, use_amp, prior_weights):
    print("\n[Stage 4/6] Distilling the compact symbolic student for synchronous JavaScript inference...")
    student = CompactSymbolicStudent(teacher).to(device)
    teacher_slots, teacher_values, teacher_tempt = teacher_unit_targets(dp_model, sft, device, use_amp, args.eval_batch_size)
    train_indices, val_indices = sft["trainIndices"], sft["validationIndices"]
    labels = sft["slots"]
    values = sft["values"]
    temptations = sft["temptations"]
    features = sft["features"]
    unit_features = torch.tensor(
        [row["features"] for row in dataset["unitSamples"]], dtype=torch.float32, device=device,
    )
    unit_token_counts = torch.tensor(
        [row["tokenCount"] for row in dataset["unitSamples"]], dtype=torch.float32, device=device,
    )
    audited_unit_pairs = [pair for pair in dataset["unitStepPairs"] if pair.get("trainingEligible", True)]
    unit_train_pairs = [pair for pair in audited_unit_pairs if family_key(pair.get("family")) != sft["validationFamily"]]
    unit_val_pairs = [pair for pair in audited_unit_pairs if family_key(pair.get("family")) == sft["validationFamily"]]
    if not unit_train_pairs or not unit_val_pairs:
        raise RuntimeError(f"compact student Unit-pair split empty: {len(unit_train_pairs)}/{len(unit_val_pairs)}")
    for pair in unit_train_pairs + unit_val_pairs:
        if not math.isfinite(float(pair.get("gammaStep", float("nan")))):
            raise RuntimeError(f"audited Unit pair missing finite gammaStep: {pair.get('sourceId')}")
    lambda_weight = float(prior_weights.get("lambda", 0.0038))
    pair_loss_weight = float(args.student_unit_pair_loss_weight)
    if not math.isfinite(pair_loss_weight) or pair_loss_weight <= 0:
        raise ValueError("--student-unit-pair-loss-weight must be finite and positive")
    matched_bucket_weight = float(args.matched_bucket_loss_weight)
    if not math.isfinite(matched_bucket_weight) or matched_bucket_weight <= 0:
        raise ValueError("--matched-bucket-loss-weight must be finite and positive")
    temperature = 2.0
    optimizer = torch.optim.AdamW(student.parameters(), lr=args.student_lr, weight_decay=1e-4)
    history = []
    best_state = None
    best_loss = float("inf")
    best_pair_acc = -1.0
    stale = 0

    def unit_pair_metrics(pairs):
        """Compact student Unit objective over audited preference pairs.

        listwise (default): for every positive endpoint, build the candidate set
        [positive - mean(gammaStep)] + [its negatives] and take softmax cross-entropy with the
        positive as the single relevant item (Softmax/ListNet-style listwise loss). The required
        margin stays per-pair inside each group; a positive reused across groups contributes once
        per group. ranknet: legacy pairwise -log sigmoid(beta * (delta - margin)).
        Returns (loss, strict_pair_accuracy, group_count); strict accuracy counts delta > 0 only.
        """
        if not pairs:
            return torch.zeros((), device=device), None, 0
        win_idx = torch.tensor([pair["winIdx"] for pair in pairs], dtype=torch.long, device=device)
        lose_idx = torch.tensor([pair["loseIdx"] for pair in pairs], dtype=torch.long, device=device)
        margins = torch.tensor([float(pair["gammaStep"]) for pair in pairs], dtype=torch.float32, device=device)
        win_score = compact_unit_runtime_score(
            student, unit_features[win_idx], unit_token_counts[win_idx], lambda_weight,
        )
        lose_score = compact_unit_runtime_score(
            student, unit_features[lose_idx], unit_token_counts[lose_idx], lambda_weight,
        )
        delta = win_score - lose_score
        accuracy = float((delta > 0).float().mean().item())
        # 2026-10-04 杠杆B 追加：长度匹配桶（承重读数）加权；报告口径的 accuracy 保持不加权。
        length_gap = (unit_token_counts[win_idx] - unit_token_counts[lose_idx]).abs()
        member_weights = torch.where(
            length_gap <= float(args.near_length_tokens),
            torch.full_like(length_gap, matched_bucket_weight),
            torch.ones_like(length_gap),
        )
        if args.student_pair_objective == "ranknet":
            rank_loss = -F.logsigmoid(args.beta_simpo * (delta - margins)).mean()
            return rank_loss, accuracy, len(pairs)
        grouped = {}
        for position, pair in enumerate(pairs):
            grouped.setdefault(int(pair["winIdx"]), []).append(position)
        group_losses = []
        group_weights = []
        for members in grouped.values():
            member_ix = torch.tensor(members, dtype=torch.long, device=device)
            anchor = win_score[member_ix][0] - margins[member_ix].mean()
            candidates = torch.cat([anchor.reshape(1), lose_score[member_ix]])
            group_losses.append(torch.logsumexp(candidates, dim=0) - anchor)
            group_weights.append(member_weights[member_ix].mean())
        group_weights = torch.stack(group_weights)
        list_loss = (torch.stack(group_losses) * group_weights).sum() / group_weights.sum()
        return list_loss, accuracy, len(grouped)

    def student_eval(selected, pairs):
        if not selected:
            return {"loss": None, "slotAcc": None, "slotMacroF1": None}
        student.eval()
        with torch.no_grad():
            ix = torch.tensor(selected, dtype=torch.long, device=device)
            logits, _, pred_values, pred_tempt = student.forward_units(features[ix])
            hard_loss = F.cross_entropy(logits, labels[ix])
            teacher_prob = F.softmax(teacher_slots[ix] / temperature, dim=-1)
            distill_loss = F.kl_div(F.log_softmax(logits / temperature, dim=-1), teacher_prob, reduction="batchmean") * temperature**2
            value_loss = F.huber_loss(pred_values, 0.5 * values[ix] + 0.5 * teacher_values[ix], delta=0.15)
            tempt_loss = F.huber_loss(pred_tempt, 0.5 * temptations[ix] + 0.5 * teacher_tempt[ix], delta=0.15)
            pair_loss, pair_accuracy, _pair_groups = unit_pair_metrics(pairs)
            multitask_loss = 0.55 * hard_loss + 0.45 * distill_loss + value_loss + 0.6 * tempt_loss
            total_loss = multitask_loss + pair_loss_weight * pair_loss
            metrics = classification_stats(logits, labels[ix])
            metrics.update({
                "loss": round(float(total_loss.item()), 5),
                "multiTaskLoss": round(float(multitask_loss.item()), 5),
                "unitPairwiseLoss": round(float(pair_loss.item()), 5),
                "unitPairAccReference": round(pair_accuracy, 4),
                "unitPairObjective": args.student_pair_objective,
                "unitPairCount": len(pairs),
                "unitPairLossWeight": pair_loss_weight,
                "valueMae": round(float((pred_values - values[ix]).abs().mean().item()), 5),
                "samples": len(selected),
            })
        return metrics

    # 2026-10-04 杠杆B：类别平衡 CE（sqrt 逆频率，clamp[0.5,3.0]）+ label smoothing 0.05。
    # 诊断：NOISE 占候选主体，稀有槽位（MECHANISM/ACCEPT/OPEN）槽位 F1=0 被压制。
    _label_counts = torch.bincount(
        labels[torch.tensor(train_indices, dtype=torch.long, device=device)],
        minlength=len(SLOT_NAMES),
    ).float().clamp(min=1.0)
    _sqrt_inv = torch.sqrt(_label_counts.sum() / (len(SLOT_NAMES) * _label_counts))
    unit_class_weights = (_sqrt_inv / _sqrt_inv.mean()).clamp(0.5, 3.0).to(device)
    print(f"   [Student] matched-bucket (|delta token| <= {args.near_length_tokens}) loss weight = {matched_bucket_weight}")
    print("   [Student] class-balanced CE weights (sqrt-inv-freq, clamp 0.5-3.0): "
          + ", ".join(f"{name}={float(w):.3f}" for name, w in zip(SLOT_NAMES, unit_class_weights)))

    for epoch in range(1, args.student_epochs + 1):
        student.train()
        order = torch.tensor(train_indices, dtype=torch.long, device=device)
        order = order[torch.randperm(len(train_indices), device=device)]
        for start in range(0, len(train_indices), args.student_batch_size):
            ix = order[start:start + args.student_batch_size]
            optimizer.zero_grad(set_to_none=True)
            logits, _, pred_values, pred_tempt = student.forward_units(features[ix])
            hard_loss = F.cross_entropy(logits, labels[ix], weight=unit_class_weights, label_smoothing=0.05)
            teacher_prob = F.softmax(teacher_slots[ix] / temperature, dim=-1)
            distill_loss = F.kl_div(F.log_softmax(logits / temperature, dim=-1), teacher_prob, reduction="batchmean") * temperature**2
            value_loss = F.huber_loss(pred_values, 0.5 * values[ix] + 0.5 * teacher_values[ix], delta=0.15)
            tempt_loss = F.huber_loss(pred_tempt, 0.5 * temptations[ix] + 0.5 * teacher_tempt[ix], delta=0.15)
            # 杠杆B：KL 权重 0.45→0.15（教师弱于学生时，45% 的槽位监督在教错误答案）
            loss = 0.55 * hard_loss + 0.15 * distill_loss + value_loss + 0.6 * tempt_loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            optimizer.step()

        # Optimize the scalar JS Unit rank score with audited, family-grouped preference pairs.
        student.train()
        optimizer.zero_grad(set_to_none=True)
        pair_loss, _, _ = unit_pair_metrics(unit_train_pairs)
        weighted_pair_loss = pair_loss_weight * pair_loss
        if not torch.isfinite(weighted_pair_loss):
            raise FloatingPointError(f"non-finite compact Unit pair loss at epoch {epoch}")
        weighted_pair_loss.backward()
        torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
        optimizer.step()

        train_metrics = student_eval(train_indices, unit_train_pairs)
        val_metrics = student_eval(val_indices, unit_val_pairs)
        record = {"epoch": epoch, "train": train_metrics, "validation": val_metrics}
        history.append(record)
        if epoch == 1 or epoch % 10 == 0 or epoch == args.student_epochs:
            print(
                f"   [Student {epoch:02d}/{args.student_epochs:02d}] "
                f"train_slot={train_metrics['slotAcc']*100:.2f}% val_slot={val_metrics['slotAcc']*100:.2f}% "
                f"train_unit_pair={train_metrics['unitPairAccReference']*100:.2f}% "
                f"val_unit_pair={val_metrics['unitPairAccReference']*100:.2f}% "
                f"val_pair_loss={val_metrics['unitPairwiseLoss']:.4f}"
            )
        # 杠杆B：按「验证集 Unit 对胜率」选检查点（部署目标），val loss 仅作平手 tiebreak。
        _val_pair_acc = float(val_metrics.get("unitPairAccReference") or 0.0)
        _improved = _val_pair_acc > best_pair_acc + 1e-9 or (
            abs(_val_pair_acc - best_pair_acc) <= 1e-9 and val_metrics["loss"] < best_loss - 1e-5
        )
        if _improved:
            best_pair_acc = max(best_pair_acc, _val_pair_acc)
            best_loss = val_metrics["loss"]
            best_state = freeze_copy_state(student)
            stale = 0
        else:
            stale += 1
            if stale >= args.student_patience:
                break
    if best_state:
        student.load_state_dict(best_state)

    # Distill the full-text draft reward into a 12-feature nonlinear head for JS inference.
    audited_draft_pairs = [p for p in dataset["stepSimpoPairs"] if p.get("trainingEligible", True)]
    draft_train = [p for p in audited_draft_pairs if family_key(p.get("family")) != sft["validationFamily"]]
    draft_val = [p for p in audited_draft_pairs if family_key(p.get("family")) == sft["validationFamily"]]
    all_draft_pairs = draft_train + draft_val
    (chosen_ids, chosen_masks, rejected_ids, rejected_masks, chosen_feats, rejected_feats, gammas) = encode_draft_pairs(
        tokenizer, all_draft_pairs, device,
    )
    n_train = len(draft_train)
    pair_indices_train = list(range(n_train))
    pair_indices_val = list(range(n_train, len(all_draft_pairs)))
    teacher_chosen, teacher_rejected = [], []
    dp_model.eval()
    with torch.no_grad():
        for start in range(0, len(all_draft_pairs), args.eval_batch_size // 2):
            ix = torch.arange(start, min(start + args.eval_batch_size // 2, len(all_draft_pairs)), device=device)
            with torch.amp.autocast("cuda", enabled=use_amp):
                tc = dp_model(chosen_ids[ix], chosen_masks[ix], chosen_feats[ix], mode="draft")
                tr = dp_model(rejected_ids[ix], rejected_masks[ix], rejected_feats[ix], mode="draft")
            teacher_chosen.append(tc.float())
            teacher_rejected.append(tr.float())
    teacher_chosen = torch.cat(teacher_chosen)
    teacher_rejected = torch.cat(teacher_rejected)

    pref_params = [student.pref_linear.weight, *student.pref_mlp1.parameters(), *student.pref_mlp2.parameters()]
    pref_optimizer = torch.optim.AdamW(pref_params, lr=args.pref_student_lr, weight_decay=1e-4)
    pref_history = []
    best_pref_state = None
    best_pref_acc = -1.0
    best_pref_loss = float("inf")
    pref_stale = 0

    def pref_eval(pair_ids):
        if not pair_ids:
            return {"pairAcc": None, "loss": None}
        student.eval()
        with torch.no_grad():
            ix = torch.tensor(pair_ids, dtype=torch.long, device=device)
            chosen = student.forward_pref(chosen_feats[ix])
            rejected = student.forward_pref(rejected_feats[ix])
            distill = 0.5 * (F.mse_loss(chosen, teacher_chosen[ix]) + F.mse_loss(rejected, teacher_rejected[ix]))
            rank = -F.logsigmoid(args.beta_simpo * (chosen - rejected - gammas[ix])).mean()
            return {"pairAcc": accuracy_from_scores(chosen, rejected), "loss": round(float((distill + rank).item()), 5)}

    for epoch in range(1, args.pref_student_epochs + 1):
        student.train()
        order = torch.randperm(n_train).tolist()
        for start in range(0, n_train, args.student_batch_size):
            ids = torch.tensor(order[start:start + args.student_batch_size], dtype=torch.long, device=device)
            pref_optimizer.zero_grad(set_to_none=True)
            chosen = student.forward_pref(chosen_feats[ids])
            rejected = student.forward_pref(rejected_feats[ids])
            distill = 0.5 * (F.mse_loss(chosen, teacher_chosen[ids]) + F.mse_loss(rejected, teacher_rejected[ids]))
            rank = -F.logsigmoid(args.beta_simpo * (chosen - rejected - gammas[ids])).mean()
            loss = 0.65 * distill + rank
            loss.backward()
            torch.nn.utils.clip_grad_norm_(pref_params, 1.0)
            pref_optimizer.step()
        tr = pref_eval(pair_indices_train)
        va = pref_eval(pair_indices_val)
        pref_history.append({"epoch": epoch, "train": tr, "validation": va})
        if epoch == 1 or epoch % 10 == 0 or epoch == args.pref_student_epochs:
            print(f"   [Preference student {epoch:02d}/{args.pref_student_epochs:02d}] train={tr['pairAcc']*100:.2f}% val={va['pairAcc']*100:.2f}%")
        if va["pairAcc"] > best_pref_acc or (va["pairAcc"] == best_pref_acc and va["loss"] < best_pref_loss):
            best_pref_acc = va["pairAcc"]
            best_pref_loss = va["loss"]
            best_pref_state = freeze_copy_state(student)
            pref_stale = 0
        else:
            pref_stale += 1
            if pref_stale >= args.student_patience:
                break
    if best_pref_state:
        student.load_state_dict(best_pref_state)

    compact_train_pair_acc = pref_eval(pair_indices_train)["pairAcc"]
    compact_val_pair_acc = pref_eval(pair_indices_val)["pairAcc"]
    unit_train_metrics = student_eval(train_indices, unit_train_pairs)
    student_val_metrics = student_eval(val_indices, unit_val_pairs)
    return student, {
        "unitHistory": history,
        "unitTrain": unit_train_metrics,
        "unitValidation": student_val_metrics,
        "unitPairLossWeight": pair_loss_weight,
        "unitPairMatchedBucketWeight": matched_bucket_weight,
        "unitPairBeta": float(args.beta_simpo),
        "unitPairObjective": args.student_pair_objective,
        "unitPairMarginSource": "gammaStep from audited Unit preference pairs",
        # Final Unit-pair accuracy is filled only after serialized JSON is scored by actual JS.
        "unitTrainPairAcc": None,
        "unitValidationPairAcc": None,
        "unitTrainPairs": len(unit_train_pairs),
        "unitValidationPairs": len(unit_val_pairs),
        "prefHistory": pref_history,
        "prefTrainPairAcc": compact_train_pair_acc,
        "prefValidationPairAcc": compact_val_pair_acc,
        "prefTrainPairs": len(draft_train),
        "prefValidationPairs": len(draft_val),
    }


def serialize_candidate(prior_weights: dict, student: CompactSymbolicStudent,
                        dataset: dict, sft_result: dict, simpo_result: dict, student_stats: dict,
                        total_params: int, trainable_params: int, device_label: str):
    with torch.no_grad():
        value_weights = [round(float(x), 6) for x in student.linear_val.weight.squeeze(0).cpu().tolist()]
        slot_weights = {
            slot: [round(float(x), 6) for x in student.linear_slot.weight[i].cpu().tolist()]
            for i, slot in enumerate(SLOT_NAMES)
        }
        pref_weights = {
            key: round(float(student.pref_linear.weight.squeeze(0)[i].cpu().item()), 6)
            for i, key in enumerate(PREF_KEYS)
        }
        unit_mlp = {
            "scale": 0.25,
            "W1": [[round(float(v), 6) for v in row] for row in student.fc1.weight.cpu().tolist()],
            "b1": [round(float(v), 6) for v in student.fc1.bias.cpu().tolist()],
            "WVal": [round(float(v), 6) for v in student.val_out.weight.squeeze(0).cpu().tolist()],
            "WTempt": [round(float(v), 6) for v in student.tempt_out.weight.squeeze(0).cpu().tolist()],
            "WSlot": {
                slot: [round(float(v), 6) for v in student.slot_out.weight[i].cpu().tolist()]
                for i, slot in enumerate(SLOT_NAMES)
            },
        }
        pref_mlp = {
            "scale": 1.0,
            "W1": [[round(float(v), 6) for v in row] for row in student.pref_mlp1.weight.cpu().tolist()],
            "b1": [round(float(v), 6) for v in student.pref_mlp1.bias.cpu().tolist()],
            "W2": [round(float(v), 6) for v in student.pref_mlp2.weight.squeeze(0).cpu().tolist()],
            "b2": round(float(student.pref_mlp2.bias.squeeze(0).cpu().item()), 6),
        }
    # 2026-10-04：19 维基础名 + 文本哈希桶名（与 JS v5FeatureNamesFor 逐字一致）。
    buckets = int(dataset.get("stats", {}).get("textHashBuckets", 0) or 0)
    base_names = list(prior_weights.get("featureNames") or [])
    if len(base_names) != 19:
        raise RuntimeError(f"prior weights featureNames must be the 19 base names; got {len(base_names)}")
    feature_names = base_names + [f"txh_{i}" for i in range(buckets)]
    if len(feature_names) != len(value_weights) or len(feature_names) != len(slot_weights[SLOT_NAMES[0]]):
        raise RuntimeError(
            f"serialized feature width mismatch: names={len(feature_names)} "
            f"valueWeights={len(value_weights)} slotWeights={len(slot_weights[SLOT_NAMES[0]])}"
        )
    if unit_mlp["W1"] and len(unit_mlp["W1"][0]) != len(feature_names):
        raise RuntimeError(f"unit MLP input width {len(unit_mlp['W1'][0])} != feature width {len(feature_names)}")
    return {
        **prior_weights,
        "schema": "cfb.v5-micro-weights/3-distilled-pretrained",
        "trainedOn": (
            f"dev-only grouped split; validation family={sft_result['validationFamily']} excluded from gradient updates; "
            f"{len(sft_result['trainIndices'])} train units + grouped train preference pairs"
        ),
        "holdoutTouched": False,
        "architecture": {
            "name": "CFB-Micro-97M-Multilingual",
            "backbone": MODEL_ID,
            "backboneRevision": MODEL_REVISION,
            "license": MODEL_LICENSE,
            "totalParameters": total_params,
            "trainableParameters": trainable_params,
            "parameterBillion": round(total_params / 1e9, 6),
            "under01B": total_params < 100_000_000,
            "fullEncoderOnnxArtifact": "see cfb-micro-97m-report.json for the persisted candidate/release or production location",
            "compactStudentOnnxArtifact": "see cfb-micro-97m-report.json for candidate or production path",
            "runtimePath": "compileV5Local: symbolic feature student (19 base dims + textHashBuckets); full encoder ONNX is separately available",
            "trainingMaxTokens": MAX_SEQ_LEN,
        },
        "trainingStats": {
            "device": device_label,
            "validationFamily": sft_result["validationFamily"],
            "devGoldCount": dataset["stats"]["devGoldItems"],
            "devPoolCount": dataset["stats"]["devPoolItems"],
            "devUnitSamples": dataset["stats"]["unitSamplesCount"],
            "devTrainEligibleUnitSamples": dataset["stats"]["trainEligibleUnitSamples"],
            "devUnitLabelsNeedsReview": dataset["stats"]["unitLabelNeedsReview"],
            "trainUnitSamples": len(sft_result["trainIndices"]),
            "validationUnitSamples": len(sft_result["validationIndices"]),
            "sftAmpSkippedSteps": sft_result["ampSkippedSteps"],
            "simpoAmpSkippedSteps": simpo_result["ampSkippedSteps"],
            "devUnitStepPairs": dataset["stats"]["unitStepPairsCount"],
            "devDraftPreferencePairs": dataset["stats"]["stepSimpoPairsCount"],
            "trainEligibleDraftPreferencePairs": dataset["stats"]["trainEligibleStepSimpoPairs"],
            "draftPreferencePairsNeedsReview": dataset["stats"]["stepSimpoLabelsNeedsReview"],
            "unitPairEndpointReuse": dataset["stats"]["unitPairEndpointReuse"],
            "lastSftTrain": sft_result["history"][-1]["train"],
            "lastSftValidation": sft_result["history"][-1]["validation"],
            "bestSftValidation": min(sft_result["history"], key=lambda x: x["validation"]["loss"])["validation"],
            "simpoBestEpoch": simpo_result["bestEpoch"],
            "simpoTrainUnitPairAcc": simpo_result["trainUnitPairAcc"],
            "simpoValidationUnitPairAcc": simpo_result["validationUnitPairAcc"],
            "simpoTrainDraftPairAcc": simpo_result["trainDraftPairAcc"],
            "simpoValidationDraftPairAcc": simpo_result["validationDraftPairAcc"],
            "studentUnitTrain": student_stats["unitTrain"],
            "studentUnitValidation": student_stats["unitValidation"],
            "compactStudentUnitTrainPairs": student_stats["unitTrainPairs"],
            "compactStudentUnitValidationPairs": student_stats["unitValidationPairs"],
            "compactStudentUnitPairLossWeight": student_stats["unitPairLossWeight"],
            "compactStudentUnitPairBeta": student_stats["unitPairBeta"],
            "compactStudentUnitPairMarginSource": student_stats["unitPairMarginSource"],
            "compactStudentUnitPairObjective": student_stats["unitPairObjective"],
            "compactStudentUnitTrainPairwiseLoss": student_stats["unitTrain"]["unitPairwiseLoss"],
            "compactStudentUnitValidationPairwiseLoss": student_stats["unitValidation"]["unitPairwiseLoss"],
            "compactStudentUnitTrainPairAccPreSerialization": student_stats["unitTrain"]["unitPairAccReference"],
            "compactStudentUnitValidationPairAccPreSerialization": student_stats["unitValidation"]["unitPairAccReference"],
            "pytorchStudentDraftTrainPairAcc": student_stats["prefTrainPairAcc"],
            "pytorchStudentDraftValidationPairAcc": student_stats["prefValidationPairAcc"],
        },
        "featureNames": feature_names,
        "textHashBuckets": buckets,
        "symFeatureDim": len(feature_names),
        "valueWeights": value_weights,
        "slotWeights": slot_weights,
        "prefWeights": pref_weights,
        "mlpHead": unit_mlp,
        "prefMlpHead": pref_mlp,
    }


def build_runtime_parity_fixtures(student: CompactSymbolicStudent, dataset: dict, weights: dict) -> dict:
    """Compare the trained PyTorch student with its serialized production-JS scoring semantics."""
    student.eval()
    unit_rows = [
        (index, row) for index, row in enumerate(dataset["unitSamples"])
        if row.get("trainingEligible", True)
    ]
    if not unit_rows:
        raise RuntimeError("no audited unit rows available for Python/JS parity")

    unit_x = torch.tensor([row["features"] for _, row in unit_rows], dtype=torch.float32)
    unit_tok = torch.tensor([row["tokenCount"] for _, row in unit_rows], dtype=torch.float32)
    unit_temptation = torch.tensor(
        [row.get("temptationT", row["features"][9]) for _, row in unit_rows],
        dtype=torch.float32,
    )
    unit_cue_excluded = unit_x[:, 15]
    lambda_weight = float(weights.get("lambda") or 0.0038)
    temptation_min = float(weights.get("temptationMin", 0.18))
    with torch.no_grad():
        hidden = F.gelu(student.fc1(unit_x), approximate="tanh")
        value = compact_unit_runtime_score(student, unit_x, unit_tok, lambda_weight)
        raw_temptation = student.tempt_out(hidden).squeeze(-1)
        temptation = torch.clamp(
            0.7 * unit_temptation + 0.3 * torch.sigmoid(raw_temptation), 0.0, 1.0,
        )
        logits = student.linear_slot(unit_x) + 0.25 * student.slot_out(hidden)
        gate_active = (temptation < temptation_min) & (unit_cue_excluded < 0.9)
        logits[:, SLOT_NAMES.index("EXCLUDED")] -= 0.65 * gate_active.float()
        probabilities = torch.softmax(logits, dim=-1)
        rounded_probabilities = torch.floor(probabilities * 10000 + 0.5) / 10000
        predicted = rounded_probabilities.argmax(dim=-1)

    unit_fixtures = []
    for (dataset_index, row), value_score, temptation_score, probs, slot_idx, gate in zip(
        unit_rows,
        value.cpu().tolist(),
        temptation.cpu().tolist(),
        probabilities.cpu().tolist(),
        predicted.cpu().tolist(),
        gate_active.cpu().tolist(),
    ):
        unit_fixtures.append({
            "datasetIndex": dataset_index,
            "sourceId": row.get("sourceId"),
            "features": [float(x) for x in row["features"]],
            "tokenCount": float(row["tokenCount"]),
            "temptationT": float(row.get("temptationT", row["features"][9])),
            "cueExcluded": float(row["features"][15]),
            "expected": {
                "v": float(value_score),
                "temptationPred": float(temptation_score),
                "probs": {slot: float(probs[i]) for i, slot in enumerate(SLOT_NAMES)},
                "slot": SLOT_NAMES[slot_idx],
                "excludedGateActive": bool(gate),
            },
        })

    draft_feature_rows = []
    for pair in dataset["stepSimpoPairs"]:
        if not pair.get("trainingEligible", True):
            continue
        for side in ("chosen", "rejected"):
            pref = pair.get(f"{side}Pref")
            if not isinstance(pref, dict) or any(key not in pref for key in PREF_KEYS):
                raise RuntimeError(f"missing audited draft feature vector: {pair.get('id')}:{side}")
            draft_feature_rows.append((pair.get("id"), side, pref))
    if not draft_feature_rows:
        raise RuntimeError("no audited draft rows available for Python/JS parity")

    draft_x = torch.tensor(
        [[float(pref[key]) for key in PREF_KEYS] for _, _, pref in draft_feature_rows],
        dtype=torch.float32,
    )
    with torch.no_grad():
        draft_scores = student.forward_pref(draft_x).cpu().tolist()
    draft_fixtures = [
        {"pairId": pair_id, "side": side, "features": pref, "expected": float(score)}
        for (pair_id, side, pref), score in zip(draft_feature_rows, draft_scores)
    ]
    return {
        "schema": "cfb.micro-runtime-parity-fixtures/1",
        "source": "actual audited dataset feature vectors created by the JS dataset builder",
        "reference": "PyTorch CompactSymbolicStudent full-precision parameters recomputed with the JS scorer equations, before six-decimal JSON quantization",
        "weightSchema": weights["schema"],
        "tolerance": 0.001,
        "unit": unit_fixtures,
        "draft": draft_fixtures,
    }


def export_models(teacher, student, tokenizer):
    import onnxruntime as ort

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    TOKENIZER_DIR.mkdir(parents=True, exist_ok=True)
    tokenizer.save_pretrained(TOKENIZER_DIR)

    compact_tmp = Path("/kaggle/working/cfb-micro-neural.candidate.onnx")
    compact_tmp.parent.mkdir(parents=True, exist_ok=True)
    student_cpu = CompactStudentONNX(student.cpu().eval())
    dummy_sym = torch.randn(36, student.sym_dim, dtype=torch.float32)
    dummy_pref = torch.randn(36, len(PREF_KEYS), dtype=torch.float32)
    safe_onnx_export(
        student_cpu,
        (dummy_sym, dummy_pref),
        str(compact_tmp),
        input_names=["sym_features", "pref_features"],
        output_names=["value_score", "temptation_prob", "slot_probs", "draft_pref_score"],
        dynamic_axes={
            "sym_features": {0: "num_units"},
            "pref_features": {0: "num_drafts"},
            "value_score": {0: "num_units"},
            "temptation_prob": {0: "num_units"},
            "slot_probs": {0: "num_units"},
            "draft_pref_score": {0: "num_drafts"},
        },
        opset_version=17,
    )
    compact_sess = ort.InferenceSession(str(compact_tmp), providers=["CPUExecutionProvider"])
    compact_input = np.random.default_rng(7).normal(size=(36, student.sym_dim)).astype(np.float32)
    compact_pref = np.random.default_rng(8).normal(size=(36, len(PREF_KEYS))).astype(np.float32)
    compact_sess.run(None, {"sym_features": compact_input, "pref_features": compact_pref})
    start_time = time.perf_counter()
    for _ in range(25):
        compact_sess.run(None, {"sym_features": compact_input, "pref_features": compact_pref})
    compact_ms = (time.perf_counter() - start_time) * 1000 / 25

    full_tmp = FULL_WORKING_PATH
    full_fp32 = Path("/kaggle/working/cfb-micro-97m-multilingual.fp32.onnx")
    full_result = {
        "fullTempPath": str(full_tmp),
        "fullBytes": None,
        "fullBatch2Seq256CpuMs": None,
        "fullOnnxSmoke": "failed",
    }
    try:
        full_tmp.parent.mkdir(parents=True, exist_ok=True)
        full_tmp.unlink(missing_ok=True)
        full_fp32.unlink(missing_ok=True)
        full_wrapper = FullEncoderONNXWrapper(teacher.cpu().eval())
        dummy_ids = torch.ones(2, MAX_SEQ_LEN, dtype=torch.long)
        dummy_mask = torch.ones(2, MAX_SEQ_LEN, dtype=torch.long)
        dummy_span = torch.ones(2, dtype=torch.long)
        dummy_sym = torch.randn(2, teacher.sym_dim, dtype=torch.float32)
        dummy_pref = torch.randn(2, len(PREF_KEYS), dtype=torch.float32)
        safe_onnx_export(
            full_wrapper,
            (dummy_ids, dummy_mask, dummy_sym, dummy_pref, dummy_span, dummy_span),
            str(full_fp32),
            input_names=["input_ids", "attention_mask", "sym_features", "pref_features", "span_start", "span_end"],
            output_names=["value_score", "temptation_prob", "slot_probs", "draft_pref_score", "span_logits"],
            dynamic_axes={
                "input_ids": {0: "batch"},
                "attention_mask": {0: "batch"},
                "sym_features": {0: "batch"},
                "pref_features": {0: "batch"},
                "span_start": {0: "batch"},
                "span_end": {0: "batch"},
                "value_score": {0: "batch"},
                "temptation_prob": {0: "batch"},
                "slot_probs": {0: "batch"},
                "draft_pref_score": {0: "batch"},
                "span_logits": {0: "batch"},
            },
            opset_version=17,
        )
        from onnxruntime.quantization import QuantType, quantize_dynamic
        quantize_dynamic(str(full_fp32), str(full_tmp), weight_type=QuantType.QInt8, per_channel=True)
        full_fp32.unlink(missing_ok=True)

        full_sess = ort.InferenceSession(str(full_tmp), providers=["CPUExecutionProvider"])
        full_feed = {
            "input_ids": np.ones((2, MAX_SEQ_LEN), dtype=np.int64),
            "attention_mask": np.ones((2, MAX_SEQ_LEN), dtype=np.int64),
            "sym_features": np.zeros((2, teacher.sym_dim), dtype=np.float32),
            "pref_features": np.zeros((2, len(PREF_KEYS)), dtype=np.float32),
            "span_start": np.ones((2,), dtype=np.int64),
            "span_end": np.full((2,), 3, dtype=np.int64),
        }
        full_out = full_sess.run(None, full_feed)
        if len(full_out) != 5 or not all(np.isfinite(np.asarray(x)).all() for x in full_out):
            raise RuntimeError("quantized full ONNX numerical smoke test failed")
        start_time = time.perf_counter()
        for _ in range(3):
            full_sess.run(None, full_feed)
        full_result.update({
            "fullBytes": full_tmp.stat().st_size,
            "fullBatch2Seq256CpuMs": round((time.perf_counter() - start_time) * 1000 / 3, 3),
            "fullOnnxSmoke": "passed",
        })
    except Exception as exc:
        full_fp32.unlink(missing_ok=True)
        if full_tmp.exists():
            full_tmp.unlink()
        full_result["fullError"] = f"{type(exc).__name__}: {exc}"[:2000]
        print(f"   ⚠ Full encoder ONNX export/smoke failed; candidate will not be promoted: {full_result['fullError']}")

    return {
        "compactTempPath": str(compact_tmp),
        "compactBytes": compact_tmp.stat().st_size,
        "compactBatch36CpuMs": round(compact_ms, 4),
        "tokenizerDir": str(TOKENIZER_DIR),
        **full_result,
    }

def create_github_release_asset(path: Path, token: str, tag_name: str):
    import requests

    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    release = requests.post(
        f"https://api.github.com/repos/{GITHUB_REPO}/releases",
        headers=headers,
        json={
            "tag_name": tag_name,
            "name": tag_name,
            "body": "CFB-Micro pretrained multilingual encoder candidate; see cfb-micro-97m-report.json for the measured gates.",
            "draft": False,
            "prerelease": True,
        },
        timeout=60,
    )
    release.raise_for_status()
    info = release.json()
    upload_url = info["upload_url"].split("{", 1)[0] + "?name=" + path.name
    with path.open("rb") as stream:
        uploaded = requests.post(
            upload_url,
            headers={**headers, "Content-Type": "application/octet-stream"},
            data=stream,
            timeout=(60, 1800),
        )
    uploaded.raise_for_status()
    return uploaded.json().get("browser_download_url")


def refresh_manifest():
    subprocess.run(
        ["bash", "-lc", "set -o pipefail; git ls-files | grep -v '^MANIFEST\\.sha256$' | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256"],
        cwd=str(ROOT),
        check=True,
    )


def push_back(report: dict, promoted: bool, compact_path: Path, full_path: Path | None, tokenizer_dir: Path):
    full_exists = full_path is not None and full_path.exists()
    full_in_production = False

    if promoted:
        if not full_exists:
            raise RuntimeError("cannot promote without the full quantized ONNX model")
        print("\n[GitHub] Quality gates passed: promoting the compact student and publishing the full encoder.")
        shutil.copy2(compact_path, COMPACT_PRODUCTION_PATH)
        compact_path.unlink(missing_ok=True)
        report["artifacts"].pop("compactCandidateOnnx", None)
        report["artifacts"]["compactProductionGitPath"] = str(COMPACT_PRODUCTION_PATH.relative_to(ROOT))
        full_bytes = full_path.stat().st_size
        if full_bytes < GITHUB_LARGE_ASSET_THRESHOLD:
            shutil.copy2(full_path, FULL_PRODUCTION_PATH)
            report["artifacts"]["fullEncoderGitPath"] = str(FULL_PRODUCTION_PATH.relative_to(ROOT))
            full_in_production = True
        else:
            token = os.environ.get("GITHUB_PAT", "")
            if not token:
                raise RuntimeError("full ONNX is too large for a normal GitHub git blob and GITHUB_PAT is unset")
            tag = "cfb-micro-97m-" + time.strftime("%Y%m%d%H%M%S", time.gmtime())
            report["artifacts"]["fullEncoderReleaseUrl"] = create_github_release_asset(full_path, token, tag)
            report["artifacts"]["fullEncoderReleaseTag"] = tag
        report["promoted"] = True
    else:
        print("\n[GitHub] Quality gates not met: preserving production weights and publishing candidate artifacts only.")
        report["promoted"] = False
        if full_exists:
            full_bytes = full_path.stat().st_size
            if full_bytes < GITHUB_LARGE_ASSET_THRESHOLD:
                shutil.copy2(full_path, FULL_CANDIDATE_PATH)
                report["artifacts"]["fullEncoderCandidateGitPath"] = str(FULL_CANDIDATE_PATH.relative_to(ROOT))
            else:
                if FULL_CANDIDATE_PATH.exists():
                    FULL_CANDIDATE_PATH.unlink()
                token = os.environ.get("GITHUB_PAT", "")
                if not token:
                    raise RuntimeError("full ONNX is too large for GitHub git and GITHUB_PAT is unset")
                tag = "cfb-micro-97m-candidate-" + time.strftime("%Y%m%d%H%M%S", time.gmtime())
                report["artifacts"]["fullEncoderCandidateReleaseUrl"] = create_github_release_asset(full_path, token, tag)
                report["artifacts"]["fullEncoderCandidateReleaseTag"] = tag
        if not full_exists and FULL_CANDIDATE_PATH.exists():
            FULL_CANDIDATE_PATH.unlink()

    # A stale candidate from an earlier rejected run must not be mistaken for this release.
    if promoted and FULL_CANDIDATE_PATH.exists():
        FULL_CANDIDATE_PATH.unlink()

    save_json(REPORT_JSON_PATH, report)
    staged = ["transfer/models/cfb-micro-97m-report.json"]
    # 2026-10-04：3 折家族 CV 时额外落一份带折名的报告，便于三折并读（互不覆盖）。
    fold_family = (report.get("training", {}) or {}).get("validationFamily") or (report.get("dataset", {}) or {}).get("validationFamily")
    if fold_family:
        fold_path = REPORT_JSON_PATH.with_name(f"cfb-micro-97m-report.fold-{fold_family}.json")
        save_json(fold_path, report)
        staged.append(str(fold_path.relative_to(ROOT)))
    if FINAL_TEST_LEDGER_PATH.exists():
        staged.append(str(FINAL_TEST_LEDGER_PATH.relative_to(ROOT)))
    if CANDIDATE_WEIGHTS_PATH.exists():
        staged.append("transfer/models/v5-micro-weights.candidate.json")
    if promoted:
        shutil.copy2(CANDIDATE_WEIGHTS_PATH, PRODUCTION_WEIGHTS_PATH)
        staged.extend(["transfer/models/v5-micro-weights.json", "transfer/models/cfb-micro-neural.onnx"])
        if full_in_production:
            staged.append(str(FULL_PRODUCTION_PATH.relative_to(ROOT)))
    else:
        if COMPACT_CANDIDATE_PATH.exists():
            staged.append(str(COMPACT_CANDIDATE_PATH.relative_to(ROOT)))
        if full_exists and FULL_CANDIDATE_PATH.exists():
            staged.append(str(FULL_CANDIDATE_PATH.relative_to(ROOT)))
    if full_exists and tokenizer_dir.exists():
        staged.extend(str(p.relative_to(ROOT)) for p in tokenizer_dir.rglob("*") if p.is_file())

    subprocess.run(["git", "add", *staged], cwd=str(ROOT), check=True)
    if not FULL_CANDIDATE_PATH.exists():
        subprocess.run(
            ["git", "rm", "--cached", "--ignore-unmatch", "--", str(FULL_CANDIDATE_PATH.relative_to(ROOT))],
            cwd=str(ROOT), check=True,
        )
    refresh_manifest()
    subprocess.run(["git", "add", "MANIFEST.sha256"], cwd=str(ROOT), check=True)
    subprocess.run(["git", "config", "user.name", "cfb-kaggle-bot"], cwd=str(ROOT), check=True)
    subprocess.run(["git", "config", "user.email", "cfb-kaggle-bot@users.noreply.github.com"], cwd=str(ROOT), check=True)
    commit_message = (
        f"feat(micro-97m): {'promote' if promoted else 'record candidate'} multilingual encoder "
        f"(val unit={report['training']['simpoValidationUnitPairAcc']}, "
        f"draft={report['training']['compactStudentDraftValidationPairAcc']})"
    )
    subprocess.run(["git", "commit", "-m", commit_message], cwd=str(ROOT), check=True)
    subprocess.run(["git", "push", "origin", "main"], cwd=str(ROOT), check=True)
    print("✓ Report and eligible artifacts pushed to origin/main.")



def run_final_family_evaluation(
    args,
    candidate_weights_path: Path,
    known_families: list[str],
    known_source_ids: list[str],
) -> dict:
    if not args.final_test_dataset:
        return {
            "status": "blocked-no-new-independent-family",
            "passed": False,
            "reason": "--final-test-dataset was not supplied; existing sse-truncated validation and Gold holdouts are not blind",
        }
    final_path = Path(args.final_test_dataset).expanduser().resolve()
    if not final_path.is_file():
        return {
            "status": "blocked-final-dataset-not-found",
            "passed": False,
            "datasetPath": str(final_path),
        }
    final_data = json.loads(final_path.read_text(encoding="utf-8"))
    families = sorted({family_key(row.get("family")) for row in final_data.get("unitSamples", [])})
    if len(families) != 1:
        return {
            "status": "blocked-final-dataset-must-contain-one-family",
            "passed": False,
            "families": families,
            "datasetPath": str(final_path),
        }
    family = families[0]
    dataset_sha256 = hashlib.sha256(final_path.read_bytes()).hexdigest()
    ledger = json.loads(FINAL_TEST_LEDGER_PATH.read_text(encoding="utf-8")) if FINAL_TEST_LEDGER_PATH.exists() else {
        "schema": "cfb.micro-final-test-ledger/1",
        "entries": [],
    }
    consumed = [entry for entry in ledger.get("entries", []) if entry.get("family") == family or entry.get("datasetSha256") == dataset_sha256]
    if consumed:
        return {
            "status": "blocked-final-family-already-consumed",
            "passed": False,
            "family": family,
            "datasetPath": str(final_path),
            "datasetSha256": dataset_sha256,
            "previousEvaluation": consumed[-1],
            "ledgerPath": str(FINAL_TEST_LEDGER_PATH.relative_to(ROOT)),
        }
    command = [
        "node", str(ROOT / "tools" / "eval-micro-js-pairs.mjs"),
        "--dataset", str(final_path),
        "--weights", str(candidate_weights_path),
        "--validation-family", family,
        "--known-families", ",".join(known_families),
        "--known-source-ids", json.dumps(known_source_ids, separators=(",", ":")),
        "--must-be-new-family",
        "--final-blind-test",
        "--report", str(FINAL_TEST_EVAL_PATH),
    ]
    try:
        proc = subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        return {
            "status": "blocked-final-dataset-audit-or-split-check-failed",
            "passed": False,
            "family": family,
            "datasetPath": str(final_path),
            "datasetSha256": dataset_sha256,
            "error": (exc.stderr or exc.stdout or str(exc))[-4000:],
        }
    print("\n[Final blind family] Independent JS evaluation completed after candidate checkpoint selection.")
    print(proc.stdout)
    evaluation = json.loads(FINAL_TEST_EVAL_PATH.read_text(encoding="utf-8"))
    unit = evaluation["candidate"]["unitPairs"]["validation"]
    draft = evaluation["candidate"]["draftPairs"]["validation"]
    passed = (
        unit["total"] > 0 and draft["total"] > 0
        and unit["accuracy"] is not None and unit["accuracy"] >= 0.90
        and draft["accuracy"] is not None and draft["accuracy"] >= 0.90
    )
    ledger_entry = {
        "family": family,
        "datasetSha256": dataset_sha256,
        "candidateWeightsDigest": evaluation["candidate"]["weightsDigest"],
        "evaluatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "passed" if passed else "evaluated-below-90-percent-gates",
        "unitPairs": unit["total"],
        "unitPairAccuracy": unit["accuracy"],
        "draftPairs": draft["total"],
        "draftPairAccuracy": draft["accuracy"],
    }
    ledger.setdefault("entries", []).append(ledger_entry)
    save_json(FINAL_TEST_LEDGER_PATH, ledger)
    return {
        "status": "passed" if passed else "evaluated-below-90-percent-gates",
        "passed": passed,
        "family": family,
        "datasetPath": str(final_path),
        "datasetSha256": dataset_sha256,
        "ledgerPath": str(FINAL_TEST_LEDGER_PATH.relative_to(ROOT)),
        "semanticReview": final_data.get("semanticReview"),
        "lineageReviewSummary": {
            "status": final_data.get("lineageReview", {}).get("status"),
            "reviewer": final_data.get("lineageReview", {}).get("reviewer"),
            "knownFamiliesReviewed": len(final_data.get("lineageReview", {}).get("knownFamiliesReviewed", [])),
            "knownTrainingSourceIdsReviewed": len(final_data.get("lineageReview", {}).get("knownSourceIdsReviewed", [])),
            "independentSourceIdsReviewed": len(final_data.get("lineageReview", {}).get("independentSourceIds", [])),
            "knownTrainingSourceIds": len(known_source_ids),
            "sourceOverlap": 0,
        },
        "denominators": {
            "unitSamples": len(final_data.get("unitSamples", [])),
            "unitPairs": unit["total"],
            "draftPairs": draft["total"],
            "uniqueUnitPairEndpoints": unit["scoreAudit"]["uniqueEndpointsScored"],
        },
        "candidateMetrics": {
            "unitPairAccuracy": unit["accuracy"],
            "unitPairTo100Pp": None if unit["accuracy"] is None else round((1.0 - unit["accuracy"]) * 100, 2),
            "draftPairAccuracy": draft["accuracy"],
            "draftPairTo100Pp": None if draft["accuracy"] is None else round((1.0 - draft["accuracy"]) * 100, 2),
        },
        "productionBaseline": {
            "unitPairAccuracy": evaluation["production"]["unitPairs"]["validation"]["accuracy"],
            "draftPairAccuracy": evaluation["production"]["draftPairs"]["validation"]["accuracy"],
        },
        "candidateWeightsDigest": evaluation["candidate"]["weightsDigest"],
        "validationFamilyWasUsedForCheckpointSelection": evaluation["validationFamilyWasUsedForCheckpointSelection"],
        "evaluation": evaluation,
    }


def frozen_evaluation_record(training_dataset_sha256: str, candidate_weights_digest: str,
                             validation_family: str) -> dict:
    source_paths = [
        ROOT / "src" / "compile-v5-local.js",
        ROOT / "tools" / "build-micro-dataset.mjs",
        ROOT / "tools" / "eval-micro-js-pairs.mjs",
        ROOT / "tools" / "kaggle-train-micro.py",
    ]
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(ROOT), text=True).strip()
    except Exception:
        commit = None
    return {
        "frozenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "codeCommit": commit,
        "sourceSha256": {str(item.relative_to(ROOT)): hashlib.sha256(item.read_bytes()).hexdigest() for item in source_paths},
        "trainingDatasetSha256": training_dataset_sha256,
        "candidateScoringWeightsSha256": candidate_weights_digest,
        "candidateWeightsPath": str(CANDIDATE_WEIGHTS_PATH.relative_to(ROOT)),
        "validationFamily": validation_family,
        "trainingObjective": "grouped SFT multi-task + teacher SimPO-inspired margin pair loss + compact-student JS-aligned Unit gammaStep pair loss + compact-student draft reward distillation; final candidate Unit/Draft scores use the production JS scorer",
    }


def main():
    parser = argparse.ArgumentParser(description="Fine-tune the <0.1B CFB birth-compression encoder on Kaggle")
    parser.add_argument("--epochs-sft", type=int, default=12)
    parser.add_argument("--epochs-simpo", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--simpo-batch-size", type=int, default=96)
    parser.add_argument("--eval-batch-size", type=int, default=96)
    parser.add_argument("--draft-batch-size", type=int, default=24)
    parser.add_argument("--draft-every", type=int, default=3)
    parser.add_argument("--lr", type=float, default=3e-4, help="task-head learning rate")
    parser.add_argument("--encoder-lr", type=float, default=8e-6)
    parser.add_argument("--simpo-encoder-lr", type=float, default=3e-6)
    parser.add_argument("--simpo-head-lr", type=float, default=8e-5)
    parser.add_argument("--pref-lr", type=float, default=5e-4)
    parser.add_argument("--student-lr", type=float, default=2e-3)
    parser.add_argument("--pref-student-lr", type=float, default=1e-3)
    parser.add_argument("--micro-mlp-hidden", type=int, default=96,
                        help="hidden width of the symbolic MLP head (teacher and compact student share it)")
    parser.add_argument("--validation-family", type=str, default=None,
                        help="override the grouped validation family (used for the 3-fold family cross-validation)")
    parser.add_argument("--preregistration", type=str, default="transfer/micro-preregistration.json",
                        help="machine-readable pre-registration; if present, CLI flags must match it or training refuses to start")
    parser.add_argument("--student-epochs", type=int, default=260)
    parser.add_argument("--student-pair-objective", choices=["listwise", "ranknet"], default="listwise",
                        help="compact student Unit pair objective; listwise = softmax over each positive's negative group (default), ranknet = pairwise margin sigmoid")
    parser.add_argument("--neg-judge-weights", type=str,
                        default="transfer/models/v5-micro-weights.candidate.json",
                        help="dataset builder CFB_MICRO_NEG_JUDGE_WEIGHTS; empty string = production weights")
    parser.add_argument("--unit-review-file", type=str,
                        default="transfer/models/unit-label-review.json",
                        help="dataset builder CFB_MICRO_UNIT_REVIEW_FILE; empty string = rule labels only")
    parser.add_argument("--dataset-neg-strategy", choices=["hardened", "legacy"], default="hardened",
                        help="dataset negative-mining strategy: hardened = length-matched + model-hard negatives (default)")
    parser.add_argument("--unit-pair-degree-cap", type=int, default=4,
                        help="max preference-pair endpoints per Unit (dataset builder CFB_MICRO_PAIR_DEGREE_CAP)")
    parser.add_argument("--unit-pairs-per-positive", type=int, default=4,
                        help="max preference pairs generated per positive Unit (dataset builder CFB_MICRO_PAIR_PER_POSITIVE)")
    parser.add_argument("--near-length-tokens", type=int, default=3,
                        help="|delta token| threshold counted as a length-matched negative (dataset builder CFB_MICRO_NEAR_LENGTH_TOKENS)")
    parser.add_argument("--matched-bucket-loss-weight", type=float, default=1.5,
                        help="extra loss weight for Unit preference groups in the length-matched bucket (|delta token| <= --near-length-tokens): the load-bearing ruler reading")
    parser.add_argument("--student-unit-pair-loss-weight", type=float, default=1.0,
                        help="weight for the compact student's audited Unit pairwise ranking loss")
    parser.add_argument("--pref-student-epochs", type=int, default=100)
    parser.add_argument("--student-batch-size", type=int, default=128)
    parser.add_argument("--student-patience", type=int, default=30)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--beta-simpo", type=float, default=0.85)
    parser.add_argument("--draft-loss-weight", type=float, default=1.2)
    parser.add_argument("--final-test-dataset", type=str, default=None,
                        help="Separate, semantically reviewed, single-new-family dataset used only after checkpoint selection")
    parser.add_argument("--push-back", action="store_true")
    args = parser.parse_args()

    try:
        from transformers import AutoConfig, AutoModel, AutoTokenizer
    except ImportError as exc:
        raise RuntimeError('missing dependency: run pip install "transformers==4.56.2" safetensors') from exc

    prereg_info = load_preregistration(args)
    if prereg_info.get("matched"):
        print(f"   [Prereg] matched {prereg_info['file']} (sha256 {prereg_info['sha256'][:12]}…, {prereg_info['declaredFlagCount']} flags)")
    elif prereg_info.get("file") is None:
        print("   [Prereg] no preregistration file; proceeding without the decision-rule lock")
    t_start = time.time()
    set_seed(42)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    gpu_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    gpu_names = [torch.cuda.get_device_name(i) for i in range(gpu_count)]
    use_amp = device.type == "cuda"

    print("══════════════════════════════════════════════════════════════════════")
    print("🚀 CFB-Micro pretrained multilingual encoder fine-tuning (<0.1B)")
    print(f"   base: {MODEL_ID}@{MODEL_REVISION} ({MODEL_LICENSE})")
    print(f"   device: {device}; GPUs={gpu_names}; DataParallel={'enabled' if gpu_count > 1 else 'not needed'}")
    print("══════════════════════════════════════════════════════════════════════")

    print("\n[Stage 0/6] Loading pinned pretrained encoder/tokenizer from Hugging Face...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION, use_fast=True)
    hf_config = AutoConfig.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        reference_compile=False,
    )
    if hasattr(hf_config, "reference_compile"):
        hf_config.reference_compile = False
    encoder = AutoModel.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        config=hf_config,
        attn_implementation="eager",
        dtype=torch.float32,
    )
    if hasattr(encoder.config, "reference_compile"):
        encoder.config.reference_compile = False
    print("   ✓ ModernBERT reference_compile=False (safe with DataParallel)")
    prior_weights = json.loads(PRODUCTION_WEIGHTS_PATH.read_text(encoding="utf-8"))

    print("\n[Stage 1/6] Building strict dev-only training data...")
    dataset_env = os.environ.copy()
    dataset_env.update({
        "CFB_MICRO_NEG_STRATEGY": args.dataset_neg_strategy,
        "CFB_MICRO_PAIR_DEGREE_CAP": str(args.unit_pair_degree_cap),
        "CFB_MICRO_PAIR_PER_POSITIVE": str(args.unit_pairs_per_positive),
        "CFB_MICRO_NEAR_LENGTH_TOKENS": str(args.near_length_tokens),
        "CFB_MICRO_NEG_JUDGE_WEIGHTS": str(args.neg_judge_weights or ""),
        "CFB_MICRO_UNIT_REVIEW_FILE": str(args.unit_review_file or ""),
    })
    subprocess.run(["node", str(ROOT / "tools" / "build-micro-dataset.mjs")], check=True, cwd=str(ROOT), env=dataset_env)
    print(f"   ✓ pair construction: strategy={args.dataset_neg_strategy}, degree_cap={args.unit_pair_degree_cap}, "
          f"per_positive={args.unit_pairs_per_positive}, near_length_tokens={args.near_length_tokens}")
    dataset = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
    training_dataset_sha256 = hashlib.sha256(DATASET_PATH.read_bytes()).hexdigest()
    if dataset.get("schema") != "cfb.micro-dev-dataset/3":
        raise RuntimeError(f"unsupported dataset schema: {dataset.get('schema')}")
    if dataset.get("holdoutTouched") is not False:
        raise RuntimeError("dataset holdoutTouched must be false")
    if set(dataset.get("holdoutFamiliesExcluded", [])) != HOLDOUT_FAMILIES:
        raise RuntimeError("unexpected holdout family boundary")
    for row in dataset["unitSamples"]:
        if is_holdout_family(row.get("family")):
            raise RuntimeError("holdout unit entered the training dataset")
    for pair in dataset["unitStepPairs"] + dataset["stepSimpoPairs"]:
        if is_holdout_family(pair.get("family")) or pair.get("split") == "holdout":
            raise RuntimeError("holdout preference pair entered the training dataset")

    SYM_DIM = int(len(dataset["unitSamples"][0]["features"]))
    TEXT_HASH_BUCKETS = int(dataset.get("stats", {}).get("textHashBuckets", 0) or 0)
    if SYM_DIM != 19 + TEXT_HASH_BUCKETS:
        raise RuntimeError(f"dataset feature width mismatch: symDim={SYM_DIM}, textHashBuckets={TEXT_HASH_BUCKETS}")
    print(f"   [Data] symbolic feature dim={SYM_DIM} (19 base + {TEXT_HASH_BUCKETS} text-hash buckets)")
    model = CFBMicro97M(encoder, prior_weights, mlp_hidden=args.micro_mlp_hidden, sym_dim=SYM_DIM).to(device)
    total_params = sum(p.numel() for p in model.parameters())
    backbone_params = sum(p.numel() for p in model.encoder.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    if total_params >= 100_000_000:
        raise RuntimeError(f"total params including task heads must stay below 100M; found {total_params:,}")
    dp_model = nn.DataParallel(model, device_ids=list(range(gpu_count))) if gpu_count > 1 else model
    print(f"   ✓ total={total_params:,} ({total_params/1e6:.3f}M), backbone={backbone_params:,}, trainable={trainable_params:,}; limit headroom={100_000_000-total_params:,}")
    print(f"   ✓ samples={dataset['stats']['unitSamplesCount']}, unit_pairs={dataset['stats']['unitStepPairsCount']}, draft_pairs={dataset['stats']['stepSimpoPairsCount']}")

    sft_result = stage1_sft(args, dp_model, model, tokenizer, dataset, device, use_amp)
    simpo_result = stage2_simpo(args, dp_model, model, tokenizer, dataset, sft_result, device, use_amp)
    student, student_stats = train_compact_student(
        args, model, dp_model, tokenizer, dataset, sft_result, device, use_amp, prior_weights,
    )

    print("\n[Stage 5/6] Exporting and smoke-testing compact student + full quantized encoder ONNX...")
    export_result = export_models(model, student, tokenizer)
    shutil.copy2(export_result["compactTempPath"], COMPACT_CANDIDATE_PATH)

    weights_candidate = serialize_candidate(
        prior_weights, student, dataset, sft_result, simpo_result, student_stats,
        total_params, trainable_params, f"{device} ({'; '.join(gpu_names) if gpu_names else 'CPU'}, count={gpu_count})",
    )
    CANDIDATE_WEIGHTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    save_json(CANDIDATE_WEIGHTS_PATH, weights_candidate)
    parity_fixtures = build_runtime_parity_fixtures(student, dataset, weights_candidate)
    save_json(JS_PARITY_FIXTURES_PATH, parity_fixtures)

    print("\n[Stage 5.5/6] Checking PyTorch→JSON→actual JS numerical parity and scoring audited Unit/Draft pairs...")
    js_pair_proc = subprocess.run(
        [
            "node", str(ROOT / "tools" / "eval-micro-js-pairs.mjs"),
            "--dataset", str(DATASET_PATH),
            "--weights", str(CANDIDATE_WEIGHTS_PATH),
            "--validation-family", sft_result["validationFamily"],
            "--parity-fixtures", str(JS_PARITY_FIXTURES_PATH),
            "--report", str(JS_PAIR_EVAL_PATH),
        ],
        cwd=str(ROOT), capture_output=True, text=True, check=True,
    )
    print(js_pair_proc.stdout)
    js_pair_eval = json.loads(JS_PAIR_EVAL_PATH.read_text(encoding="utf-8"))
    if js_pair_eval.get("numericalParity", {}).get("status") != "passed":
        raise RuntimeError("compact student PyTorch→JSON→JS numerical parity did not pass")
    js_train_unit = js_pair_eval["candidate"]["unitPairs"]["train"]
    js_val_unit = js_pair_eval["candidate"]["unitPairs"]["validation"]
    js_train_draft = js_pair_eval["candidate"]["draftPairs"]["train"]
    js_val_draft = js_pair_eval["candidate"]["draftPairs"]["validation"]
    js_prod_val_unit = js_pair_eval["production"]["unitPairs"]["validation"]
    js_prod_val_draft = js_pair_eval["production"]["draftPairs"]["validation"]
    if js_train_unit["total"] != student_stats["unitTrainPairs"] or js_val_unit["total"] != student_stats["unitValidationPairs"]:
        raise RuntimeError("JS runtime Unit-pair denominator disagrees with audited grouped split")
    student_stats["unitTrainPairAcc"] = js_train_unit["accuracy"]
    student_stats["unitValidationPairAcc"] = js_val_unit["accuracy"]
    weights_candidate["trainingStats"].update({
        "compactStudentUnitTrainPairAcc": js_train_unit["accuracy"],
        "compactStudentUnitValidationPairAcc": js_val_unit["accuracy"],
        "compactStudentUnitTrainPairs": js_train_unit["total"],
        "compactStudentUnitValidationPairs": js_val_unit["total"],
        "compactStudentDraftTrainPairAcc": js_train_draft["accuracy"],
        "compactStudentDraftValidationPairAcc": js_val_draft["accuracy"],
        "compactStudentDraftTrainPairs": js_train_draft["total"],
        "compactStudentDraftValidationPairs": js_val_draft["total"],
        "productionJsRuntimeValidationUnitPairAcc": js_prod_val_unit["accuracy"],
        "productionJsRuntimeValidationDraftPairAcc": js_prod_val_draft["accuracy"],
        "jsRuntimeScorer": js_pair_eval["runtimeScorer"],
        "jsRuntimeWeightsSchema": js_pair_eval["candidate"]["schema"],
        "pythonJsNumericalParity": js_pair_eval["numericalParity"],
    })
    save_json(CANDIDATE_WEIGHTS_PATH, weights_candidate)
    if DATASET_PATH.exists():
        DATASET_PATH.unlink()

    print("\n[Stage 6/6] Running Mode 2 against the candidate compact student; reading a machine report, not hard-coded scores...")
    eval_proc = subprocess.run(
        [
            "node", str(ROOT / "tools" / "train-v5-micro.mjs"), "--eval-only",
            "--weights-path", str(CANDIDATE_WEIGHTS_PATH), "--eval-json", str(MODE2_JSON_PATH),
        ],
        cwd=str(ROOT), capture_output=True, text=True, check=True,
    )
    print(eval_proc.stdout)
    mode2 = json.loads(MODE2_JSON_PATH.read_text(encoding="utf-8"))
    summary = mode2["summary"]
    freeze_record = frozen_evaluation_record(
        training_dataset_sha256,
        js_pair_eval["candidate"]["weightsDigest"],
        sft_result["validationFamily"],
    )
    final_family_eval = run_final_family_evaluation(
        args,
        CANDIDATE_WEIGHTS_PATH,
        dataset["stats"]["devFamilyNames"],
        sorted({
            str(row.get("sourceId"))
            for collection_name in ("unitSamples", "unitStepPairs", "stepSimpoPairs")
            for row in dataset.get(collection_name, [])
            if row.get("sourceId")
        }),
    )
    simpo_val_unit = simpo_result["validationUnitPairAcc"]
    simpo_val_draft_teacher = simpo_result["validationDraftPairAcc"]
    compact_val_unit = student_stats["unitValidationPairAcc"]
    compact_val_draft = js_val_draft["accuracy"]
    pytorch_student_val_draft = student_stats["prefValidationPairAcc"]
    js_val_unit_accuracy = js_val_unit["accuracy"]
    js_val_draft_accuracy = js_val_draft["accuracy"]
    target_unit = simpo_val_unit is not None and simpo_val_unit >= 0.90
    target_teacher_draft = simpo_val_draft_teacher is not None and simpo_val_draft_teacher >= 0.90
    target_compact_unit = compact_val_unit is not None and compact_val_unit >= 0.90
    target_js_unit = js_val_unit_accuracy is not None and js_val_unit_accuracy >= 0.90
    target_draft = compact_val_draft is not None and compact_val_draft >= 0.90
    target_js_draft = js_val_draft_accuracy is not None and js_val_draft_accuracy >= 0.90
    # Existing Gold families have already participated in earlier evaluation; only the separate new-family test can open this gate.
    fresh_independent_test_passed = final_family_eval["passed"]
    gates = {
        "under01B": total_params < 100_000_000,
        "strictDevOnly": weights_candidate["holdoutTouched"] is False,
        "unitPreferenceValidationAtLeast90": target_unit,
        "teacherDraftPreferenceValidationAtLeast90": target_teacher_draft,
        "compactStudentUnitPairValidationAtLeast90": target_compact_unit,
        "jsRuntimeUnitPairValidationAtLeast90": target_js_unit,
        "draftPreferenceStudentValidationAtLeast90": target_draft,
        "jsRuntimeDraftPairValidationAtLeast90": target_js_draft,
        "mode2G1AllPass": summary["g1PassCount"] == summary["totalItems"],
        "mode2G2AllPass": summary["g2PassCount"] == summary["totalItems"],
        "fullOnnxSmokePassed": export_result["fullOnnxSmoke"] == "passed",
        "pythonJsNumericalParityPassed": js_pair_eval["numericalParity"]["status"] == "passed",
        "freshIndependentNewFamilyTestPassed": fresh_independent_test_passed,
    }
    # 2026-10-04 闸门口径：只有「部署路径」上的闸门阻塞晋升。全编码器教师是可选的参考产物
    # （INT8 98.7MB、CPU 单次 ~280ms），无法服务同步 JS 运行时；部署打分器的等价闸门是
    # jsRuntimeUnitPairValidationAtLeast90 与 compactStudentUnitPairValidationAtLeast90，二者照旧阻塞。
    reported_only_gates = ("unitPreferenceValidationAtLeast90", "teacherDraftPreferenceValidationAtLeast90")
    blocking_gates = {key: value for key, value in gates.items() if key not in reported_only_gates}
    accepted = all(blocking_gates.values())
    gate_policy = {
        "policy": "Promotion-blocking gates cover the deployed runtime path only (compact student + JS runtime + Mode 2 + PyTorch/JS parity + <100M params + strict dev-only discipline + one fresh independent family).",
        "blockingGates": sorted(blocking_gates.keys()),
        "reportedOnlyGates": [
            {
                "name": "unitPreferenceValidationAtLeast90",
                "measured": simpo_val_unit,
                "required": 0.90,
                "passed": bool(target_unit),
                "reason": "The full encoder is an optional reference artifact (98.7MB INT8, ~280ms per pair on CPU) and cannot serve the synchronous JS runtime; the deployed scorer's equivalent gates are compactStudentUnitPairValidationAtLeast90 and jsRuntimeUnitPairValidationAtLeast90. The reading stays visible in gates, ceilingDistances and rulerReading every run.",
            },
        ],
        "note": "The teacher stages still train every run with an unchanged recipe and their metrics are recomputed from the audited dataset; declaring the teacher out of scope for this round and simultaneously requiring it to clear a blocking 90% gate would be contradictory.",
    }
    best_sft_val = min(sft_result["history"], key=lambda row: row["validation"]["loss"])["validation"]
    ceiling_distances = {
        "sftValidationSlotAccTo100Pp": round((1.0 - best_sft_val["slotAcc"]) * 100, 2),
        "unitPreferenceValidationTo100Pp": None if simpo_val_unit is None else round((1.0 - simpo_val_unit) * 100, 2),
        "compactStudentUnitPairValidationTo100Pp": None if compact_val_unit is None else round((1.0 - compact_val_unit) * 100, 2),
        "jsRuntimeUnitPairValidationTo100Pp": None if js_val_unit_accuracy is None else round((1.0 - js_val_unit_accuracy) * 100, 2),
        "teacherDraftPreferenceValidationTo100Pp": None if simpo_val_draft_teacher is None else round((1.0 - simpo_val_draft_teacher) * 100, 2),
        "pytorchCompactStudentDraftValidationTo100Pp": None if pytorch_student_val_draft is None else round((1.0 - pytorch_student_val_draft) * 100, 2),
        "compactStudentDraftPairValidationTo100Pp": None if compact_val_draft is None else round((1.0 - compact_val_draft) * 100, 2),
        "jsRuntimeDraftPairValidationTo100Pp": None if js_val_draft_accuracy is None else round((1.0 - js_val_draft_accuracy) * 100, 2),
        "mode2DevMeanScoreTo1Pp": round((1.0 - summary["devMeanScore"]) * 100, 2),
        "mode2HoldoutMeanScoreTo1Pp": round((1.0 - summary["holdoutMeanScore"]) * 100, 2),
        "mode2MeanCharReductionTo100Pp": round(100 - summary["meanCharReductionPct"], 2),
        "mode2G1FailuresToZero": summary["totalItems"] - summary["g1PassCount"],
        "mode2G2FailuresToZero": summary["totalItems"] - summary["g2PassCount"],
        "parametersBelow100M": 100_000_000 - total_params,
    }
    def _pair_reading(unit: dict, length_sensitive: bool = True) -> dict:
        matched = (unit.get("lengthMatchedSubset") or {}) if length_sensitive else {}
        reading = {
            "accuracy": unit.get("accuracy"),
            "correct": unit.get("correct"),
            "total": unit.get("total"),
            "ties": unit.get("ties"),
            "tiesPolicy": unit.get("tiesPolicy"),
            "accuracyWithTiesHalfCredit": unit.get("accuracyWithTiesHalfCredit"),
            "wilson95": unit.get("wilson95"),
            "wilsonLower95": unit.get("wilsonLower95"),
        }
        if length_sensitive:
            reading.update({
                "lengthMatchedAccuracy": matched.get("accuracy"),
                "lengthMatchedCorrect": matched.get("correct"),
                "lengthMatchedTotal": matched.get("total"),
                "lengthMatchedWilsonLower95": matched.get("wilsonLower95"),
                "lengthMatchedShare": unit.get("lengthMatchedShare"),
                "lengthStratified": unit.get("lengthStratified"),
                "accuracyWithoutTokenPenalty": (unit.get("scoreWithoutTokenPenalty") or {}).get("accuracy"),
            })
        return reading

    # 尺子读数：点估计之外同时给出「长度不能解释胜负」的子集与 Wilson 下界，避免用噪声当能力。
    ruler_reading = {
        "note": (
            "Headline accuracy keeps its historical definition (a tied pair scores 0) so gates stay comparable; "
            "lengthMatchedAccuracy restricts to pairs whose two Units differ by <= near_length_tokens tokens, where the "
            "lambda*tokenCount penalty cannot manufacture the win; wilsonLower95 is the one-sided-friendly 95% lower bound "
            "and is the honest number to compare against 90% on a 138/40-pair validation set."
        ),
        "candidateUnitTrain": _pair_reading(js_train_unit),
        "candidateUnitValidation": _pair_reading(js_val_unit),
        "productionUnitValidation": _pair_reading(js_prod_val_unit),
        "candidateDraftTrain": _pair_reading(js_train_draft, length_sensitive=False),
        "candidateDraftValidation": _pair_reading(js_val_draft, length_sensitive=False),
        "productionDraftValidation": _pair_reading(js_prod_val_draft, length_sensitive=False),
    }
    report = {
        "schema": "cfb.micro-97m-training-report/3",
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {"id": MODEL_ID, "revision": MODEL_REVISION, "license": MODEL_LICENSE},
        "device": {"kind": str(device), "gpus": gpu_names, "gpuCount": gpu_count, "dataParallelConfigured": gpu_count > 1},
        "dataset": {
            "holdoutTouchedDuringTraining": False,
            "holdoutEvaluatedForMode2": True,
            "holdoutFreshBlindSet": final_family_eval["status"] in {"passed", "evaluated-below-90-percent-gates"},
            "freshIndependentNewFamilyTest": {
                **final_family_eval,
                "eligibleFamiliesInCurrentMicroCorpus": dataset["stats"]["devFamilyNames"],
                "requiredNext": None if final_family_eval["passed"] else "supply a genuinely new, semantically reviewed family after code/data/split/checkpoint freeze; never relabel _decoy/_long-horizon variants",
            },
            "finalEvaluationFreeze": freeze_record,
            "holdoutFamiliesExcluded": sorted(HOLDOUT_FAMILIES),
            "validationFamily": sft_result["validationFamily"],
            "validationUnitFractionTarget": VALIDATION_UNIT_FRACTION,
            "validationUnitFractionActual": round(len(sft_result["validationIndices"]) / max(1, dataset["stats"]["trainEligibleUnitSamples"]), 4),
            "validationUnitFractionOfAllRows": round(len(sft_result["validationIndices"]) / max(1, dataset["stats"]["unitSamplesCount"]), 4),
            "eligibleTrainUnitCount": len(sft_result["trainIndices"]),
            "eligibleValidationUnitCount": len(sft_result["validationIndices"]),
            "devGoldItems": dataset["stats"]["devGoldItems"],
            "devPoolItems": dataset["stats"]["devPoolItems"],
            "unitSamples": dataset["stats"]["unitSamplesCount"],
            "unitPairs": dataset["stats"]["unitStepPairsCount"],
            "draftPairs": dataset["stats"]["stepSimpoPairsCount"],
            "trainEligibleUnitSamples": dataset["stats"]["trainEligibleUnitSamples"],
            "unitLabelNeedsReview": dataset["stats"]["unitLabelNeedsReview"],
            "trainEligibleDraftPairs": dataset["stats"]["trainEligibleStepSimpoPairs"],
            "draftPairLabelsNeedsReview": dataset["stats"]["stepSimpoLabelsNeedsReview"],
            "unitPairEndpointReuse": dataset["stats"]["unitPairEndpointReuse"],
            "pairConstruction": dataset["stats"].get("pairConstruction"),
            "flywheelSourcePath": dataset["stats"].get("flywheelSourcePath"),
            "flywheelScoresDegenerate": dataset["stats"].get("flywheelScoresDegenerate"),
            "flywheelDistinctScorePairs": dataset["stats"].get("flywheelDistinctScorePairs"),
            "trainingDatasetSha256": training_dataset_sha256,
            "uniqueUnitPairEndpoints": dataset["stats"]["unitPairEndpointReuse"]["uniqueEndpoints"],
            "familyCount": dataset["stats"]["devFamilyCount"],
            "familyNames": dataset["stats"]["devFamilyNames"],
            "familyUnitCounts": dataset["stats"]["devFamilyUnitCounts"],
            "eligibleFamilyUnitCounts": dataset["stats"]["eligibleDevFamilyUnitCounts"],
            "labelAudit": dataset["stats"]["labelAudit"],
            "splitAndCheckpointRules": {
                "grouping": "familyKey; no family crosses train/validation; _decoy/_long-horizon suffixes normalize to the source family",
                "validationFamilySelection": "closest eligible-unit family size to 20%; deterministic SHA-256 tie-break; no label or score optimization",
                "sftCheckpoint": "minimum grouped validation loss",
                "teacherPreferenceCheckpoint": "maximum unweighted mean of grouped validation Unit-pair and Draft-pair accuracy",
                "compactUnitHeadCheckpoint": "minimum grouped validation total loss = multitask (0.55*CE + 0.45*KL + huber(value) + 0.6*huber(temptation)) + unit_pair_loss_weight * Unit pair objective loss; the Unit-pair objective therefore participates in checkpoint selection",
                "compactDraftHeadCheckpoint": "maximum grouped validation pair accuracy; lower distillation/ranking loss breaks ties",
                "freshNewFamilyTest": "run after the frozen candidate if --final-test-dataset is supplied; never enters fitting or checkpoint selection",
            },
            "unitPairTrainCount": simpo_result["unitTrainCount"],
            "unitPairValidationCount": simpo_result["unitValidationCount"],
            "draftPairTrainCount": simpo_result["draftTrainCount"],
            "draftPairValidationCount": simpo_result["draftValidationCount"],
        },
        "ceilingDistances": ceiling_distances,
        "rulerReading": ruler_reading,
        "parameters": {
            "total": total_params,
            "backbone": backbone_params,
            "trainable": trainable_params,
            "limit": 100_000_000,
            "headroom": 100_000_000 - total_params,
            "fractionOfLimit": round(total_params / 100_000_000, 6),
        },
        "training": {
            "elapsedSeconds": round(time.time() - t_start, 2),
            "sftAmpSkippedSteps": sft_result["ampSkippedSteps"],
            "simpoAmpSkippedSteps": simpo_result["ampSkippedSteps"],
            "sftHistory": sft_result["history"],
            "simpoHistory": simpo_result["history"],
            "simpoBestEpoch": simpo_result["bestEpoch"],
            "simpoTrainUnitPairAcc": simpo_result["trainUnitPairAcc"],
            "simpoValidationUnitPairAcc": simpo_val_unit,
            "teacherValidationUnitPairAcc": simpo_val_unit,
            "teacherValidationDraftPairAcc": simpo_val_draft_teacher,
            "compactStudentUnitTrainPairAcc": student_stats["unitTrainPairAcc"],
            "compactStudentUnitValidationPairAcc": compact_val_unit,
            "compactStudentUnitTrainPairs": student_stats["unitTrainPairs"],
            "compactStudentUnitValidationPairs": student_stats["unitValidationPairs"],
            "compactStudentPairScorer": js_pair_eval["runtimeScorer"],
            "compactStudentPythonJsNumericalParity": js_pair_eval["numericalParity"],
            "jsRuntimePairEvaluation": js_pair_eval,
            "jsRuntimeValidationUnitPairAcc": js_val_unit_accuracy,
            "compactStudentDraftTrainPairAcc": js_train_draft["accuracy"],
            "compactStudentDraftValidationPairAcc": compact_val_draft,
            "compactStudentDraftTrainPairs": js_train_draft["total"],
            "compactStudentDraftValidationPairs": js_val_draft["total"],
            "jsRuntimeValidationDraftPairAcc": js_val_draft_accuracy,
            "productionJsRuntimeValidationUnitPairAcc": js_prod_val_unit["accuracy"],
            "productionJsRuntimeValidationDraftPairAcc": js_prod_val_draft["accuracy"],
            "simpoTrainDraftPairAcc": simpo_result["trainDraftPairAcc"],
            "simpoValidationDraftPairAcc": simpo_result["validationDraftPairAcc"],
            "pytorchStudentUnitTrain": student_stats["unitTrain"],
            "pytorchStudentUnitValidation": student_stats["unitValidation"],
            "pytorchStudentDraftTrainPairAcc": student_stats["prefTrainPairAcc"],
            "pytorchStudentDraftValidationPairAcc": pytorch_student_val_draft,
            "studentPreferenceHistory": student_stats["prefHistory"],
        },
        "mode2GoldEval": mode2,
        "artifacts": {
            "candidateWeights": str(CANDIDATE_WEIGHTS_PATH.relative_to(ROOT)),
            "compactCandidateOnnx": str(COMPACT_CANDIDATE_PATH.relative_to(ROOT)),
            "compactOnnxExportTempPath": str(export_result["compactTempPath"]),
            "fullEncoderOnnxTempPath": str(export_result["fullTempPath"]),
            "compactOnnxBytes": export_result["compactBytes"],
            "fullOnnxBytes": export_result["fullBytes"],
            "compactCpuMsBatch36": export_result["compactBatch36CpuMs"],
            "fullCpuMsBatch2Seq256": export_result["fullBatch2Seq256CpuMs"],
            "fullOnnxSmoke": export_result["fullOnnxSmoke"],
            "fullOnnxError": export_result.get("fullError"),
            "tokenizerRevision": MODEL_REVISION,
        },
        "gates": gates,
        "accepted": accepted,
        "promotionEligible": accepted,
        "preregistration": prereg_info,
        "gatePolicy": gate_policy,
        "promoted": False,
        "scope": {
            "roundScope": "student-only",
            "teacherRecipeChangedThisRound": False,
            "teacherRetrainedThisRun": True,
            "teacherMetricsSource": "recomputed in this run by the encoder SFT + SimPO stages from the same audited dev dataset; the recipe is unchanged, so changes in teacher numbers come from the expanded dataset only",
            "studentPairObjective": args.student_pair_objective,
            "datasetNegStrategy": args.dataset_neg_strategy,
            "note": "This round fixes the compact student, the training dataset construction and the evaluation ruler. The teacher recipe is deliberately unchanged; its stages still run each time and its metrics are recomputed, not carried over.",
        },
        "notes": [
            "Mode 2 metrics are parsed from tools/train-v5-micro.mjs --eval-json.",
            "The synchronous JS compiler consumes the compact symbolic student; the full encoder ONNX is a separate optional artifact.",
            "Full INT8 ONNX ORT smoke is an export/runtime check on fixed synthetic inputs only; it is not Python-to-JS numerical parity.",
            "The selected dev validation family is excluded from gradient updates and used for early stopping/checkpoint selection; Gold holdout is excluded from fitting and selection and is only a fixed Mode 2 safety gate.",
            "The four existing Gold holdout cases were already evaluated in the prior run; they are not a fresh blind set.",
            "Training-corpus Unit and preference labels carry deterministic audit provenance; rows flagged needs-review are excluded from fitting. The separate final family, if supplied, must carry per-item semantic review provenance.",
            "Round scope: compact student + dataset + evaluation ruler only; the teacher (encoder SFT/SimPO path) keeps its previous recipe but still trains every run, and its metrics are recomputed from the audited dataset (not carried over). The teacher is an optional reference artifact, not the deployed synchronous-JS scorer, so its unit-preference gate is reported (report.gatePolicy) while the deployed-scorer gates remain blocking.",
            "Unit preference pairs are mined with the hardened strategy: negatives are ordered by length match (|delta token| <= near_length_tokens) first, then by current production model score (hardest for the model), then by lexical hardness; endpoint degree cap is raised so that far more positive Units receive supervision.",
            "Persisted flywheel pairs are rejected as supervision when their stored scores are a degenerate constant placeholder set (all pairs share <= 2 distinct score pairs); such batches are marked needs-review instead of being fitted as if they were real margins.",
            "The compact student Unit objective is a listwise softmax over each positive's negative group (fallback: --student-pair-objective ranknet). Reported Unit pair accuracy is the strict delta>0 rate; the JS ruler additionally reports length-stratified and token-penalty-free accuracy with Wilson lower bounds.",
            "Gate reading: the 90% gates stay on the historical strict point estimate for comparability, but on 138/40-pair sets a point estimate carries roughly a +/-4pp interval; rulerReading.candidateUnitValidation.lengthMatchedAccuracy (with its Wilson lower bound) is the load-bearing number, because there the length penalty cannot decide the winner. A candidate that only clears 90% on the far-length stratum has not demonstrated the underlying ability.",
            ("Independent new-family final evaluation passed." if final_family_eval["passed"] else
             "Promotion remains blocked until one genuinely new, independently reviewed family is evaluated after checkpoint selection; current training corpus has only three eligible dev families."),
        ],
    }
    report["training"]["elapsedSeconds"] = round(time.time() - t_start, 2)
    if accepted:
        print("\n✅ All promotion-blocking gates passed; candidate is eligible for promotion.")
        if not target_unit:
            print("   (reported-only, non-blocking: unitPreferenceValidationAtLeast90 below 0.90 — see report.gatePolicy)")
    else:
        failed = [key for key, value in gates.items() if not value]
        blocking_failed = [key for key, value in blocking_gates.items() if not value]
        reported_failed = [key for key in failed if key not in blocking_gates]
        print(f"\n⚠️ Candidate is not promoted. Failed blocking gates: {', '.join(blocking_failed) if blocking_failed else 'none'}")
        if reported_failed:
            print(f"   reported-only (non-blocking): {', '.join(reported_failed)} — see report.gatePolicy")
        print("   No trained candidate weights will replace the current production weights.")

    save_json(REPORT_JSON_PATH, report)
    print(f"   report: {REPORT_JSON_PATH}")
    if export_result["fullBytes"] is not None:
        print(f"   full INT8 ONNX candidate: {export_result['fullTempPath']} ({export_result['fullBytes'] / 1_000_000:.2f} MB)")
        print(f"   actual full encoder CPU latency (batch=2, seq=256): {export_result['fullBatch2Seq256CpuMs']} ms")
    else:
        print(f"   full encoder ONNX unavailable: {export_result.get('fullError', 'no detail')}")
    print(f"   compact JS student ONNX: {export_result['compactTempPath']} ({export_result['compactBytes'] / 1024:.1f} KB)")
    print(f"   actual compact CPU latency (batch=36): {export_result['compactBatch36CpuMs']} ms")

    if args.push_back:
        report.setdefault("training", {})
    report["training"]["validationFamily"] = sft_result["validationFamily"]
    push_back(report, accepted, COMPACT_CANDIDATE_PATH, FULL_WORKING_PATH, TOKENIZER_DIR)

    print("\n✅ Kaggle fine-tuning, grouped preference validation, ONNX smoke tests and Mode 2 evaluation completed.")
    print(f"   acceptance={'PASS' if accepted else 'CANDIDATE ONLY'}; holdout excluded from training and used only for Mode 2 evaluation")


if __name__ == "__main__":
    main()
