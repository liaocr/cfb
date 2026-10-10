
import fs from 'node:fs';
const F = 'deploy/kaggle/train_rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

// dev_loss / generate 只在 0 号 rank 干活（与 v9 语义一致）
rep('    def dev_loss():\n        if not dev_encoded:\n            return None',
    '    def dev_loss():\n        if not (dev_encoded and is_main):\n            return None',
    'devloss-guard');

// ── 4. 学习曲线点 ──
rep('    # ---- 8. dev \u635f\u5931\uff08\u53ea 0 \u53f7 rank\uff0c\u8d70\u672a\u5305\u88f9\u53e5\u67c4\uff09----',
'    # ---- 7c. \u5b66\u4e60\u66f2\u7ebf\u70b9 ----\n' +
'    #\n' +
'    # \u4e3a\u4ec0\u4e48\u8981\u6709\u8fd9\u4e2a\uff1a\u4e0a\u4e00\u8f6e\u53ea\u6709**\u4e00\u4e2a\u7ec8\u70b9**\uff08\u6b65\u6570 40\uff09\uff0c\u4e8e\u662f\u201c\u6b20\u8bad\u201d\u548c\u201c\u76ee\u6807\u51fd\u6570\u4e0d\u5bf9\u201d\n' +
'    # \u8fd9\u4e24\u4e2a\u5b8c\u5168\u4e0d\u540c\u7684\u8bca\u65ad\u5728\u6570\u636e\u4e0a**\u4e0d\u53ef\u5206\u79bb**\u3002\u4e00\u6761\u66f2\u7ebf\u5c31\u80fd\u5206\u5f00\uff1a\n' +
'    #   \u66f2\u7ebf\u8fd8\u5728\u4e0a\u5347  => \u6b20\u8bad\uff0c\u52a0\u6b65\u6570/\u52a0\u6570\u636e\u6709\u7528\uff1b\n' +
'    #   \u66f2\u7ebf\u5e73\u4e86    => \u4e0d\u662f\u6b20\u8bad\uff0c\u95ee\u9898\u5728\u76ee\u6807\u51fd\u6570\uff08\u4ea4\u53c9\u71b5\u8868\u8fbe\u4e0d\u4e86\u201c\u8fd9\u4e00\u4e2a token \u662f\u81f4\u547d\u7684\u201d\uff09\u3002\n' +
'    # \u66f2\u7ebf\u4e0a\u6bcf\u4e2a\u70b9\u90fd\u8981\u540c n \u624d\u80fd\u76f8\u6bd4 \u2014\u2014 n \u4e0d\u540c\u7684\u4e24\u70b9\u6ca1\u6709\u53ef\u6bd4\u6027\uff0c\u8fd9\u4e00\u70b9\u5fc5\u987b\u5199\u6b7b\u5728\u8fd9\u91cc\u3002\n' +
'    ckpt_set = set()\n' +
'    if args.ckpt_steps:\n' +
'        try:\n' +
'            ckpt_set = {int(x) for x in str(args.ckpt_steps).replace("\uff0c", ",").split(",") if x.strip()}\n' +
'        except ValueError:\n' +
'            print(f"FATAL: --ckpt-steps \u89e3\u6790\u4e0d\u4e86\uff1a{args.ckpt_steps!r}", file=sys.stderr)\n' +
'            return 2\n' +
'        ckpt_set = {x for x in ckpt_set if 0 < x < total_steps}\n' +
'        print(f"\u00b7 \u5b66\u4e60\u66f2\u7ebf\u5feb\u7167\u6b65\u6570\uff1a{sorted(ckpt_set)}\uff08\u5171 {total_steps} \u6b65\uff09", flush=True)\n' +
'    curve = []\n' +
'    ckpt_gen_n = args.ckpt_gen_n or args.gen_n\n' +
'\n' +
'    def curve_point(at_step):\n' +
'        """\u5728\u4e00\u4e2a\u6b65\u6570\u4e0a\u91c7\u4e00\u4e2a\u70b9\u3002**\u4e24\u4e2a rank \u90fd\u5fc5\u987b\u8c03\u7528** \u2014\u2014 \u91cc\u9762\u6709 barrier\u3002"""\n' +
'        nonlocal t0\n' +
'        was_training = model.training\n' +
'        dl = dev_loss()\n' +
'        # \u751f\u6210\u671f\u95f4\u5fc5\u987b\u5173\u68af\u5ea6\u68c0\u67e5\u70b9\uff1atransformers \u4f1a\u56e0\u4e3a\u5b83\u4e0e use_cache \u4e0d\u517c\u5bb9\u800c\u628a\u72b6\u6001\u7f13\u5b58\u4e00\u5e76\u5173\u6389\uff0c\n' +
'        # \u4e8e\u662f\u6bcf\u5410\u4e00\u4e2a token \u90fd\u91cd\u7b97\u6574\u6bb5 prompt\uff08O(n^2)\uff09\u3002\u8fd9\u4e0d\u662f\u63a8\u6f14\uff0c\u662f\u5192\u70df v5 \u5b9e\u6d4b\uff1a256 token 37.5s\u3002\n' +
'        if args.grad_ckpt:\n' +
'            base_model.gradient_checkpointing_disable()\n' +
'        try:\n' +
'            n = generate(ckpt_gen_n, out_dir / f"dev-generations-step{at_step}.jsonl")\n' +
'        finally:\n' +
'            if args.grad_ckpt:\n' +
'                base_model.gradient_checkpointing_enable()\n' +
'        if is_main:\n' +
'            rec = {"step": at_step, "devLoss": None if dl is None else round(dl, 4),\n' +
'                   "genRows": n, "genFile": f"dev-generations-step{at_step}.jsonl",\n' +
'                   "minutes": round((time.time() - t0) / 60, 1)}\n' +
'            curve.append(rec)\n' +
'            print(f"\u00b7 \u3010\u5b66\u4e60\u66f2\u7ebf\u3011step {at_step} \u00b7 dev loss "\n' +
'                  f"{rec[\'devLoss\']} \u00b7 \u751f\u6210 {n} \u6761 \u00b7 \u5df2\u7528 {rec[\'minutes\']}m", flush=True)\n' +
'            (out_dir / "learning-curve.json").write_text(\n' +
'                json.dumps(curve, ensure_ascii=False, indent=2), encoding="utf-8")\n' +
'        # \u56de\u5230\u8bad\u7ec3\u6a21\u5f0f\u3002\u4e0d\u6062\u590d\u7684\u8bdd\u540e\u9762\u7684 step \u5168\u5728 eval \u6a21\u5f0f\u4e0b\u8dd1 \u2014\u2014\n' +
'        # \u4e0d\u4f1a\u62a5\u9519\uff0c\u53ea\u662f BatchNorm/Dropout \u884c\u4e3a\u53d8\u4e86\uff0c\u800c RWKV7 \u91cc dropout \u786e\u5b9e\u5b58\u5728\u3002\n' +
'        if was_training:\n' +
'            model.train()\n' +
'        if world > 1:\n' +
'            torch.distributed.barrier()\n' +
'\n' +
'    # ---- 8. dev \u635f\u5931\uff08\u53ea 0 \u53f7 rank\uff0c\u8d70\u672a\u5305\u88f9\u53e5\u67c4\uff09----',
    'curve-point');

// ── 5. \u65e7\u7684\u7b2c 8 \u8282\u4e3b\u4f53\u6362\u6210\u8c03\u7528 ──
rep('    if dev_encoded and is_main:\n' +
    '        base_model.eval()\n' +
    '        tot, cnt = 0.0, 0\n' +
    '        with torch.no_grad():\n' +
    '            for i in range(0, len(dev_encoded), args.batch):\n' +
    '                chunk = [p for _, p in dev_encoded[i:i + args.batch]]\n' +
    '                ids, lab, am = collate(chunk)\n' +
    '                with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):\n' +
    '                    tot += float(base_model(input_ids=ids, attention_mask=am, labels=lab).loss)\n' +
    '                cnt += 1\n' +
    '        print(f"\u00b7 dev loss {tot/max(1,cnt):.4f}\uff08{len(dev_encoded)} \u6761\uff09", flush=True)',
    '    dl_final = dev_loss()\n' +
    '    if dl_final is not None:\n' +
    '        print(f"\u00b7 dev loss {dl_final:.4f}\uff08{len(dev_encoded)} \u6761\uff09", flush=True)',
    'sec8');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
