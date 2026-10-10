
import fs from 'node:fs';
const F = 'deploy/kaggle/start-rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep('    ap.add_argument("--gen-budget", type=float, default=3600,',
    '    ap.add_argument("--ckpt-steps", default="",\n' +
    '                    help="\u5b66\u4e60\u66f2\u7ebf\u5feb\u7167\u6b65\u6570\uff08\u9017\u53f7\u5206\u9694\uff09\u3002\u5230\u70b9\u5c31 dev loss + \u751f\u6210\u4e00\u6b21\uff0c\u7136\u540e\u63a5\u7740\u8bad\u3002"\n' +
    '                         "\u7a7a=\u4e0d\u5feb\u7167\u3002\u66f2\u7ebf\u4e0a\u6bcf\u4e2a\u70b9\u8981\u540c n \u624d\u80fd\u76f8\u6bd4\u3002")\n' +
    '    ap.add_argument("--ckpt-gen-n", type=int, default=0,\n' +
    '                    help="\u5feb\u7167\u70b9\u751f\u6210\u591a\u5c11\u6761\uff080=\u7528 --gen-n\uff09")\n' +
    '    ap.add_argument("--gen-budget", type=float, default=3600,',
    'launcher-args');

rep('    tune = {"epochs": args.epochs, "accum": args.accum, "lr": args.lr,\n' +
    '            "gen_n": args.gen_n, "gen_max_new": args.gen_max_new,\n' +
    '            "gen_budget": args.gen_budget}',
    '    tune = {"epochs": args.epochs, "accum": args.accum, "lr": args.lr,\n' +
    '            "gen_n": args.gen_n, "gen_max_new": args.gen_max_new,\n' +
    '            "gen_budget": args.gen_budget}\n' +
    '    if args.ckpt_steps:\n' +
    '        tune["ckpt_steps"] = args.ckpt_steps\n' +
    '        tune["ckpt_gen_n"] = args.ckpt_gen_n or args.gen_n',
    'launcher-tune');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
