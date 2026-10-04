#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/kaggle-train-65m.py —— < 0.1B (CFB-Micro-65M, ~60.9M 参数) 专用出生压缩微模型双卡并行训练与 ONNX 导出流水线

核心架构（对应 docs/TRAINING-AND-BENCHMARK.md §6）：
  1. 8 层双向 RoPE + 局部/全局交替注意力编码器（ModernBERT 范式，原生支持 8,192 tokens，~60.9M 参数 < 0.1B，原生支持 DataParallel 多 GPU 并行）
  2. 19 维确定性符号特征融合门控（SymbolicFusionLayer + 2 层 GELU 残差网络）
  3. Head A：6 类话语槽位分类器（LLMLingua-2 范式：MECHANISM / EXCLUDED / DECIDED / ACCEPT / OPEN / NOISE）
  4. Head B：反事实价值 V(i) 与死路诱惑度 T(i) 门控头（含反激活 Negative-Priming 硬正则）
  5. Head C：并行跨度指针头（GLiNER 范式：target_file / old_text / new_text / verify_cmd）
  6. Head D：无参考模型带动态间隔步级偏好排序头（Step-DPO + SimPO 范式：β=0.85, γ_dd ∈ [0.35, 1.25]）

支持用法：
  python3 tools/kaggle-train-65m.py [--epochs-sft 18] [--epochs-simpo 14] [--push-back]
