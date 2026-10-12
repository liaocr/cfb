"""CPU-only repair checks. Synthetic revisions/receipts are fixtures, not model evidence."""
from __future__ import annotations
import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
trainer = load("cfb_trainer_contract_test", "deploy/kaggle/train_rwkv7.py")
launcher = load("cfb_launcher_contract_test", "deploy/kaggle/start-rwkv7.py")
REV = "a" * 40  # synthetic fixture only; never sent to Hugging Face

def row(identifier="train-id", repo="train-repo", user="train input"):
    return dict(id=identifier, repo=repo, system="fixture system", user=user, assistant="fixture short continuation")

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cfb-trainer-contract-")
        self.dir = Path(self.temp.name)
        self.train, self.dev = self.dir / "train.jsonl", self.dir / "dev.jsonl"
        self.write(self.train, [row()])
        self.write(self.dev, [row("dev-id", "dev-repo", "dev input")])
    def tearDown(self):
        self.temp.cleanup()
    def write(self, path, rows):
        path.write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")
    def args(self, **extra):
        values = dict(data=str(self.train), dev=str(self.dev), model=trainer.MODEL_ID,
                      model_revision=REV, admission=None, smoke=True)
        values.update(extra)
        return SimpleNamespace(**values)
    def admission(self, validity="VALID"):
        report = self.dir / "ruler.json"
        report.write_text(json.dumps({"validity": {"determinism": "PASS", "negativeControls": "PASS", "VALID": validity}}), encoding="utf-8")
        manifest = dict(schema="cfb.sft-admission/1", status="admitted",
                        model={"id": trainer.MODEL_ID, "revision": REV},
                        artifacts={"train": {"sha256": trainer.file_sha256(self.train), "rows": 1},
                                   "dev": {"sha256": trainer.file_sha256(self.dev), "rows": 1}},
                        review={"status": "complete", "reviewerId": "synthetic-fixture-ai"},
                        ruler={"report": "ruler.json", "sha256": trainer.file_sha256(report)})
        path = self.dir / "admission.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path
    def test_import_is_cpu_only(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("transformers", sys.modules)
    def test_js_json_wire_number_and_unicode_boundaries(self):
        self.assertEqual(trainer.compact_json([1.0, -0.0, 1e-7, 1e-6, 1e20, 1e21]), '[1,0,1e-7,0.000001,100000000000000000000,1e+21]')
        self.assertEqual(trainer.compact_json({"17": "x", "2": "y", "01": "z"}), '{"2":"y","17":"x","01":"z"}')
        self.assertEqual(trainer.compact_json("\ud800"), '"\\ud800"')
        self.assertEqual(trainer.js_utf8("\ud800"), "\ufffd".encode())
        for value in [float("nan"), float("inf"), 9007199254740993]:
            with self.assertRaises(ValueError):
                trainer.compact_json(value)
    def test_complete_coverage_uses_ecmascript_not_python_whitespace(self):
        trainer.complete_text_units("A\ufeff", [{"start": 0, "end": 1, "quote": "A"}], "fixture")
        with self.assertRaisesRegex(ValueError, "coverage-gap"):
            trainer.complete_text_units("A\u0085", [{"start": 0, "end": 1, "quote": "A"}], "fixture")
    def test_false_ai_identity_cannot_survive_review_rebinding(self):
        a = trainer.read_jsonl(ROOT / "transfer/program-2026-10-12/reviewed-dev.jsonl")[0]
        r = trainer.read_jsonl(ROOT / "transfer/program-2026-10-12/complete-reviews.jsonl")[0]
        a["trainingEligible"] = True; a["reviewProvenance"]["reviewerType"] = "human"
        r["annotationSha256"] = trainer.compact_sha256(a)
        with self.assertRaisesRegex(ValueError, "provenance"):
            trainer.validate_attached_complete_review(a, r)
    def test_pin_required(self):
        for revision in [None, "main", "short", "A" * 40]:
            with self.assertRaisesRegex(ValueError, "model-revision"):
                trainer.preflight_sft(self.args(model_revision=revision))
    def test_smoke_integrity_is_not_admission(self):
        result = trainer.preflight_sft(self.args())
        self.assertFalse(result["trainingApproved"])
        self.assertEqual(result["trainRows"], 1)
        self.assertEqual(result["modelRevision"], REV)
    def test_empty_train_or_dev_fails(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            trainer.validate_sft_rows([], [row()])
        with self.assertRaisesRegex(ValueError, "empty"):
            trainer.validate_sft_rows([row()], [])
    def test_fields_are_not_silently_coerced(self):
        for field in ["id", "repo", "system", "user", "assistant"]:
            bad = row(); bad[field] = 123
            with self.assertRaisesRegex(ValueError, "field"):
                trainer.validate_sft_rows([bad], [], smoke=True)
    def test_unknown_repo_fails(self):
        with self.assertRaisesRegex(ValueError, "unknown-repository"):
            trainer.validate_sft_rows([row(repo="unknown")], [], smoke=True)
    def test_duplicate_id_fails(self):
        with self.assertRaisesRegex(ValueError, "duplicate-id"):
            trainer.validate_sft_rows([row(), row()], [], smoke=True)
    def test_duplicate_input_is_not_an_independent_example(self):
        with self.assertRaisesRegex(ValueError, "duplicate-input"):
            trainer.validate_sft_rows([row(), row(identifier="different-id")], [], smoke=True)
    def test_conflicting_targets_fail(self):
        other = row(identifier="other"); other["assistant"] = "contradiction"
        with self.assertRaisesRegex(ValueError, "conflicting-target"):
            trainer.validate_sft_rows([row(), other], [], smoke=True)
    def test_repository_leakage_fails(self):
        with self.assertRaisesRegex(ValueError, "repository-leakage"):
            trainer.validate_sft_rows([row()], [row("dev", "train-repo", "different input")])
    def test_mixed_prompts_fail(self):
        other = row("dev", "dev-repo", "dev input"); other["system"] = "rewritten prompt"
        with self.assertRaisesRegex(ValueError, "mixed-system"):
            trainer.validate_sft_rows([row()], [other])
    def test_training_requires_admission(self):
        with self.assertRaisesRegex(ValueError, "admission-required"):
            trainer.preflight_sft(self.args(smoke=False))
    def test_invalid_ruler_cannot_sign_admission(self):
        admission = self.admission("INVALID")
        with self.assertRaisesRegex(ValueError, "ruler-invalid"):
            trainer.preflight_sft(self.args(smoke=False, admission=str(admission)))
    def test_declared_admission_binds_content(self):
        admission = self.admission()
        with self.assertRaisesRegex(ValueError, "formal-lineage-required"):
            trainer.preflight_sft(self.args(smoke=False, admission=str(admission)))
        self.write(self.train, [row(user="changed input")])
        with self.assertRaisesRegex(ValueError, "artifact-mismatch"):
            trainer.preflight_sft(self.args(smoke=False, admission=str(admission)))
    def test_complete_review_records_are_checked_not_only_booleans(self):
        # Temporarily rebind a development annotation for a structural unit fixture.
        # No data file/split is changed in the repository and no admission is granted.
        import copy
        a = trainer.read_jsonl(ROOT / "transfer/program-2026-10-12/reviewed-dev.jsonl")[0]
        r = trainer.read_jsonl(ROOT / "transfer/program-2026-10-12/complete-reviews.jsonl")[0]
        a["trainingEligible"] = True
        r["annotationSha256"] = trainer.compact_sha256(a)
        trainer.validate_attached_complete_review(a, r)
        bad = copy.deepcopy(r)
        bad["sourceUnits"]["raw"] = bad["sourceUnits"]["raw"][1:]
        with self.assertRaisesRegex(ValueError, "coverage-gap"):
            trainer.validate_attached_complete_review(a, bad)
        bad = copy.deepcopy(r)
        bad["draftClaims"][0]["status"] = "unsupported"
        with self.assertRaisesRegex(ValueError, "unsafe-or-duplicate"):
            trainer.validate_attached_complete_review(a, bad)
        partial = copy.deepcopy(a)
        partial["sourceCoverage"] = "partial"
        with self.assertRaisesRegex(ValueError, "annotation-incomplete"):
            trainer.validate_attached_complete_review(partial, r)
    def test_utf16_coverage_and_known_gap_fail(self):
        text = "🧪 value 42"
        trainer.utf16_span(text, {"start": 0, "end": 2, "quote": "🧪"}, "emoji")
        with self.assertRaisesRegex(ValueError, "span-quote"):
            trainer.utf16_span(text, {"start": 0, "end": 1, "quote": "🧪"}, "emoji")
        with self.assertRaisesRegex(ValueError, "coverage-gap"):
            trainer.complete_text_units(text, [{"start": 3, "end": 11, "quote": "value 42"}], "emoji")
    def test_ruler_report_drift_fails(self):
        admission = self.admission()
        (self.dir / "ruler.json").write_text('{"validity":{"VALID":"INVALID"}}')
        with self.assertRaisesRegex(ValueError, "missing-or-drifted"):
            trainer.preflight_sft(self.args(smoke=False, admission=str(admission)))
    def test_bad_json_has_line_number(self):
        self.train.write_text('{broken\n')
        with self.assertRaisesRegex(SystemExit, r"train.jsonl:1"):
            trainer.read_jsonl(self.train)
    def test_no_prompt_supervision_or_boundary_drift(self):
        class Tokenizer:
            def apply_chat_template(self, *args, **kwargs):
                return "P:input->"
            def __call__(self, text, **kwargs):
                return {"input_ids": [ord(c) for c in text]}
        encoded, drift = trainer.encode(Tokenizer(), row(), 500, 999)
        ids, labels = encoded
        p = len("P:input->")
        self.assertEqual(labels[:p], [-100] * p)
        self.assertEqual(labels[p:], ids[p:])
        self.assertEqual(ids[-1], 999)
        self.assertEqual(drift, 0)
        self.assertEqual(trainer.encode(Tokenizer(), row(), 1, 999), (None, 0))
    def test_ddp_equal_steps_and_dropped_examples_rotate(self):
        rows = [([i] * (2 + i % 16), [i]) for i in range(79)]
        seen, schedules = set(), []
        for epoch in range(8):
            a, da = trainer.epoch_batches(rows, 4, 3, 2, 0, 71, epoch)
            b, db = trainer.epoch_batches(rows, 4, 3, 2, 1, 71, epoch)
            self.assertEqual(len(a), len(b)); self.assertEqual(da, db)
            self.assertEqual(len(a) % 3, 0)
            ids_a = [x[0][0] for batch in a for x in batch]
            ids_b = [x[0][0] for batch in b for x in batch]
            self.assertFalse(set(ids_a) & set(ids_b))
            seen.update(ids_a + ids_b); schedules.append(ids_a)
        self.assertEqual(seen, set(range(79)))
        self.assertNotEqual(schedules[0], schedules[1])
        self.assertEqual(trainer.epoch_batches(rows, 4, 3, 2, 0, 71, 0)[0], trainer.epoch_batches(rows, 4, 3, 2, 0, 71, 0)[0])
    def test_eos_requires_explicit_mismatch_contract(self):
        # 42 is a synthetic stand-in, NOT the real tokenizer's measured EOS.
        self.assertEqual(trainer.resolve_eos_id(0, 0, 65536), 0)
        with self.assertRaisesRegex(ValueError, "mismatch"):
            trainer.resolve_eos_id(42, 0, 65536)
        self.assertEqual(trainer.resolve_eos_id(42, 0, 65536, 0), 0)
        for invalid in [None, "\n\n", -1, 65536, True]:
            with self.assertRaisesRegex(ValueError, "vocabulary"):
                trainer.resolve_eos_id(invalid, 0, 65536)
    def test_template_typeerror_does_not_silently_enable_thinking(self):
        class OldTokenizer:
            def apply_chat_template(self, *args, **kwargs):
                if "enable_thinking" in kwargs:
                    raise TypeError("unsupported")
                return "Assistant: <think"
        with self.assertRaisesRegex(ValueError, "enable_thinking"):
            trainer.render(OldTokenizer(), [], True)
    def test_interior_eos_is_not_a_trainable_completion(self):
        class Tokenizer:
            def apply_chat_template(self, *args, **kwargs):
                return "prompt"
            def __call__(self, text, **kwargs):
                return {"input_ids": [1, 2] if text == "prompt" else [3, 999, 4]}
        with self.assertRaisesRegex(ValueError, "interior-eos"):
            trainer.encode(Tokenizer(), row(), 500, 999)
    def test_native_tokenizer_must_not_emit_ids_outside_pinned_embeddings(self):
        class Tokenizer:
            def apply_chat_template(self, *args, **kwargs):
                return "prompt"
            def __call__(self, text, **kwargs):
                return {"input_ids": [10, 65536] if text == "prompt" else [3, 4]}
        with self.assertRaisesRegex(ValueError, "outside-pinned"):
            trainer.encode(Tokenizer(), row(), 500, 0, 65536)
    def test_cli_hyperparameter_errors_are_cpu_only_and_nonzero(self):
        for option, value in [("--lr", "nan"), ("--epochs", "0"), ("--batch", "0"), ("--accum", "-1"), ("--max-len", "0")]:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = trainer.main(["--data", str(self.train), "--model-revision", REV, "--preflight-only", "--smoke", option, value])
            self.assertEqual(rc, 2)
        self.assertNotIn("torch", sys.modules)
    def test_insufficient_batches_fail_instead_of_zero_step_success(self):
        with self.assertRaisesRegex(ValueError, "one-optimizer-step"):
            trainer.epoch_batches([([1], [1])], 4, 8, 2, 0, 0, 0)
    def test_preflight_cli_has_no_torch_or_network(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            result = trainer.main(["--data", str(self.train), "--dev", str(self.dev),
                                   "--model-revision", REV, "--smoke", "--preflight-only"])
        self.assertEqual(result, 0)
        self.assertFalse(json.loads(out.getvalue())["trainingApproved"])
        self.assertNotIn("torch", sys.modules)
    def test_kernel_uses_staged_input_and_immutable_model(self):
        code = launcher.build_kernel("train", {"epochs": 3}, "/kaggle/input/fixture-data", REV)
        entry = code.rsplit("sys.exit(main(", 1)[1].split("))", 1)[0]
        args = json.loads(entry)
        self.assertEqual(args[args.index("--model-revision") + 1], REV)
        self.assertEqual(args[args.index("--data") + 1], "/kaggle/input/fixture-data/train.jsonl")
        self.assertFalse(any(x.startswith("http") for x in args))
    def test_default_bundle_preparation_does_not_read_credentials_or_push(self):
        bundle = self.dir / "bundle"
        argv = ["launcher", "--smoke", "--prepare-only", "--data", str(self.train), "--dev", str(self.dev),
                "--model-revision", REV, "--bundle-dir", str(bundle)]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(launcher, "username", side_effect=AssertionError("credentials read")), mock.patch.object(launcher.subprocess, "run", side_effect=AssertionError("remote process")), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.main(), 0)
        result = json.loads((bundle / "BUNDLE.json").read_text())
        self.assertFalse(result["executed"])
        self.assertFalse(result["bundlePreflight"]["trainingApproved"])
        self.assertEqual(result["preflight"]["trainSha256"], result["bundlePreflight"]["trainSha256"])
        self.assertNotIn("torch", sys.modules)

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ContractTests)
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=1).run(suite)
    failures = len(result.failures) + len(result.errors)
    print(f"PASS={result.testsRun - failures} FAIL={failures} SKIP={len(result.skipped)}")
    sys.exit(0 if result.wasSuccessful() else 1)
