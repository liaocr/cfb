
import fs from 'node:fs';
const F = 'deploy/kaggle/train_rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep('        try:\n' +
    '            a, ta = gen_once(dev_encoded[0][0], 64, False)\n' +
    '            b, tb = gen_once(dev_encoded[0][0], 64, True)\n' +
    '            same = a == b\n',
    '        try:\n' +
    '            # \u26a0 \u5fc5\u987b**\u5148\u70ed\u4e00\u6b21**\u518d\u8ba1\u65f6\u3002v9 \u7684\u81ea\u68c0\u62ff\u5230\u7684\u662f\n' +
    '            #   \u4e0d\u5f00 6.7s / \u5f00 31.0s\uff0c\u770b\u8d77\u6765\u201c\u5f00\u7f13\u5b58\u6162 4.6 \u500d\u201d\uff0c\n' +
    '            #   \u4f46\u540c\u4e00\u8f6e\u5168\u91cf\u751f\u6210\u5b9e\u6d4b\u53ea\u6709 29.8 token/s \u2014\u2014 \u6bd4\u90a3\u4e2a\u81ea\u68c0\u5feb 3 \u500d\u3002\n' +
    '            #   \u4e24\u4e2a\u6570\u5b57\u6253\u67b6\uff0c\u8bf4\u660e 6.7s \u91cc\u5927\u5934\u662f **Triton \u9996\u6b21\u7f16\u8bd1**\uff0c\u4e0d\u662f\u541e\u5410\u3002\n' +
    '            #   \u62ff\u6ca1\u70ed\u8fc7\u7684\u6570\u5b57\u53bb\u6bd4\u5feb\u6162\uff0c\u5f97\u5230\u7684\u662f\u7f16\u8bd1\u65f6\u95f4\u7684\u5dee\uff0c\u4e0d\u662f\u541e\u5410\u7684\u5dee\u3002\n' +
    '            gen_once(dev_encoded[0][0], 16, False)\n' +
    '            gen_once(dev_encoded[0][0], 16, True)\n' +
    '            a, ta = gen_once(dev_encoded[0][0], 64, False)\n' +
    '            b, tb = gen_once(dev_encoded[0][0], 64, True)\n' +
    '            same = a == b\n',
    'warm-cache');

rep('            if not same:\n' +
    '                print("  \u8b66\u544a\uff1a\u5f00\u7f13\u5b58\u540e\u8f93\u51fa\u53d8\u4e86 -> \u56de\u9000\u5230\u4e0d\u5f00\u7f13\u5b58\uff08\u6162\uff0c\u4f46\u4e0d\u5192\u6b63\u786e\u6027\u7684\u9669\uff09",\n' +
    '                      flush=True)\n' +
    '                args.gen_cache = False\n' +
    '            elif tb > ta:\n' +
    '                print("  \u5f00\u7f13\u5b58\u53cd\u800c\u66f4\u6162 -> \u5173\u6389\uff08v9 \u5b9e\u6d4b\u5c31\u662f\u8fd9\u79cd\u60c5\u51b5\uff09", flush=True)\n' +
    '                args.gen_cache = False',
    '            if not same:\n' +
    '                print("  \u8b66\u544a\uff1a\u5f00\u7f13\u5b58\u540e\u8f93\u51fa\u53d8\u4e86 -> \u56de\u9000\u5230\u4e0d\u5f00\u7f13\u5b58\uff08\u6162\uff0c\u4f46\u4e0d\u5192\u6b63\u786e\u6027\u7684\u9669\uff09",\n' +
    '                      flush=True)\n' +
    '                args.gen_cache = False\n' +
    '            elif tb > ta * 1.2:\n' +
    '                # 20% \u5bbd\u5bb9\uff1a\u8fd9\u4e24\u6b21\u91c7\u6837\u672c\u8eab\u5c31\u6709\u6296\u52a8\uff0c\u5361\u5728 1.0 \u4f1a\u628a\u566a\u58f0\u5f53\u4fe1\u53f7\u3002\n' +
    '                print("  \u5f00\u7f13\u5b58\u786e\u5b9e\u66f4\u6162\uff08\u70ed\u673a\u540e\u5bf9\u6bd4\uff09-> \u5173\u6389", flush=True)\n' +
    '                args.gen_cache = False',
    'slow-disable');

rep('                  f"\uff08{tb / max(ta, 1e-6):.2f}x\uff09\u00b7 \u8f93\u51fa{\'\u9010\u5b57\u4e00\u81f4\' if same else \'\u4e0d\u4e00\u81f4\'}",',
    '                  f"\uff08\u5f00/\u4e0d\u5f00 = {tb / max(ta, 1e-6):.2f}x\uff0c\u70ed\u673a\u540e\uff09\u00b7 \u8f93\u51fa{\'\u9010\u5b57\u4e00\u81f4\' if same else \'\u4e0d\u4e00\u81f4\'}",',
    'print-ratio');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
