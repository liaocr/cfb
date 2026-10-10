
import fs from 'node:fs';
const F = 'deploy/kaggle/train_rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

// ── 把 7c 整块从"训练循环之后"搬到"训练循环之前" ──
// 原因（真 bug，不是洁癖）：循环在第 800 行调用 curve_point，而它原来定义在第 877 行。
// Python 在**调用时**解析名字，所以那是 NameError: name 'curve_point' is not defined ——
// 而且只在第一个快照点触发，也就是训练跑了几十分钟之后才炸。
const A = '    # ---- 7c. \u5b66\u4e60\u66f2\u7ebf\u70b9 ----';
const B = '    # ---- 8. dev \u635f\u5931\uff08\u53ea 0 \u53f7 rank\uff0c\u8d70\u672a\u5305\u88f9\u53e5\u67c4\uff09----';
const i = s.indexOf(A), j = s.indexOf(B);
if (i < 0 || j < 0 || j < i) { console.log('MISS move', i, j); process.exit(1); }
let block = s.slice(i, j);
s = s.slice(0, i) + s.slice(j);
console.log('cut 7c:', block.length, 'chars');

// 块里补上 out_dir（原来在 7b 里定义，而 7b 在循环之后）
block = block.replace(
  '    curve = []\n    ckpt_gen_n = args.ckpt_gen_n or args.gen_n\n',
  '    curve = []\n    ckpt_gen_n = args.ckpt_gen_n or args.gen_n\n' +
  '    # out_dir \u5fc5\u987b\u5728\u5faa\u73af**\u4e4b\u524d**\u5c31\u5b58\u5728 \u2014\u2014 \u66f2\u7ebf\u70b9\u8981\u5f80\u91cc\u5199\u6587\u4ef6\u3002\n' +
  '    out_dir = Path(args.out)\n' +
  '    out_dir.mkdir(parents=True, exist_ok=True)\n');
// nonlocal t0 没用（函数体里从不给 t0 赋值），删掉免得读的人以为 t0 会被改
block = block.replace('        nonlocal t0\n', '');

rep('    # ---- 7. \u8bad\u7ec3 ----', block + '    # ---- 7. \u8bad\u7ec3 ----', 'move-7c');

// ── 7b 里去掉重复的 out_dir 定义 ──
rep('    out_dir = Path(args.out)\n' +
    '    out_dir.mkdir(parents=True, exist_ok=True)\n' +
    '    if world > 1:\n' +
    '        torch.distributed.barrier()\n' +
    '    if is_main:\n' +
    '        md = out_dir / "model"',
    '    # out_dir \u5df2\u5728 7c \u91cc\u5efa\u597d\uff08\u66f2\u7ebf\u70b9\u8981\u7528\uff09\u3002\n' +
    '    if world > 1:\n' +
    '        torch.distributed.barrier()\n' +
    '    if is_main:\n' +
    '        md = out_dir / "model"',
    'dedupe-outdir');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
