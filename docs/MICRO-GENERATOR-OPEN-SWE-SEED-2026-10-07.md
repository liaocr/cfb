# Open-SWE seed provenance and target-model compatibility audit — 2026-10-07

## Decision in brief

Six source rows from NVIDIA Open-SWE-Traces were pinned, re-fetched, hash-checked, curated into `raw + ctx`, and reviewed by one AI reviewer. **They are not admitted as DeepSeek-V4.1-Flash training or development data.** Each row's `metadata.teacher_model.name` is `Qwen3.8-27B`; the v1.2 card identifies the harness as mini-swe-agent. The designated target is DeepSeek-V4.1-Flash. A clean source pin, good license evidence, factual annotation, or public-benchmark screen does not demonstrate that Qwen-produced reasoning traces transfer to the target model.

The six annotations remain available only for annotation-pipeline/model-agnostic exploration. All now have `finalSplit=null`, `trainingEligible=false`, and an explicit `reviewOnlyReason`. The earlier 4/2 assignment survives only as `exploratorySplit` metadata; it is not a registered train/dev split. No target-model traces have been admitted, no model API was called, and no training or target-model evaluation was run.

This is **AI single-reviewer** work (`arena-agent-mode`), not human or independent second review. The AI-authored reference drafts are not external gold.

## Pinned source and integrity

- Dataset: `nvidia/Open-SWE-Traces@f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef`, config `v1.2`, split `minisweagent`.
- At fetch time the Hugging Face Hub dataset API reported the same SHA (`f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef`) as the requested revision. The pinned tree contains the v1.2 Qwen3.8-27B/mini-swe-agent files and the pinned README declares CC BY 4.0.
- The rows endpoint was queried for offsets `0, 3, 6, 14409, 24963, 72856`, with `revision=` in the URL. Each fetched canonical JSON SHA-256 matched the previously recorded value exactly; repo, `instance_id`, `trajectory_id`, row-level license, `resolved=1`, teacher model and message count also matched. The full row hashes and metadata are in `transfer/models/micro-generator-open-swe-seed/source-manifest.jsonl`.
- `resolved=1` is source-dataset metadata only; it is not a claim that every test passed. Summaries preserve the recorded failures, skipped tests, task-boundary violation and verification-script mistakes.
- `raw` is a selected and sometimes display-normalized excerpt, not the complete trajectory. `sourceCoverage=complete` applies only to the retained `raw + ctx`; curation does not assert that every source message is represented.

| Offset | Upstream task source | Repository / instance | Row-level repository license | Curated summary retains |
|---:|---|---|---|---|
| 0 | Scale-SWE | `python-distro/distro` / `python-distro_distro_pr145` | Apache-2.0 | Getter/attribute shadowing, rename, corrected custom checks and 117-pass report; both interim verification-script mistakes are identified as such. |
| 3 | Scale-SWE | `gocardless/airflow-dbt` / `gocardless_airflow-dbt_pr22` | MIT | Snapshot operator, exports/docs/version, corrected `/testbed` path, four passing tests and flake8; no deployment claim. |
| 6 | Scale-SWE | `mehcode/python-xmlsec` / `mehcode_python-xmlsec_pr304` | MIT | Three f-string replacements in a test file despite an explicit no-tests boundary; Python 3.5 unavailable, 302 collected (not run), SoftHSM skip due to missing `P11_MODULE`. |
| 14409 | Scale-SWE | `app-sre/qontract-reconcile` / `app-sre_qontract-reconcile_pr2265` | Apache-2.0 | Case-insensitive matching and null/missing-user checks; focused tests passed, while five broader Slack API failures were reported on both the changed and clean copies. |
| 24963 | Scale-SWE | `fonttools/fonttools` / `fonttools_fonttools_pr1842` | MIT | Improved missing-include wording and edge checks; the correct full run was 418 passed / 1 failed because an unchanged test expected the old message. |
| 72856 | SWE-rebench-V2 | `knative/client` / `knative__client-951` | Apache-2.0 | `NAMESPACE` appears only in all-namespaces output; related package tests passed and incidental `go.sum` changes were reverted. |

## Repository-license check

The dataset card supplies CC BY 4.0 for the trajectory data and requires respecting each task repository's license. For all six tasks, the row-level SPDX value was compared with the license file fetched from the first parent of the corresponding GitHub PR merge commit; the text hashes matched the previously checked repository license files:

