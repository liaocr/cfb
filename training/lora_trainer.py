#!/usr/bin/env python3
"""可选本地SFT/DPO LoRA worker。仅doctor无需依赖；绝不隐式联网/远程代码/截断目标。"""
import argparse
import array
import hashlib
import importlib.util
import json
import math
import mmap
import os
from pathlib import Path
import random
import shutil
import sys
import tempfile
import time


class TrainingError(Exception):
    pass


def emit(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def read_json(file):
    with open(file, "r", encoding="utf-8") as f:
        return json.load(f)


def digest_file(file):
    h = hashlib.sha256()
    with open(file, "rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def doctor(plan):
    missing = [m for m in ("torch", "transformers", "peft", "safetensors") if importlib.util.find_spec(m) is None]
    model = plan["profile"]["model"]
    root = Path(plan.get("executionPaths", {}).get("modelDirectory") or model.get("path") or "MODEL_PATH_REQUIRED")
    present = root.is_dir() and (root / "config.json").is_file() and any(root.glob("*.safetensors"))
    approved = model.get("licenseAccepted") is True and isinstance(model.get("revision"), str) and len(model["revision"]) == 40 and all(c in "0123456789abcdef" for c in model["revision"])
    return {"schema": "cfb.local-training-doctor/1", "missingDependencies": missing, "modelCached": present, "modelLicenseAndRevisionDeclared": approved,
            "canExecute": not missing and present and approved, "networkCalls": 0, "installsAutomatically": False, "realTrainingVerifiedHere": False}


def encode_completion(tokenizer, messages, target, max_length):
    # 完整chat template+助手监督。边界不一致时拒绝，不能猜mask或截掉RAW/target。
    prefix = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(messages + [{"role": "assistant", "content": target}], tokenize=True, add_generation_prompt=False)
    if not isinstance(full, list) or not isinstance(prefix, list) or full[:len(prefix)] != prefix or len(full) <= len(prefix):
        raise TrainingError("training-template-boundary")
    if len(full) > max_length:
        raise TrainingError("training-sequence-too-long-no-truncation")
    return {"input_ids": full, "labels": [-100] * len(prefix) + full[len(prefix):]}


def encode_record(tokenizer, record, max_length):
    if record["objective"] == "sft":
        return {"target": encode_completion(tokenizer, record["messages"], record["target"], max_length)}
    return {k: encode_completion(tokenizer, record["messages"], record[k], max_length) for k in ("chosen", "rejected")}


def token_cache(plan, tokenizer, split, output):
    info = plan["dataset"]["files"][split]
    source = Path(plan.get("executionPaths", {}).get("datasetDirectory") or plan["dataset"]["directory"]) / info["path"]
    if digest_file(source) != info["sha256"]:
        raise TrainingError("training-dataset-file-drift")
    model_root = Path(plan.get("executionPaths", {}).get("modelDirectory") or plan["profile"]["model"]["path"])
    tokenizer_hash = {p.name: digest_file(p) for p in sorted(model_root.iterdir()) if p.is_file() and ("tokenizer" in p.name or p.name in ("config.json", "vocab.json", "merges.txt", "special_tokens_map.json"))}
    identity = {"file": info["sha256"], "tokenizer": tokenizer_hash, "revision": plan["profile"]["model"]["revision"], "maxLength": plan["profile"]["recipe"]["maxSeqLength"], "objective": plan["dataset"]["objective"]}
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    root = output / ("tokens-" + fingerprint)
    if root.exists():
        manifest = read_json(root / "cache.json")
        if manifest["identity"] != identity or any(digest_file(root / f) != d for f, d in manifest["sha256"].items()):
            raise TrainingError("training-token-cache-drift")
        return root, read_json(root / "rows.json")
    stage = Path(tempfile.mkdtemp(prefix=".tokens-", dir=output))
    rows, offset = [], 0
    try:
        with open(stage / "input_ids.bin", "wb") as inputs, open(stage / "labels.bin", "wb") as labels, open(source, encoding="utf-8") as f:
            for line in f:
                record = json.loads(line)
                encoded = encode_record(tokenizer, record, identity["maxLength"])
                row = {"uid": record["uid"], "parts": {}}
                for name, values in encoded.items():
                    ids, lab = array.array("i", values["input_ids"]), array.array("i", values["labels"])
                    if ids.itemsize != 4:
                        raise TrainingError("training-int32-platform")
                    row["parts"][name] = {"offset": offset, "length": len(ids)}
                    ids.tofile(inputs); lab.tofile(labels); offset += len(ids)
                rows.append(row)
            inputs.flush(); os.fsync(inputs.fileno()); labels.flush(); os.fsync(labels.fileno())
        (stage / "rows.json").write_text(json.dumps(rows), encoding="utf-8")
        manifest = {"identity": identity, "sha256": {n: digest_file(stage / n) for n in ("input_ids.bin", "labels.bin", "rows.json")}}
        (stage / "cache.json").write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        os.rename(stage, root)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return root, rows


TOKEN_FILES = {}


def read_token_row(cache, info):
    result = {}
    for name, file in (("input_ids", "input_ids.bin"), ("labels", "labels.bin")):
        key = str(cache / file)
        if key not in TOKEN_FILES:
            fd = os.open(key, os.O_RDONLY)
            try:
                TOKEN_FILES[key] = mmap.mmap(fd, 0, access=mmap.ACCESS_READ)
            finally:
                os.close(fd)
        start = info["offset"] * 4
        values = array.array("i")
        values.frombytes(TOKEN_FILES[key][start:start + info["length"] * 4])
        result[name] = values.tolist()
    return result


def run(plan, output, resume=None):
    # 不继承任何模型/GitHub凭据，不在缓存miss时自动下载。
    for key in list(os.environ):
        if any(x in key.upper() for x in ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")):
            os.environ.pop(key, None)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1")
    if not doctor(plan)["canExecute"]:
        raise TrainingError("training-local-dependencies-or-model-missing")
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, PeftModel
    cfg, model_cfg = plan["profile"]["recipe"], plan["profile"]["model"]
    model_path = plan.get("executionPaths", {}).get("modelDirectory") or model_cfg["path"]
    random.seed(cfg["seed"]); torch.manual_seed(cfg["seed"])
    output.mkdir(parents=True, exist_ok=True)
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    # 先完整tokenize/检查目标，再分配模型/GPU；cache不包含test。
    cache, rows = token_cache(plan, tokenizer, "train", output)
    if not rows:
        raise TrainingError("training-no-records")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if cfg["precision"] != "fp32" and device != "cuda":
        raise TrainingError("training-mixed-precision-device")
    dtype = {"fp32": torch.float32, "bf16": torch.bfloat16, "fp16": torch.float16}[cfg["precision"]]
    base = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=dtype)
    if resume:
        previous = read_json(resume / "trainer_state.json")
        if previous["planDigest"] != plan["digest"]:
            raise TrainingError("training-resume-plan-drift")
        model = PeftModel.from_pretrained(base, str(resume), is_trainable=True, local_files_only=True)
    else:
        model = get_peft_model(base, LoraConfig(r=cfg["loraRank"], lora_alpha=cfg["loraAlpha"], lora_dropout=cfg["loraDropout"], target_modules=cfg["targetModules"], bias="none", task_type="CAUSAL_LM"))
        previous = {"step": 0, "cursor": 0, "elapsedMs": 0}
    model.to(device); model.config.use_cache = False
    if hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable(); model.enable_input_require_grads()
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=cfg["learningRate"])
    scaler = torch.amp.GradScaler("cuda", enabled=cfg["precision"] == "fp16")
    if resume:
        state = torch.load(resume / "optimizer.pt", map_location="cpu", weights_only=True)
        optimizer.load_state_dict(state["optimizer"]); torch.set_rng_state(state["torchRng"]); random.setstate(state["pythonRng"]); scaler.load_state_dict(state["scaler"])
        if device == "cuda" and state.get("cudaRng"):
            torch.cuda.set_rng_state_all(state["cudaRng"])
    total_batches = math.ceil(len(rows) / cfg["batchSize"]) * cfg["epochs"]
    steps = min(cfg["maxSteps"], math.ceil(total_batches / cfg["gradientAccumulation"]))
    cursor, step, start = previous["cursor"], previous["step"], time.monotonic()
    elapsed_base = previous["elapsedMs"]
    def batch(part, indices):
        values = [read_token_row(cache, rows[i]["parts"][part]) for i in indices]
        width = max(len(v["input_ids"]) for v in values)
        return {"input_ids": torch.tensor([v["input_ids"] + [tokenizer.pad_token_id] * (width-len(v["input_ids"])) for v in values], device=device),
                "labels": torch.tensor([v["labels"] + [-100] * (width-len(v["labels"])) for v in values], device=device),
                "attention_mask": torch.tensor([[1] * len(v["input_ids"]) + [0] * (width-len(v["input_ids"])) for v in values], device=device)}
    def logp(b):
        logits = model(input_ids=b["input_ids"], attention_mask=b["attention_mask"]).logits[:, :-1].float()
        labels = b["labels"][:, 1:]; mask = labels != -100
        selected = torch.log_softmax(logits, dim=-1).gather(-1, labels.clamp(min=0).unsqueeze(-1)).squeeze(-1)
        return (selected * mask).sum(-1)
    def objective(indices):
        if plan["dataset"]["objective"] == "sft":
            return model(**batch("target", indices)).loss
        chosen, rejected = batch("chosen", indices), batch("rejected", indices)
        model.eval()
        with torch.no_grad(), model.disable_adapter():
            reference = logp(chosen) - logp(rejected)
        model.train()
        return -torch.nn.functional.logsigmoid(cfg["preferenceBeta"] * ((logp(chosen) - logp(rejected)) - reference)).mean()
    cached_epoch, order = None, None
    while step < steps:
        if elapsed_base + (time.monotonic()-start)*1000 > plan["profile"]["limits"]["maxWallSeconds"]*1000:
            raise TrainingError("training-wall-budget")
        optimizer.zero_grad(set_to_none=True); values = []
        accumulation = min(cfg["gradientAccumulation"], total_batches - cursor)
        for _ in range(accumulation):
            if cursor >= total_batches:
                break
            per_epoch = math.ceil(len(rows)/cfg["batchSize"]); epoch, at = divmod(cursor, per_epoch)
            if cached_epoch != epoch:
                order = list(range(len(rows))); random.Random(cfg["seed"]+epoch).shuffle(order); cached_epoch = epoch
            indices = order[at*cfg["batchSize"]:(at+1)*cfg["batchSize"]]
            model.train(); value = objective(indices); values.append(float(value.detach().cpu()));
            if not math.isfinite(values[-1]):
                raise TrainingError("training-nonfinite-loss")
            scaler.scale(value/accumulation).backward(); cursor += 1
        scaler.unscale_(optimizer); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); scaler.step(optimizer); scaler.update(); step += 1
        emit({"event": "step", "step": step, "loss": sum(values)/len(values), "testRead": False})
        if step % cfg["checkpointEvery"] == 0 or step == steps:
            destination = output / ("step-%08d" % step)
            if destination.exists():
                raise TrainingError("training-checkpoint-exists")
            stage = Path(tempfile.mkdtemp(prefix=".checkpoint-", dir=output))
            try:
                model.save_pretrained(stage, safe_serialization=True); tokenizer.save_pretrained(stage)
                torch.save({"optimizer": optimizer.state_dict(), "torchRng": torch.get_rng_state(), "pythonRng": random.getstate(), "scaler": scaler.state_dict(), "cudaRng": torch.cuda.get_rng_state_all() if device == "cuda" else None}, stage/"optimizer.pt")
                metadata = {"schema": "cfb.lora-checkpoint/1", "planDigest": plan["digest"], "step": step, "cursor": cursor, "elapsedMs": elapsed_base+(time.monotonic()-start)*1000, "candidateOnly": True, "testRead": False}
                (stage/"trainer_state.json").write_text(json.dumps(metadata), encoding="utf-8")
                for f in stage.iterdir():
                    if f.is_file():
                        with open(f, "rb") as opened:
                            os.fsync(opened.fileno())
                os.rename(stage, destination)
            except BaseException:
                shutil.rmtree(stage, ignore_errors=True); raise
            emit({"event": "checkpoint", "step": step, "directory": str(destination), "productionActivated": False})
    emit({"event": "candidate", "steps": step, "productionActivated": False, "realEvaluationPassed": False})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True); parser.add_argument("--doctor", action="store_true"); parser.add_argument("--execute", action="store_true"); parser.add_argument("--operator-approved", action="store_true")
    parser.add_argument("--output"); parser.add_argument("--resume")
    args = parser.parse_args(); plan = read_json(args.plan)
    if plan.get("schema") != "cfb.training-plan/1" or plan["profile"]["backend"] != "local-lora":
        raise TrainingError("training-worker-plan")
    if args.doctor or not args.execute:
        emit(doctor(plan)); return
    if not args.operator_approved or not args.output or plan["simulated"]:
        raise TrainingError("training-local-operator-approval-required")
    # Node协调器必须先验HMAC数据审核/批准/水位；worker是显式可信宿主入口，不是OS沙箱。
    run(plan, Path(args.output), Path(args.resume) if args.resume else None)


if __name__ == "__main__":
    try:
        main()
    except TrainingError as e:
        emit({"error": str(e), "candidateOnly": True}); sys.exit(2)
    except Exception as e:
        emit({"error": "training-worker-" + type(e).__name__, "candidateOnly": True}); sys.exit(1)
