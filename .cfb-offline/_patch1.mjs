
import fs from 'node:fs';
const F = 'deploy/kaggle/train_rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

// ── 1. 新参数 ──
rep(
  '    ap.add_argument("--no-gen-cache", dest="gen_cache", action="store_false", default=True,',
  '    ap.add_argument("--ckpt-steps", default="",\n' +
  '                    help="\u5b66\u4e60\u66f2\u7ebf\u5feb\u7167\u7684\u6b65\u6570\uff0c\u9017\u53f7\u5206\u9694\uff08\u5982 40,120\uff09\u3002\u5230\u70b9\u5c31 dev loss + \u751f\u6210\u4e00\u6b21\uff0c\u7136\u540e\u63a5\u7740\u8bad\u3002\u7a7a=\u4e0d\u5feb\u7167")\n' +
  '    ap.add_argument("--ckpt-gen-n", type=int, default=0,\n' +
  '                    help="\u5feb\u7167\u70b9\u751f\u6210\u591a\u5c11\u6761\uff080=\u7528 --gen-n\uff09\u3002\u66f2\u7ebf\u4e0a\u7684\u70b9\u8981\u540c n \u624d\u80fd\u76f8\u6bd4")\n' +
  '    ap.add_argument("--no-gen-cache", dest="gen_cache", action="store_false", default=True,',
  'args-ckpt');

// ── 2. DDP 步数对齐（潜伏 bug：412 条会让两张卡跑不同步数 -> 静默挂死）──
rep(
  '    batches = batch_rows(encoded, args.batch)\n' +
  '    if world > 1:\n' +
  '        # \u6bcf\u5f20\u5361\u5206\u8d70\u4e00\u90e8\u5206\u5fae\u6279\uff0c\u68af\u5ea6\u7531 DDP \u540c\u6b65 \u21d2 \u7b49\u4ef7\u4e8e\u628a\u6709\u6548\u6279\u518d\u653e\u5927 world \u500d\u3002\n' +
  '        batches = batches[local_rank::world]\n' +
  '        print(f"\u00b7 rank {local_rank} \u5206\u5230 {len(batches)} \u4e2a\u5fae\u6279", flush=True)\n' +
  '    steps_per_epoch = max(1, len(batches) // args.accum)\n' +
  '    total_steps = max(1, int(steps_per_epoch * args.epochs))',
  '    batches = batch_rows(encoded, args.batch)\n' +
  '    # \u26a0 DDP \u4e0b\u6bcf\u5f20\u5361\u5fc5\u987b\u8d70**\u540c\u6837\u591a**\u7684\u6b65\u6570\uff0c\u5426\u5219\u5148\u8dd1\u5b8c\u7684\u90a3\u5f20\u5361\u4f1a\u5728\u4e0b\u4e00\u6b21\u96c6\u5408\u901a\u4fe1\u4e0a\n' +
  '    #   \u6c38\u4e45\u7b49\u5f85 \u2014\u2014 \u8868\u73b0\u4e3a\u6574\u8f6e\u9759\u9ed8\u6302\u6b7b\uff1a\u65e5\u5fd7\u505c\u5728\u6700\u540e\u4e00\u4e2a step\uff0c\u6ca1\u6709\u62a5\u9519\u3001\u6ca1\u6709 OOM\u3001\u6ca1\u6709\u8d85\u65f6\u3002\n' +
  '    #   412 \u6761 / \u6279 4 = 103 \u4e2a\u5fae\u6279\uff0c2 \u5361\u5207\u7247\u540e\u662f 52 \u548c 51\uff0c\u5404\u81ea //4 \u5f97 13 \u548c 12 \u6b65\uff1a**\u6b65\u6570\u4e0d\u7b49**\u3002\n' +
  '    #   v9 \u7684 256 \u6761\u6070\u597d\u662f 32/32\uff0c\u628a\u8fd9\u4e2a\u95ee\u9898\u76d6\u4f4f\u4e86 \u2014\u2014 \u6570\u636e\u4e00\u53d8\u5c31\u4f1a\u53d1\u4f5c\u3002\n' +
  '    #   \u6240\u4ee5\u5148\u6309 accum*world \u628a\u5168\u5c40\u5fae\u6279\u88c1\u5230\u6574\u9664\uff0c\u518d\u5207\u5206\uff0c\u4e24\u8fb9\u6b65\u6570\u5fc5\u7136\u76f8\u540c\u3002\n' +
  '    per_step = args.accum * world\n' +
  '    n_micro = (len(batches) // per_step) * per_step\n' +
  '    dropped = len(batches) - n_micro\n' +
  '    if dropped:\n' +
  '        print(f"\u00b7 \u5168\u5c40 {len(batches)} \u4e2a\u5fae\u6279\uff0c\u4e3a\u5bf9\u9f50 DDP \u6b65\u6570\u88c1\u6389\u5c3e\u90e8 {dropped} \u4e2a"\n' +
  '              f"\uff08\u6bcf\u8f6e\u5c11 {dropped * args.batch} \u6761\uff0c\u7ea6 {dropped * args.batch / max(1, len(encoded)):.1%}\uff09", flush=True)\n' +
  '    batches = batches[:n_micro]\n' +
  '    if world > 1:\n' +
  '        # \u6bcf\u5f20\u5361\u5206\u8d70\u4e00\u90e8\u5206\u5fae\u6279\uff0c\u68af\u5ea6\u7531 DDP \u540c\u6b65 \u21d2 \u7b49\u4ef7\u4e8e\u628a\u6709\u6548\u6279\u518d\u653e\u5927 world \u500d\u3002\n' +
  '        batches = batches[local_rank::world]\n' +
  '        print(f"\u00b7 rank {local_rank} \u5206\u5230 {len(batches)} \u4e2a\u5fae\u6279", flush=True)\n' +
  '    steps_per_epoch = max(1, n_micro // per_step)\n' +
  '    total_steps = max(1, int(steps_per_epoch * args.epochs))',
  'ddp-align');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
