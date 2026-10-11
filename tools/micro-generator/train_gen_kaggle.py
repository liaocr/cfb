#!/usr/bin/env python3
"""Round-0 generative compressor: QLoRA SFT of Qwen3-0.6B on the mechanical-teacher corpus.

Runs on Kaggle (T4/P100) with Internet enabled for the base-model download.
Deliberately SEPARATE from tools/micro-generator/train_qlora.py (the fail-closed
reviewed-corpus trainer). Training bar = the user-set one: **the compressed block must
not lose information**, measured as critical-anchor retention (see metric_report).

Multi-GPU: pass-through DDP. Launch with:
  python -m torch.distributed.run --nproc_per_node=2 train_gen_kaggle.py ...
or just run it plainly for single-GPU. World size comes from LOCAL_RANK/WORLD_SIZE.
Effective batch is batch × grad_accum × world_size; when doubling the world size,
halve --grad-accum to keep the same optimisation step count and LR schedule.

Usage:
  python train_gen_kaggle.py --train train.jsonl.gz --dev dev.jsonl.gz --out /kaggle/working/run1 \
      --model-id Qwen/Qwen3-0.6B --epochs 2 --lr 1e-4
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# ── 与 build-teacher-corpus.py 完全同一份锚点/关键集口径（一个实现，两处共用） ──────────────
IDENT_RE = re.compile(r"`[^`\n]{2,120}`|[A-Za-z_$][\w.$-]{2,}|\d{2,}")
STOP = {
    "the", "and", "for", "you", "are", "not", "but", "with", "that", "this", "have", "has", "had",
    "from", "will", "can", "should", "would", "could", "let", "let's", "lets", "its", "it's",
    "old_text", "new_text", "edit_file", "read_file", "bash", "str_replace", "apply_patch",
    "tool_call", "true", "false", "null", "undefined", "none", "test", "tests", "assert",
    "const", "var", "return", "function", "import", "export", "async", "await",
    "PASS", "FAIL", "pass", "fail", "grep", "sed", "cat", "head", "tail", "echo", "python",
    "command", "found", "error", "Error", "AssertionError", "Traceback", "exit", "code",
}
VERDICT_RE = re.compile(r"(\d+\s+(?:passed|failed|error)|\bpassed\b|\bfailed\b|\btraceback\b|assertionerror|\bexit(?:ed)? code\s*\d|\bok\b|\bFAIL\b|\bPASS\b)", re.I)
CMD_RE = re.compile(r"(?m)^\s*(?:cd\s+\S+\s*&&\s*)?(?:python3?|pytest|git|npm|npx|node|pip|make|tox|grep|sed|find|cat)\b")
PATHY_RE = re.compile(r"\w+\.(?:py|js|mjs|ts|json|md|txt|cfg|toml|yaml|yml|sh|go|rs|java|rb|php|c|cpp|h)\b")


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def anchors_of(text: str) -> set:
    out = set()

    def add(tok: str) -> None:
        tok = tok.strip("`")
        if len(tok) < 3 and not re.fullmatch(r"\d{2,}", tok):
            return
        if tok in STOP or re.fullmatch(r"[.\-$]+", tok):
            return
        out.add(tok)

    for m in IDENT_RE.finditer(text or ""):
        tok = m.group(0).rstrip(".-")
        add(tok)
        if re.search(r"[./\-]", tok):
            for part in re.split(r"[./\-]+", tok):
                add(part)
        if re.search(r"[a-z][A-Z]", tok):
            for sub in re.split(r"(?=[A-Z])", tok):
                add(sub)
    for line in (text or "").split("\n"):
        if VERDICT_RE.search(line) or CMD_RE.search(line):
            add(_norm(line)[:60])
    return out


def critical_anchors(text: str) -> set:
    """teacher v0.2 口径的关键集：判定行 ∪ 命令 ∪ 围栏代码 ∪ 路径类锚点。"""
    protected = set()
    for line in (text or "").split("\n"):
        if VERDICT_RE.search(line) or CMD_RE.search(line) or "```" in line:
            protected |= anchors_of(line)
        for tok in anchors_of(line):
            if PATHY_RE.search(tok) or "/" in tok:
                protected.add(tok)
    return protected


def metric_report(raw: str, draft: str) -> dict:
    a_raw, a_draft = anchors_of(raw), anchors_of(draft)
    crit = critical_anchors(raw)
    crit_cov = 1.0 if not crit else len(a_draft & crit) / len(crit)
    full_cov = 1.0 if not a_raw else len(a_draft & a_raw) / len(a_raw)
    invented = sorted(a_draft - a_raw)  # 稿里出现、原文没有的锚点（含新造的）
    return {
        "ratio": round(len(draft) / max(1, len(raw)), 4),
        "criticalCoverage": round(crit_cov, 4),
        "fullCoverage": round(full_cov, 4),
        "anchorsRaw": len(a_raw),
        "anchorsDraft": len(a_draft),
        "inventedAnchors": invented[:12],
        "inventedCount": len(invented),
    }


def read_jsonl(path):
    import gzip
    opener = gzip.open if str(path).endswith(".gz") else open
    rows = []
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def row_drop_target(row):
    """从 user 消息里取回 raw（【RAW】段），用于相对原文的留存率。"""
    content = row["messages"][1]["content"]
    marker = "【RAW】\n"
    idx = content.rfind(marker)
    return content[idx + len(marker):] if idx >= 0 else content


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model-id", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--revision", default=None)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max-len", type=int, default=5120)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--eval-samples", type=int, default=12)
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=20261007)
    args = ap.parse_args()

    import torch
    from torch.utils.data import DataLoader
    from torch.utils.data.distributed import DistributedSampler
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    if not torch.cuda.is_available():
        print("FATAL: no CUDA device; this trainer refuses CPU runs", file=sys.stderr)
        return 2

    # ---- distributed setup：torchrun 给 LOCAL_RANK/WORLD_SIZE；裸跑即单卡 ----
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    world_size = int(os.environ.get("WORLD_SIZE", "1"))
    ddp = world_size > 1
    if ddp:
        torch.distributed.init_process_group(backend="nccl")
        torch.cuda.set_device(local_rank)
    is_main = local_rank == 0
    torch.manual_seed(args.seed + local_rank)

    def log(*a):
        if is_main:
            print(*a, flush=True)

    out = Path(args.out)
    if is_main:
        out.mkdir(parents=True, exist_ok=True)

    train_rows = read_jsonl(args.train)
    dev_rows = read_jsonl(args.dev)
    corpus_sha = hashlib.sha256(Path(args.train).read_bytes()).hexdigest()  # 压缩文件的字节哈希即语料指纹
    log(f"world_size={world_size} · train rows {len(train_rows)} · dev rows {len(dev_rows)} · corpus sha256 {corpus_sha[:16]}")
    log(f"torch {torch.__version__} · {torch.cuda.device_count()}x {torch.cuda.get_device_name(0)}"
        + (f" · DDP: this rank={local_rank} on {torch.cuda.get_device_name(local_rank)}" if ddp else " · single-process"))

    tok = AutoTokenizer.from_pretrained(args.model_id, revision=args.revision, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def render(messages, add_gen=False):
        try:
            return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_gen, enable_thinking=False)
        except TypeError:
            return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_gen)

    # ---- build tokenized train set (labels masked to assistant span only) ----
    data = []  # (input_ids, labels)
    skipped = 0
    for row in train_rows:
        msgs = row["messages"]
        full = render(msgs)
        prompt = render(msgs[:-1], add_gen=True)
        ids = tok(full, add_special_tokens=False)["input_ids"]
        plen = len(tok(prompt, add_special_tokens=False)["input_ids"])
        if len(ids) > args.max_len:
            skipped += 1
            continue
        labels = [-100] * min(plen, len(ids)) + ids[min(plen, len(ids)):]
        data.append((ids, labels))
    log(f"tokenized {len(data)} examples (skipped {skipped} over {args.max_len} tokens)")

    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_id, revision=args.revision, quantization_config=bnb,
        device_map={"": local_rank} if ddp else "auto", torch_dtype=torch.float16)
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                            gradient_checkpointing_kwargs={"use_reentrant": False})
    try:
        lora = LoraConfig(r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
                          target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
        model = get_peft_model(model, lora)
    except ValueError as exc:
        log(f"target_modules fallback ({exc}); retrying with q_proj/v_proj only")
        lora = LoraConfig(r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
                          target_modules=["q_proj", "v_proj"])
        model = get_peft_model(model, lora)
    model.config.use_cache = False
    if is_main:
        model.print_trainable_parameters()

    if ddp:
        model = torch.nn.parallel.DistributedDataParallel(model, device_ids=[local_rank], find_unused_parameters=False)
    core = model.module if ddp else model

    def collate(batch):
        maxlen = max(len(x[0]) for x in batch)
        input_ids, labels, attn = [], [], []
        for ids, lab in batch:
            pad = maxlen - len(ids)
            input_ids.append(ids + [tok.pad_token_id] * pad)
            labels.append(lab + [-100] * pad)
            attn.append([1] * len(ids) + [0] * pad)
        return (torch.tensor(input_ids), torch.tensor(labels), torch.tensor(attn))

    sampler = None
    if ddp:
        sampler = DistributedSampler(data, num_replicas=world_size, rank=local_rank, shuffle=True,
                                     seed=args.seed, drop_last=True)
    dl = DataLoader(data, batch_size=args.batch, shuffle=(sampler is None), sampler=sampler,
                    collate_fn=collate, drop_last=ddp,
                    generator=torch.Generator().manual_seed(args.seed))
    try:
        import bitsandbytes as bnbmod
        opt = bnbmod.optim.PagedAdamW8bit([p for p in core.parameters() if p.requires_grad], lr=args.lr)
        log("optimizer: paged_adamw_8bit")
    except Exception:
        opt = torch.optim.AdamW([p for p in core.parameters() if p.requires_grad], lr=args.lr)
        log("optimizer: adamw_torch")
    micro_per_epoch = max(1, len(dl))
    steps_per_epoch = max(1, micro_per_epoch // args.grad_accum)
    total_steps = max(1, int(steps_per_epoch * args.epochs))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total_steps, pct_start=0.03)
    log(f"steps: {total_steps} (per-rank micro-batches/epoch {micro_per_epoch} ÷ accum {args.grad_accum}"
        + (f" × {world_size} GPUs ⇒ effective batch {args.batch * args.grad_accum * world_size})" if ddp else ")"))

    model.train()
    t0 = time.time()
    step = 0
    losses = []
    epoch = 0
    while step < total_steps:
        if sampler is not None:
            sampler.set_epoch(epoch)
        for micro, (ids, labels, attn) in enumerate(dl):
            loss = model(input_ids=ids.to(core.device), attention_mask=attn.to(core.device), labels=labels.to(core.device)).loss / args.grad_accum
            loss.backward()
            losses.append(float(loss.detach()) * args.grad_accum)
            if (micro + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_([p for p in core.parameters() if p.requires_grad], 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
                step += 1
                if step % 10 == 0 or step == total_steps:
                    log(f"step {step}/{total_steps} · loss {sum(losses[-50:]) / max(1, len(losses[-50:])):.4f} · {int(time.time() - t0)}s")
                if step >= total_steps:
                    break
        epoch += 1
    if ddp:
        torch.distributed.barrier()
    log(f"training done in {int(time.time() - t0)}s")

    if not is_main:
        # 非主 rank：等主 rank 做完评测/保存后一起退出
        if ddp:
            torch.distributed.barrier()
            torch.distributed.destroy_process_group()
        return 0

    # ---- dev evaluation: generate + mechanical retention (rank 0 only) ----
    model.eval()
    core.config.use_cache = True
    from transformers import GenerationConfig
    gen_cfg = GenerationConfig(max_new_tokens=args.max_new_tokens, do_sample=False, temperature=None, top_p=None, top_k=None, repetition_penalty=1.02, pad_token_id=tok.pad_token_id)
    picks = list(range(0, len(dev_rows), max(1, len(dev_rows) // max(1, args.eval_samples))))[: args.eval_samples]
    results = []
    for i in picks:
        row = dev_rows[i]
        prompt = render(row["messages"][:-1], add_gen=True)
        enc = tok(prompt, return_tensors="pt", add_special_tokens=False).to(core.device)
        with torch.no_grad():
            gen = core.generate(**enc, generation_config=gen_cfg)
        text = tok.decode(gen[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        m = metric_report(row["messages"][-1]["content"] or "", text)  # 相对教师目标报告一次（诊断）
        raw = row_drop_target(row)
        m_vs_raw = metric_report(raw, text)
        results.append({"unitId": row["unitId"], "repo": row["repo"], "predChars": len(text),
                        "teacherTargetChars": len(row["messages"][-1]["content"]),
                        "vsRaw": m_vs_raw, "vsTeacherTarget": m, "prediction": text})
        print(f"  [{i}] {row['unitId']} pred={len(text)}c critCov={m_vs_raw['criticalCoverage']} fullCov={m_vs_raw['fullCoverage']} ratio={m_vs_raw['ratio']}", flush=True)
    agg = {
        "n": len(results),
        "criticalCoverageMean": round(sum(r["vsRaw"]["criticalCoverage"] for r in results) / max(1, len(results)), 4),
        "criticalCoverageMin": min((r["vsRaw"]["criticalCoverage"] for r in results), default=None),
        "fullCoverageMean": round(sum(r["vsRaw"]["fullCoverage"] for r in results) / max(1, len(results)), 4),
        "ratioMean": round(sum(r["vsRaw"]["ratio"] for r in results) / max(1, len(results)), 4),
        "inventedAnchorsTotal": sum(r["vsRaw"]["inventedCount"] for r in results),
    }
    (out / "dev-predictions.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n", encoding="utf-8")
    core.save_pretrained(str(out / "adapter"))
    tok.save_pretrained(str(out / "adapter"))
    meta = {
        "schema": "cfb.gen-compressor-run/1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "modelId": args.model_id, "revision": args.revision, "epochs": args.epochs, "lr": args.lr,
        "maxLen": args.max_len, "batch": args.batch, "gradAccum": args.grad_accum, "worldSize": world_size,
        "effectiveBatch": args.batch * args.grad_accum * world_size,
        "trainRows": len(train_rows), "trainExamplesUsed": len(data), "skippedOverMaxLen": skipped,
        "devRows": len(dev_rows), "evalSamples": len(results), "corpusTrainSha256": corpus_sha,
        "finalLossAvg50": round(sum(losses[-50:]) / max(1, len(losses[-50:])), 4),
        "trainingSeconds": int(time.time() - t0),
        "devMetrics": agg,
        "boundaries": [
            "targets are machine-generated by teacher v0.3 (rulers M1/M3/M4/M5/M6/M7/M8 installed; extractive + verbatim) — NOT reviewed gold; human review count = 0",
            "信息不丢 measured as critical-anchor coverage (verdicts/commands/fenced code/paths); semantic completeness NOT claimed",
            "E1/E2 未测 — require feeding the compressed block back to DeepSeek-V4.1-Flash (endpoint needed)",
            "dev is repo-disjoint from train; metrics are on unseen repositories",
        ],
    }
    (out / "run-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(agg, ensure_ascii=False), flush=True)
    print(f"DONE · artifacts in {out}", flush=True)
    if ddp:
        torch.distributed.barrier()
        torch.distributed.destroy_process_group()
    return 0


if __name__ == "__main__":
    sys.exit(main())