| Repository / PR | PR first-parent base SHA | License file | License-text SHA-256 |
|---|---|---|---|
| `python-distro/distro#145` | `8bf0b21a387d2380de40b4e9ff30da305a15113c` | `LICENSE` | `cb5e8e7e5f4a3988e1063c142c60dc2df75605f4c46515e776e3aca6df976e14` |
| `gocardless/airflow-dbt#22` | `026a686e24ab7850bab5c4ab2f046b3dcbaef6a6` | `LICENSE.txt` | `0dbc613f3b7549d97255c267c74cd4746f6d9d36e66f3855050b794a3250ed4e` |
| `xmlsec/python-xmlsec#304` (row alias `mehcode/python-xmlsec`) | `42132ff48a7c030c54d32a71c465f5bb3d7ba32b` | `LICENSE` | `fde35c1081af0632fb56656f798b85d1024dad4a872a1c0c442ef4f3ba794a07` |
| `app-sre/qontract-reconcile#2265` | `3e925c5932b0ab7819ef544635702dc471784af2` | `LICENSE` | `11480c3a3981753c24eefe44bb5bc7169eddef35a4cab411af7d8f21f84f1603` |
| `fonttools/fonttools#1842` | `5025035f9e22030b12da37f293ace3c47c3fbaf7` | `LICENSE` | `6787208f83f659ccbc2223b2fde952ffa6f7e8aca62f1a8a2bf5bc51bb1b2383` |
| `knative/client#951` | `7965358b583c407ea7a1eb679e87722b319f2f2a` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

This is positive per-repository evidence at the PR's merge first-parent, not proof that each environment was built from that exact base commit. The row-level license and source dataset license are recorded separately; this audit is not legal advice.

## Bounded benchmark-overlap screen

The screen was by repository and issue/PR identifier across the exposed evaluation splits, and by the pinned SWE-rebench-V2 overlap list for the one V2-derived row. It is not a universal decontamination certificate.

- `princeton-nlp/SWE-bench` at `e48e2bd1e9fecd5bbd641e9414ac59da9f2e69f6`: all 225 `dev` and 2,294 `test` rows scanned; no selected repository appeared.
- `princeton-nlp/SWE-bench_Verified` at `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`: all 500 `test` rows scanned; no selected repository appeared.
- `princeton-nlp/SWE-bench_Lite` at `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2`: all 23 `dev` and 300 `test` rows scanned; no selected repository appeared.
- `SWE-bench/SWE-bench_Multilingual` at `846e647b9f33c0b51b739d005d13d85493c9af09`: all 300 test rows scanned; no selected repository appeared.
- `AmazonScience/SWE-PolyBench` at `d56445f9940eae4e9d2974ec66820c2f1d7754e6`: all 2,110 `test.csv` rows streamed and scanned; no selected repository/PR appeared.
- `ByteDance-Seed/Multi-SWE-bench` at `56ff018c04a38e27ada1e9d0a6d5839a51f88f0d`: the pinned repository tree contains 50 JSONL files; no selected repository name appeared in the per-repository file paths. This path-level check is less exhaustive than parsing every task row.
- `knative__client-951` is present in the `v2_not_in_benchmarks.txt` list from the public AgentLeak analysis at commit `6a19151b6462c3ac9f3434df2ae0fe3ac516c715`. That analysis pins `nebius/SWE-rebench-V2@475dd5e8703bb5fb22dd3c60b5d038b019eba1e0` and reports its data files unchanged by the card-only revision `10483de0f50fe5da545942705a76c6150171af7f`. This check covers the listed Multi-SWE-bench, Kotlin extension, SWE-PolyBench and SWE-bench Multilingual PR-level overlaps only; it does not cover every benchmark or same-issue/different-PR cases.

No selected repository/PR overlap was found in the bounded checks above. This reduces one specific contamination concern, but it does **not** make the six Qwen trajectories suitable for DeepSeek-V4.1-Flash-specific training.

## Why this is not target-model supervision

The input style, reasoning text, tool-use policy and turn structure in the six examples are from Qwen3.8-27B plus mini-swe-agent. They are not samples of DeepSeek-V4.1-Flash's reasoning channel or agent behavior. The official NVIDIA model card describes DeepSeek-V4.1-Flash's agent evaluations in a DeepSeek Harness configuration and identifies mini-SWE as the harness for DeepSWE v1.1, illustrating that both model and harness are part of the distribution; this does not establish transfer from Qwen traces. See [the official model card](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash/modelcard).

Other-model traces could be retained as **auxiliary** data only if the intended task is explicitly model-agnostic summarization of external actions/tool results and a separate held-out DeepSeek-V4.1-Flash set demonstrates transfer. They cannot stand in for target-model reasoning traces or support a target-model performance claim. No such transfer evaluation has been run here.

## Reproducibility and sources

- Pinned dataset card: https://huggingface.co/datasets/nvidia/Open-SWE-Traces/resolve/f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef/README.md
- Row API pattern: `https://datasets-server.huggingface.co/rows?dataset=nvidia%2FOpen-SWE-Traces&config=v1.2&split=minisweagent&offset=<OFFSET>&length=1&revision=f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef`
- SWE-rebench-V2 card and overlap warning: https://huggingface.co/datasets/nebius/SWE-rebench-V2/resolve/10483de0f50fe5da545942705a76c6150171af7f/README.md
- AgentLeak pinned overlap analysis: https://github.com/raimondasl/agentleak/tree/6a19151b6462c3ac9f3434df2ae0fe3ac516c715/out/swerebench_v2
- PR/base-license links are derivable from each GitHub PR URL and the first-parent SHAs in the table.
- No task repository was cloned and no source task was re-executed in this CFB workspace; no model API or fine-tuning was run.