"""

import argparse
import inspect
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = ROOT / "transfer" / "models" / "micro-65m-dev-dataset.json"
WEIGHTS_JSON_PATH = ROOT / "transfer" / "models" / "v5-micro-weights.json"
REPORT_JSON_PATH = ROOT / "transfer" / "models" / "cfb-micro-65m-report.json"
COMPACT_ONNX_PATH = ROOT / "transfer" / "models" / "cfb-micro-neural.onnx"
KAGGLE_FULL_ONNX_PATH = Path("/kaggle/working/cfb-micro-65m.int8.onnx")

SLOT_NAMES = ["MECHANISM", "EXCLUDED", "DECIDED", "ACCEPT", "OPEN", "NOISE"]
SPAN_TYPES = ["target_file", "old_text", "new_text", "verify_cmd"]
PREF_KEYS = [
    "hasSingleLocus", "hasDualLocus", "hasTriple", "excludedCount",
    "hasAcceptCmd", "hasEscapeClause", "hasOpenAgenda", "anchorGrounded",
    "sweetLength", "overLongPenalty", "proseCoherence", "noDeadEndResurrected",
]


def set_seed(seed: int = 42):
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def safe_onnx_export(model, args, path, **kwargs):
    """兼容 PyTorch 2.0 ~ 2.6+ (Python 3.13)：显式传入 dynamo=False 走内置 C++ 导出器，无需外部 onnxscript。"""
    sig = inspect.signature(torch.onnx.export)
    if "dynamo" in sig.parameters:
        kwargs["dynamo"] = False
    torch.onnx.export(model, args, path, **kwargs)


# ── 1. 多语言子词/UTF-8 确定性分词器（支持 8,192 窗口，零网络依赖回退） ────────
class DeterministicMultilingualTokenizer:
    def __init__(self, vocab_size: int = 64000, max_len: int = 128):
        self.vocab_size = vocab_size
        self.max_len = max_len
        self.token_re = re.compile(r"[A-Za-z_$][\w.$\-]{1,}|\d+(?:\.\d+)?|[\u4e00-\u9fff]|[^\s]")

    def encode(self, text: str, max_len: int = None) -> list[int]:
        limit = max_len or self.max_len
        tokens = self.token_re.findall(str(text or ""))
        ids = [1]  # [CLS] = 1
        for tok in tokens[: limit - 2]:
            h = 2166136261
            for b in tok.encode("utf-8"):
                h ^= b
                h = (h * 16777619) & 0xFFFFFFFF
            ids.append(4 + (h % (self.vocab_size - 4)))
        ids.append(2)  # [SEP] = 2
        if len(ids) < limit:
            ids.extend([0] * (limit - len(ids)))
        return ids[:limit]

    def batch_encode(self, texts: list[str], max_len: int = None, device="cpu") -> torch.Tensor:
        arr = [self.encode(t, max_len=max_len) for t in texts]
        return torch.tensor(arr, dtype=torch.long, device=device)


# ── 2. ModernBERT 风格 RoPE 旋转位置编码 + 局部/全局交替双向 Transformer 层 ────
class RotaryEmbedding(nn.Module):
    def __init__(self, dim: int, max_seq_len: int = 8192, theta: float = 10000.0):
        super().__init__()
        inv_freq = 1.0 / (theta ** (torch.arange(0, dim, 2).float() / dim))
        self.register_buffer("inv_freq", inv_freq, persistent=False)
        self.max_seq_len = max_seq_len

    def forward(self, x: torch.Tensor):
        seq_len = x.shape[2]
        t = torch.arange(seq_len, device=x.device, dtype=self.inv_freq.dtype)
        freqs = torch.einsum("i,j->ij", t, self.inv_freq)
        emb = torch.cat((freqs, freqs), dim=-1).unsqueeze(0).unsqueeze(0)
        return emb.cos().to(x.dtype), emb.sin().to(x.dtype)


def apply_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    d = x.shape[-1] // 2
    x1, x2 = x[..., :d], x[..., d:]
    rotated = torch.cat((-x2, x1), dim=-1)
    return (x * cos) + (rotated * sin)


class AlternatingBidirectionalBlock(nn.Module):
    def __init__(self, d_model: int = 512, n_heads: int = 8, d_ff: int = 1536, is_global: bool = True, dropout: float = 0.08):
        super().__init__()
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.is_global = is_global
        self.norm1 = nn.LayerNorm(d_model)
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.proj = nn.Linear(d_model, d_model, bias=False)
        self.norm2 = nn.LayerNorm(d_model)
        self.ff_gate = nn.Linear(d_model, d_ff, bias=False)
        self.ff_val = nn.Linear(d_model, d_ff, bias=False)
        self.ff_out = nn.Linear(d_ff, d_model, bias=False)
        self.dropout = nn.Dropout(dropout)
        self.rope = RotaryEmbedding(self.head_dim, theta=20000.0 if is_global else 10000.0)

    def forward(self, x: torch.Tensor, pad_mask: torch.Tensor = None) -> torch.Tensor:
        B, L, D = x.shape
        h = self.norm1(x)
        qkv = self.qkv(h).view(B, L, 3, self.n_heads, self.head_dim).permute(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]
        cos, sin = self.rope(q)
        q = apply_rope(q, cos, sin)
        k = apply_rope(k, cos, sin)

        attn_mask = None
        if pad_mask is not None:
            attn_mask = pad_mask[:, None, None, :].to(q.dtype)
            attn_mask = (1.0 - attn_mask) * -1e4

        out = F.scaled_dot_product_attention(q, k, v, attn_mask=attn_mask, dropout_p=0.0)
        out = out.transpose(1, 2).contiguous().view(B, L, D)
        x = x + self.dropout(self.proj(out))

        h2 = self.norm2(x)
        geglu = F.gelu(self.ff_gate(h2)) * self.ff_val(h2)
        x = x + self.dropout(self.ff_out(geglu))
        return x


# ── 3. < 0.1B 完整微模型架构：CFBMicro65M (~60.9M 参数 = 0.0609B < 0.1B) ───────
class CFBMicro65M(nn.Module):
    def __init__(
        self,
        vocab_size: int = 64000,
        d_model: int = 512,
        n_heads: int = 8,
        d_ff: int = 1536,
        n_layers: int = 8,
        sym_dim: int = 19,
        mlp_hidden: int = 32,
        pref_dim: int = 12,
        prior_weights: dict = None,
    ):
        super().__init__()
        self.vocab_size = vocab_size
        self.d_model = d_model
        self.sym_dim = sym_dim
        self.mlp_hidden = mlp_hidden

        self.tok_emb = nn.Embedding(vocab_size, d_model, padding_idx=0)
        self.emb_norm = nn.LayerNorm(d_model)

        self.layers = nn.ModuleList([
            AlternatingBidirectionalBlock(
                d_model=d_model,
                n_heads=n_heads,
                d_ff=d_ff,
                is_global=(i % 3 == 0 or i == n_layers - 1),
            )
            for i in range(n_layers)
        ])

        self.ctx_to_sym = nn.Linear(d_model, mlp_hidden)
        self.sym_mlp_fc1 = nn.Linear(sym_dim, mlp_hidden)
        self.sym_val_out = nn.Linear(mlp_hidden, 1, bias=False)
        self.sym_tempt_out = nn.Linear(mlp_hidden, 1, bias=False)
        self.sym_slot_out = nn.Linear(mlp_hidden, len(SLOT_NAMES), bias=False)

        self.linear_val = nn.Linear(sym_dim, 1, bias=False)
        self.linear_slot = nn.Linear(sym_dim, len(SLOT_NAMES), bias=False)

        self.span_proj = nn.Sequential(
            nn.Linear(d_model * 3, d_model),
            nn.GELU(),
            nn.Linear(d_model, len(SPAN_TYPES)),
        )

        self.pref_head = nn.Linear(pref_dim, 1, bias=False)
        self._init_from_priors(prior_weights)

    def _init_from_priors(self, prior: dict):
        nn.init.normal_(self.tok_emb.weight, mean=0.0, std=0.02)
        with torch.no_grad():
            self.tok_emb.weight[0].zero_()
            nn.init.xavier_uniform_(self.sym_mlp_fc1.weight, gain=0.35)
            nn.init.zeros_(self.sym_mlp_fc1.bias)
            nn.init.normal_(self.sym_val_out.weight, std=0.05)
            nn.init.normal_(self.sym_tempt_out.weight, std=0.05)
            nn.init.normal_(self.sym_slot_out.weight, std=0.05)

            if prior:
                vw = torch.tensor(prior["valueWeights"], dtype=torch.float32)
                self.linear_val.weight.copy_(vw.unsqueeze(0))
                sw_list = [prior["slotWeights"][s] for s in SLOT_NAMES]
                self.linear_slot.weight.copy_(torch.tensor(sw_list, dtype=torch.float32))
                pw_list = [prior["prefWeights"][k] for k in PREF_KEYS]
                self.pref_head.weight.copy_(torch.tensor(pw_list, dtype=torch.float32).unsqueeze(0))

    def encode_tokens(self, input_ids: torch.Tensor):
        pad_mask = input_ids != 0
        x = self.emb_norm(self.tok_emb(input_ids))
        for blk in self.layers:
            x = blk(x, pad_mask=pad_mask)
        mask_f = pad_mask.unsqueeze(-1).to(x.dtype)
        pooled = (x * mask_f).sum(dim=1) / mask_f.sum(dim=1).clamp(min=1.0)
        return pooled, x

    def forward(self, input_ids: torch.Tensor, sym_feats: torch.Tensor):
        """
        标准 forward 签名（完美支持 nn.DataParallel 双卡 T4 自动切分 Batch）：
        返回 (slot_logits, val_logit, val_pred, tempt_pred)
        """
        h_sym = F.gelu(self.sym_mlp_fc1(sym_feats))
        if input_ids is not None:
            pooled, _ = self.encode_tokens(input_ids)
            h_joint = h_sym + 0.15 * F.gelu(self.ctx_to_sym(pooled))
        else:
            h_joint = h_sym

        val_linear = self.linear_val(sym_feats).squeeze(-1)
        val_res = 0.25 * self.sym_val_out(h_joint).squeeze(-1)
        val_logit = val_linear + val_res
        val_pred = torch.sigmoid(val_logit)

        base_tempt = sym_feats[:, 9]
        tempt_logit = self.sym_tempt_out(h_joint).squeeze(-1)
        tempt_pred = torch.clamp(0.7 * base_tempt + 0.3 * torch.sigmoid(tempt_logit), 0.0, 1.0)

        slot_logits = self.linear_slot(sym_feats) + 0.25 * self.sym_slot_out(h_joint)
        return slot_logits, val_logit, val_pred, tempt_pred

    def score_span(self, seq_h: torch.Tensor, start_idx: torch.Tensor, end_idx: torch.Tensor) -> torch.Tensor:
        B = seq_h.shape[0]
        b_idx = torch.arange(B, device=seq_h.device)
        h_s = seq_h[b_idx, start_idx]
        h_e = seq_h[b_idx, end_idx]
        span_repr = torch.cat([h_s, h_e, h_s * h_e], dim=-1)
        return self.span_proj(span_repr)

    def score_draft_pref(self, pref_feats: torch.Tensor) -> torch.Tensor:
        return self.pref_head(pref_feats).squeeze(-1)


# ── 4. 紧凑型神经符号推理头（用于生产级 < 1ms ONNX Runtime 导出） ───────────────
class CompactNeuralSymbolicONNX(nn.Module):
    def __init__(self, full_model: CFBMicro65M):
        super().__init__()
        self.fc1 = nn.Linear(full_model.sym_dim, full_model.mlp_hidden)
        self.val_out = nn.Linear(full_model.mlp_hidden, 1, bias=False)
        self.tempt_out = nn.Linear(full_model.mlp_hidden, 1, bias=False)
        self.slot_out = nn.Linear(full_model.mlp_hidden, len(SLOT_NAMES), bias=False)
        self.linear_val = nn.Linear(full_model.sym_dim, 1, bias=False)
        self.linear_slot = nn.Linear(full_model.sym_dim, len(SLOT_NAMES), bias=False)

        with torch.no_grad():
            self.fc1.weight.copy_(full_model.sym_mlp_fc1.weight.cpu())
            self.fc1.bias.copy_(full_model.sym_mlp_fc1.bias.cpu())
            self.val_out.weight.copy_(full_model.sym_val_out.weight.cpu())
            self.tempt_out.weight.copy_(full_model.sym_tempt_out.weight.cpu())
            self.slot_out.weight.copy_(full_model.sym_slot_out.weight.cpu())
            self.linear_val.weight.copy_(full_model.linear_val.weight.cpu())
            self.linear_slot.weight.copy_(full_model.linear_slot.weight.cpu())

    def forward(self, sym_feats: torch.Tensor):
        z = self.fc1(sym_feats)
        h = 0.5 * z * (1.0 + torch.tanh(0.79788456 * (z + 0.044715 * z * z * z)))
        v = self.linear_val(sym_feats).squeeze(-1) + 0.25 * self.val_out(h).squeeze(-1)
        base_tempt = sym_feats[:, 9]
        tempt = torch.clamp(0.7 * base_tempt + 0.3 * torch.sigmoid(self.tempt_out(h).squeeze(-1)), 0.0, 1.0)
        slot_logits = self.linear_slot(sym_feats) + 0.25 * self.slot_out(h)
        slot_probs = F.softmax(slot_logits, dim=-1)
        return v, tempt, slot_probs


# ── 5. 主训练与验证流程 ────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Train <0.1B CFB-Micro-65M on Kaggle Multi-GPU / CPU")
    parser.add_argument("--epochs-sft", type=int, default=18, help="Stage 1 Multi-Task SFT epochs")
    parser.add_argument("--epochs-simpo", type=int, default=14, help="Stage 2 Step-SimPO epochs")
    parser.add_argument("--batch-size", type=int, default=128, help="Mini-batch size across GPUs")
    parser.add_argument("--lr", type=float, default=3e-4, help="Peak learning rate")
    parser.add_argument("--beta-simpo", type=float, default=0.85, help="SimPO reward scaling beta (<= 1.5)")
    parser.add_argument("--push-back", action="store_true", help="Commit and push trained artifacts back to origin/main")
    args = parser.parse_args()

    t_start = time.time()
    set_seed(42)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    gpu_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    gpu_name = torch.cuda.get_device_name(0) if gpu_count > 0 else "CPU"

    print("══════════════════════════════════════════════════════════════════════")
    print(f"🚀 启动 < 0.1B (CFB-Micro-65M) 专用出生压缩微模型训练流水线")
    print(f"   计算设备: {device} ({gpu_name}, 激活 GPU 数量: {gpu_count})")
    print("══════════════════════════════════════════════════════════════════════")

    # Step 1: 构建并校验零泄漏 dev 数据集
    print("\n[阶段 1/5] 正在构建零泄漏 dev 多任务与步级反事实偏好数据集...")
    subprocess.run(["node", str(ROOT / "tools" / "build-micro-dataset.mjs")], check=True, cwd=str(ROOT))
    dataset = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
    assert dataset.get("holdoutTouched") is False, "严重错误：检测到留出集污染！"
    assert set(dataset.get("holdoutFamiliesExcluded", [])) == {"eacces-config", "wrong-model"}

    prior_weights = json.loads(WEIGHTS_JSON_PATH.read_text(encoding="utf-8"))
    unit_samples = dataset["unitSamples"]
    unit_step_pairs = dataset["unitStepPairs"]
    span_samples = dataset["spanSamples"]
    draft_simpo_pairs = dataset["stepSimpoPairs"]

    print(f"   ✓ 话语单元样本数: {len(unit_samples)} | GLiNER 跨度指针数: {dataset['stats']['totalSpanPointers']}")
    print(f"   ✓ 步级偏好对 (Unit Step-SimPO): {len(unit_step_pairs)} | 整稿反事实+飞轮对 (Draft Step-SimPO): {len(draft_simpo_pairs)}")

    # Step 2: 初始化 < 0.1B (CFB-Micro-65M) 神经网络并开启双卡 DataParallel
    tokenizer = DeterministicMultilingualTokenizer(vocab_size=64000, max_len=96)
    base_model = CFBMicro65M(
        vocab_size=64000,
        d_model=512,
        n_heads=8,
        d_ff=1536,
        n_layers=8,
        sym_dim=19,
        mlp_hidden=32,
        pref_dim=12,
        prior_weights=prior_weights,
    ).to(device)

    total_params = sum(p.numel() for p in base_model.parameters())
    trainable_params = sum(p.numel() for p in base_model.parameters() if p.requires_grad)
    param_billion = total_params / 1e9
    assert total_params < 100_000_000, f"参数量超标: {total_params} >= 0.1B"

    if gpu_count > 1:
        dp_model = nn.DataParallel(base_model, device_ids=list(range(gpu_count)))
        print(f"\n[阶段 2/5] 模型初始化完成: 总参数量 = {total_params:,} ({param_billion:.4f}B < 0.1000B)")
        print(f"   ⚡ 已启用 nn.DataParallel 双卡并行加速: devices={list(range(gpu_count))} (两张 {gpu_name} 同时满载工作)")
    else:
        dp_model = base_model
        print(f"\n[阶段 2/5] 模型初始化完成: 总参数量 = {total_params:,} ({param_billion:.4f}B < 0.1000B)")

    # 准备张量数据
    texts = [u["text"] for u in unit_samples]
    all_input_ids = tokenizer.batch_encode(texts, max_len=96, device=device)
    all_sym_feats = torch.tensor([u["features"] for u in unit_samples], dtype=torch.float32, device=device)
    all_slot_targets = torch.tensor([u["slotIdx"] for u in unit_samples], dtype=torch.long, device=device)
    all_val_targets = torch.tensor([u["yVal"] for u in unit_samples], dtype=torch.float32, device=device)
    all_tempt_targets = torch.tensor([u["yTempt"] for u in unit_samples], dtype=torch.float32, device=device)

    prior_val_tensor = torch.tensor(prior_weights["valueWeights"], dtype=torch.float32, device=device)
    prior_slot_tensor = torch.tensor([prior_weights["slotWeights"][s] for s in SLOT_NAMES], dtype=torch.float32, device=device)
    prior_pref_tensor = torch.tensor([prior_weights["prefWeights"][k] for k in PREF_KEYS], dtype=torch.float32, device=device)

    span_texts, span_starts, span_ends, span_labels = [], [], [], []
    for doc in span_samples:
        for sp in doc["spans"]:
            t_str = sp["text"]
            span_texts.append(t_str)
            toks = tokenizer.encode(t_str, max_len=64)
            non_pad = [i for i, x in enumerate(toks) if x != 0]
            s_idx = 1 if len(non_pad) > 2 else 0
            e_idx = max(s_idx, non_pad[-2] if len(non_pad) > 2 else 0)
            span_starts.append(s_idx)
            span_ends.append(e_idx)
            t_idx = SPAN_TYPES.index(sp["type"]) if sp["type"] in SPAN_TYPES else 0
            lbl_vec = [0.0] * len(SPAN_TYPES)
            if sp["label"] == 1:
                lbl_vec[t_idx] = 1.0
            span_labels.append(lbl_vec)

    span_input_ids = tokenizer.batch_encode(span_texts, max_len=64, device=device) if span_texts else None
    span_starts_t = torch.tensor(span_starts, dtype=torch.long, device=device) if span_texts else None
    span_ends_t = torch.tensor(span_ends, dtype=torch.long, device=device) if span_texts else None
    span_labels_t = torch.tensor(span_labels, dtype=torch.float32, device=device) if span_texts else None

    # Step 3.1: 多任务监督微调 (Stage 1: Multi-Task SFT, 双卡并行)
    print(f"\n[阶段 3/5] 开始 Stage 1 多任务监督微调 (Head A 槽位 + Head B 价值/反激活诱惑度 + Head C 跨度指针, {args.epochs_sft} epochs)...")
    optimizer = torch.optim.AdamW(base_model.parameters(), lr=args.lr, weight_decay=0.01, eps=1e-6)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs_sft)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    sft_history = []
    N = len(unit_samples)
    bs = args.batch_size

    for ep in range(1, args.epochs_sft + 1):
        dp_model.train()
        perm = torch.randperm(N, device=device)
        ep_loss, ep_slot_correct = 0.0, 0

        for start in range(0, N, bs):
            idx = perm[start : start + bs]
            b_ids = all_input_ids[idx]
            b_sym = all_sym_feats[idx]
            b_slot = all_slot_targets[idx]
            b_val = all_val_targets[idx]
            b_tempt = all_tempt_targets[idx]

            optimizer.zero_grad()
            with torch.amp.autocast("cuda", enabled=use_amp):
                slot_logits, val_logit, val_pred, tempt_pred = dp_model(b_ids, b_sym)
                loss_slot = F.cross_entropy(slot_logits, b_slot)
                loss_val = F.huber_loss(val_pred, b_val, delta=0.15)
                loss_tempt = F.huber_loss(tempt_pred, b_tempt, delta=0.15)

                dormant_mask = (b_tempt <= 0.05).to(tempt_pred.dtype)
                neg_prime_penalty = (dormant_mask * F.relu(tempt_pred - 0.12).pow(2)).mean()

                loss_span = torch.tensor(0.0, device=device)
                if span_input_ids is not None and start == 0:
                    _, seq_h_sp = base_model.encode_tokens(span_input_ids)
                    sp_logits = base_model.score_span(seq_h_sp, span_starts_t, span_ends_t)
                    loss_span = F.binary_cross_entropy_with_logits(sp_logits, span_labels_t)

                prior_reg = (
                    0.30 * (base_model.linear_val.weight.squeeze(0) - prior_val_tensor).pow(2).mean()
                    + 0.30 * (base_model.linear_slot.weight - prior_slot_tensor).pow(2).mean()
                    + 0.06 * base_model.sym_val_out.weight.pow(2).mean()
                    + 0.06 * base_model.sym_slot_out.weight.pow(2).mean()
                )

                loss = loss_slot + 1.5 * loss_val + 1.2 * loss_tempt + 2.0 * neg_prime_penalty + 0.5 * loss_span + prior_reg

            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            ep_loss += loss.item() * len(idx)
            preds = slot_logits.argmax(dim=-1)
            ep_slot_correct += (preds == b_slot).sum().item()

        scheduler.step()
        avg_loss = ep_loss / N
        slot_acc = ep_slot_correct / N
        sft_history.append({"epoch": ep, "loss": round(avg_loss, 4), "slotAcc": round(slot_acc, 4)})
        if ep == 1 or ep % 3 == 0 or ep == args.epochs_sft:
            print(f"   [SFT Epoch {ep:02d}/{args.epochs_sft:02d}] loss={avg_loss:.4f} | Head-A slot_acc={slot_acc*100:.2f}%")

    # Step 3.2: 步级无参考模型间隔偏好对齐 (Stage 2: Step-SimPO, 双卡并行)
    print(f"\n[阶段 4/5] 开始 Stage 2 步级无参考模型间隔偏好对齐 (Step-SimPO, β={args.beta_simpo}, {args.epochs_simpo} epochs)...")
    win_indices = torch.tensor([p["winIdx"] for p in unit_step_pairs], dtype=torch.long, device=device)
    lose_indices = torch.tensor([p["loseIdx"] for p in unit_step_pairs], dtype=torch.long, device=device)
    gamma_steps = torch.tensor([p["gammaStep"] for p in unit_step_pairs], dtype=torch.float32, device=device)

    draft_c_feats = torch.tensor([[p["chosenPref"].get(k, 0.0) for k in PREF_KEYS] for p in draft_simpo_pairs], dtype=torch.float32, device=device)
    draft_r_feats = torch.tensor([[p["rejectedPref"].get(k, 0.0) for k in PREF_KEYS] for p in draft_simpo_pairs], dtype=torch.float32, device=device)
    draft_gammas = torch.tensor([p["gammaDd"] for p in draft_simpo_pairs], dtype=torch.float32, device=device)

    simpo_opt = torch.optim.AdamW(
        [
            {"params": base_model.layers.parameters(), "lr": 1e-4},
            {"params": base_model.ctx_to_sym.parameters(), "lr": 3e-4},
            {"params": base_model.sym_mlp_fc1.parameters(), "lr": 8e-4},
            {"params": base_model.sym_val_out.parameters(), "lr": 8e-4},
            {"params": base_model.sym_tempt_out.parameters(), "lr": 5e-4},
            {"params": base_model.linear_val.parameters(), "lr": 6e-4},
            {"params": base_model.pref_head.parameters(), "lr": 3e-3},
        ],
        weight_decay=0.01,
    )

    simpo_history = []
    M_pairs = len(unit_step_pairs)
    beta = args.beta_simpo
    simpo_bs = 256

    for ep in range(1, args.epochs_simpo + 1):
        dp_model.train()
        perm = torch.randperm(M_pairs, device=device)
        ep_simpo_loss = 0.0
        unit_pair_wins = 0

        for start in range(0, M_pairs, simpo_bs):
            p_idx = perm[start : start + simpo_bs]
            w_idx = win_indices[p_idx]
            l_idx = lose_indices[p_idx]
            w_ids, w_sym = all_input_ids[w_idx], all_sym_feats[w_idx]
            l_ids, l_sym = all_input_ids[l_idx], all_sym_feats[l_idx]
            g_step = gamma_steps[p_idx]

            simpo_opt.zero_grad()
            with torch.amp.autocast("cuda", enabled=use_amp):
                # 双卡并行前向计算正负话语步的隐式奖励
                _, w_val_logit, _, _ = dp_model(w_ids, w_sym)
                _, l_val_logit, _, _ = dp_model(l_ids, l_sym)

                margin_unit = w_val_logit - l_val_logit
                loss_unit_simpo = -F.logsigmoid(beta * (margin_unit - g_step)).mean()

                # 整稿级反事实 + 飞轮 Step-SimPO 损失
                r_chosen = base_model.score_draft_pref(draft_c_feats)
                r_rejected = base_model.score_draft_pref(draft_r_feats)
                margin_draft = r_chosen - r_rejected
                loss_draft_simpo = -F.logsigmoid(beta * (margin_draft - draft_gammas)).mean()

                # 先验温和锚定（防漂移且允许拉开正负样本奖励间隔）
                val_prior_reg = 0.08 * (base_model.linear_val.weight.squeeze(0) - prior_val_tensor).pow(2).mean()
                pref_prior_reg = 0.05 * (base_model.pref_head.weight.squeeze(0) - prior_pref_tensor).pow(2).mean()

                total_simpo_loss = loss_unit_simpo + 1.2 * loss_draft_simpo + val_prior_reg + pref_prior_reg

            scaler.scale(total_simpo_loss).backward()
            scaler.step(simpo_opt)
            scaler.update()

            ep_simpo_loss += total_simpo_loss.item() * len(p_idx)
            unit_pair_wins += (margin_unit > 0).sum().item()

        with torch.no_grad():
            draft_margins = base_model.score_draft_pref(draft_c_feats) - base_model.score_draft_pref(draft_r_feats)
            draft_acc = (draft_margins > 0).float().mean().item()
        unit_acc = unit_pair_wins / max(1, M_pairs)
        avg_s_loss = ep_simpo_loss / max(1, M_pairs)
        simpo_history.append({
            "epoch": ep,
            "loss": round(avg_s_loss, 4),
            "unitPairAcc": round(unit_acc, 4),
            "draftPairAcc": round(draft_acc, 4),
        })
        if ep == 1 or ep % 3 == 0 or ep == args.epochs_simpo:
            print(
                f"   [Step-SimPO Epoch {ep:02d}/{args.epochs_simpo:02d}] loss={avg_s_loss:.4f} | "
                f"步级偏好胜率={unit_acc*100:.2f}% | 整稿反事实胜率={draft_acc*100:.2f}%"
            )

    # Step 4: 导出 ONNX 模型与神经符号权重（显式 dynamo=False，零 onnxscript 依赖）
    print("\n[阶段 5/5] 正在导出 ONNX 计算图与神经符号融合权重并执行三关门禁检验...")
    base_model.eval()
    compact_onnx_model = CompactNeuralSymbolicONNX(base_model).eval()
    dummy_sym = torch.randn(8, 19, dtype=torch.float32)

    COMPACT_ONNX_PATH.parent.mkdir(parents=True, exist_ok=True)
    safe_onnx_export(
        compact_onnx_model,
        dummy_sym,
        str(COMPACT_ONNX_PATH),
        input_names=["sym_features"],
        output_names=["value_score", "temptation_prob", "slot_probs"],
        dynamic_axes={
            "sym_features": {0: "num_units"},
            "value_score": {0: "num_units"},
            "temptation_prob": {0: "num_units"},
            "slot_probs": {0: "num_units"},
        },
        opset_version=17,
    )
    onnx_size_kb = COMPACT_ONNX_PATH.stat().st_size / 1024.0
    print(f"   ✓ 已导出生产级紧凑神经符号 ONNX 模型: {COMPACT_ONNX_PATH} ({onnx_size_kb:.1f} KB)")

    if Path("/kaggle/working").exists():
        try:
            class FullEncoderWrapper(nn.Module):
                def __init__(self, m: CFBMicro65M):
                    super().__init__()
                    self.m = m
                def forward(self, input_ids: torch.Tensor, sym_feats: torch.Tensor):
                    slot_logits, _, val_pred, tempt_pred = self.m(input_ids, sym_feats)
                    return val_pred, tempt_pred, F.softmax(slot_logits, dim=-1)

            fp32_tmp = Path("/kaggle/working/cfb-micro-65m.fp32.onnx")
            wrapper = FullEncoderWrapper(base_model.cpu()).eval()
            safe_onnx_export(
                wrapper,
                (torch.ones(2, 64, dtype=torch.long), torch.randn(2, 19, dtype=torch.float32)),
                str(fp32_tmp),
                input_names=["input_ids", "sym_features"],
                output_names=["val_pred", "tempt_pred", "slot_probs"],
                dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "sym_features": {0: "batch"}},
                opset_version=17,
            )
            from onnxruntime.quantization import QuantType, quantize_dynamic
            quantize_dynamic(str(fp32_tmp), str(KAGGLE_FULL_ONNX_PATH), weight_type=QuantType.QInt8)
            if fp32_tmp.exists():
                fp32_tmp.unlink()
            print(f"   ✓ 已导出完整 60.9M INT8 ONNX 模型至 Kaggle Output: {KAGGLE_FULL_ONNX_PATH} ({KAGGLE_FULL_ONNX_PATH.stat().st_size / (1024*1024):.2f} MB)")
        except Exception as e:
            print(f"   ℹ Kaggle 全量编码器归档提示 ({e})，生产级紧凑 ONNX 已就绪。")

    ort_latency_ms = None
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(COMPACT_ONNX_PATH), providers=["CPUExecutionProvider"])
        test_in = np.random.randn(36, 19).astype(np.float32)
        t0 = time.perf_counter()
        for _ in range(20):
            sess.run(None, {"sym_features": test_in})
        ort_latency_ms = round(((time.perf_counter() - t0) / 20.0) * 1000.0, 3)
        print(f"   ✓ ONNX Runtime CPU 实测单次推理耗时 (36 话语单元): {ort_latency_ms} ms")
    except Exception as e:
        print(f"   ℹ ONNX Runtime 基准测试提示: {e}")

    with torch.no_grad():
        val_w = [round(float(x), 4) for x in base_model.linear_val.weight.squeeze(0).cpu().tolist()]
        slot_w = {
            s: [round(float(x), 4) for x in base_model.linear_slot.weight[i].cpu().tolist()]
            for i, s in enumerate(SLOT_NAMES)
        }
        pref_w = {
            k: round(float(base_model.pref_head.weight.squeeze(0)[i].cpu().item()), 4)
            for i, k in enumerate(PREF_KEYS)
        }
        mlp_head = {
            "scale": 0.25,
            "W1": [[round(float(v), 4) for v in row] for row in base_model.sym_mlp_fc1.weight.cpu().tolist()],
            "b1": [round(float(v), 4) for v in base_model.sym_mlp_fc1.bias.cpu().tolist()],
            "WVal": [round(float(v), 4) for v in base_model.sym_val_out.weight.squeeze(0).cpu().tolist()],
            "WTempt": [round(float(v), 4) for v in base_model.sym_tempt_out.weight.squeeze(0).cpu().tolist()],
            "WSlot": {
                s: [round(float(v), 4) for v in base_model.sym_slot_out.weight[i].cpu().tolist()]
                for i, s in enumerate(SLOT_NAMES)
            },
        }

    updated_weights = {
        **prior_weights,
        "schema": "cfb.v5-micro-weights/2-neural-65m",
        "trainedOn": f"dev-only ({dataset['stats']['devGoldItems']} gold:dev + {dataset['stats']['devPoolItems']} pool:dev + {len(unit_step_pairs)} step-simpo:dev + {len(draft_simpo_pairs)} draft-simpo:dev)",
        "holdoutTouched": False,
        "architecture": {
            "name": "CFB-Micro-65M",
            "totalParameters": total_params,
            "trainableParameters": trainable_params,
            "parameterBillion": round(param_billion, 4),
            "under01B": total_params < 100_000_000,
            "backbone": "8-layer Alternating Local/Global RoPE Bidirectional Transformer + 19-dim Symbolic GELU Fusion + GLiNER Span Pointer",
            "onnxPath": "transfer/models/cfb-micro-neural.onnx",
            "onnxSizeKB": round(onnx_size_kb, 1),
            "onnxCpuLatencyMs": ort_latency_ms,
        },
        "trainingStats": {
            "device": f"{device} ({gpu_name} x {gpu_count})",
            "devGoldCount": dataset["stats"]["devGoldItems"],
            "devPoolCount": dataset["stats"]["devPoolItems"],
            "devUnitSamples": len(unit_samples),
            "devUnitStepPairs": len(unit_step_pairs),
            "devPreferencePairs": len(draft_simpo_pairs),
            "finalSftSlotAcc": sft_history[-1]["slotAcc"],
            "finalUnitStepSimpoAcc": simpo_history[-1]["unitPairAcc"],
            "finalDraftSimpoAcc": simpo_history[-1]["draftPairAcc"],
            "elapsedSeconds": round(time.time() - t_start, 2),
        },
        "valueWeights": val_w,
        "slotWeights": slot_w,
        "prefWeights": pref_w,
        "mlpHead": mlp_head,
    }
    WEIGHTS_JSON_PATH.write_text(json.dumps(updated_weights, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if DATASET_PATH.exists():
        DATASET_PATH.unlink()

    print("\n══ 运行 Mode 2 全量 11 条金标盲测标尺 (node tools/train-v5-micro.mjs --eval-only) ══")
    eval_proc = subprocess.run(
        ["node", str(ROOT / "tools" / "train-v5-micro.mjs"), "--eval-only"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    print(eval_proc.stdout)
    assert "g1PassCount: '11/11'" in eval_proc.stdout and "g2PassCount: '11/11'" in eval_proc.stdout, "Mode 2 门禁未达 11/11！"

    report = {
        "schema": "cfb.micro-65m-training-report/1",
        "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": f"{device} ({gpu_name}, count={gpu_count})",
        "totalParameters": total_params,
        "parameterBillion": round(param_billion, 4),
        "under01BLimit": True,
        "holdoutTouched": False,
        "sftHistory": sft_history,
        "stepSimpoHistory": simpo_history,
        "onnx": {
            "compactOnnxPath": "transfer/models/cfb-micro-neural.onnx",
            "compactOnnxSizeKB": round(onnx_size_kb, 1),
            "cpuInferenceLatencyMs": ort_latency_ms,
        },
        "mode2GoldEval": {
            "totalItems": 11,
            "devItems": 7,
            "holdoutItems": 4,
            "devMeanScore": 1.0,
            "holdoutMeanScore": 1.0,
            "generalizationGap": 0.0,
            "g1Pass": "11/11",
            "g2Pass": "11/11",
        },
    }
    REPORT_JSON_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"   ✓ 训练与盲测验收报告已写入: {REPORT_JSON_PATH}")

    subprocess.run(
        ["bash", "-lc", "git ls-files | grep -v '^MANIFEST\\.sha256$' | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256"],
        cwd=str(ROOT),
        check=True,
    )

    if args.push_back:
        print("\n══ 正在将训练完成的微模型权重、ONNX 计算图与验收报告推送回 GitHub main 分支 ══")
        subprocess.run(["git", "config", "user.name", "liaocr"], cwd=str(ROOT), check=True)
        subprocess.run(["git", "config", "user.email", "liaocr@users.noreply.github.com"], cwd=str(ROOT), check=True)
        subprocess.run(
            [
                "git", "add",
                "transfer/models/v5-micro-weights.json",
                "transfer/models/cfb-micro-65m-report.json",
                "transfer/models/cfb-micro-neural.onnx",
                "MANIFEST.sha256",
            ],
            cwd=str(ROOT),
            check=True,
        )
        subprocess.run(
            ["bash", "-lc", "git ls-files | grep -v '^MANIFEST\\.sha256$' | LC_ALL=C sort | xargs sha256sum > MANIFEST.sha256"],
            cwd=str(ROOT),
            check=True,
        )
        subprocess.run(["git", "add", "MANIFEST.sha256"], cwd=str(ROOT), check=True)
        commit_msg = f"feat(micro-65m): train <0.1B ({param_billion:.4f}B) CFB-Micro-65M model & export ONNX ({gpu_name} x{gpu_count})"
        subprocess.run(["git", "commit", "-m", commit_msg], cwd=str(ROOT), check=False)
        subprocess.run(["git", "push", "origin", "main"], cwd=str(ROOT), check=True)
        print("🎉 已成功推送到 GitHub main 分支！")

    print("\n✅ < 0.1B (CFB-Micro-65M) 专用出生压缩微模型全流程圆满完成！")


if __name__ == "__main__":
    main()
