
import fs from 'node:fs';
const F = 'deploy/kaggle/train_rwkv7.py';
let s = fs.readFileSync(F, 'utf8');

// ── 6. 第 9 节主体换成调用 generate()（原来那份内联实现已经抽成函数）──
const startMark = '    # ---- 9. \u751f\u6210\u7a3f\u5b50\uff0c\u4ea4\u7ed9\u672c\u5730\u5c3a\u5b50\u6253\u5206\uff08\u4e0d\u5728\u8fd9\u91cc\u81ea\u8bc4\uff09----';
const endMark = '\uff08{time.time() - t_gen:.0f}s\uff0c\u7528 tools/eval-sft.mjs \u672c\u5730\u6253\u5206\uff09", flush=True)';
const i = s.indexOf(startMark), j = s.indexOf(endMark);
if (i < 0 || j < 0) { console.log('MISS sec9', i, j); process.exit(1); }
const jEnd = s.indexOf('\n', j) + 1;
const NEW9 = [
'    # ---- 9. \u751f\u6210\u7a3f\u5b50\uff0c\u4ea4\u7ed9\u672c\u5730\u5c3a\u5b50\u6253\u5206\uff08\u4e0d\u5728\u8fd9\u91cc\u81ea\u8bc4\uff09----',
'    # \u8def\u5f84\u4e0e\u5b66\u4e60\u66f2\u7ebf\u7ec8\u70b9\u4e00\u81f4\uff0c\u4e0d\u53e6\u8d77\u4e00\u4e2a\u540d\u5b57 \u2014\u2014 \u540d\u5b57\u4e0d\u4e00\u81f4\u7684\u540e\u679c\u662f\u672c\u5730\u811a\u672c\u62ff\u4e0d\u5230\u6587\u4ef6\uff0c',
'    # \u800c\u62ff\u4e0d\u5230\u6587\u4ef6\u4e0d\u4f1a\u62a5\u9519\uff0c\u53ea\u4f1a\u9759\u9ed8\u5730\u53bb\u8bc4\u4e00\u4e2a\u4e0d\u5b58\u5728\u7684\u4e1c\u897f\u3002',
'    gen_path = out_dir / "dev-generations.jsonl"',
'    gen_rows = generate(args.gen_n, gen_path)',
'    if gen_rows:',
'        print(f"\u00b7 \u751f\u6210 {gen_rows} \u6761 -> {gen_path}\uff08\u7528 tools/eval-sft.mjs \u672c\u5730\u6253\u5206\uff09", flush=True)',
''].join('\n');
s = s.slice(0, i) + NEW9 + s.slice(jEnd);
console.log('ok sec9');

const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

// ── 7. 训练循环里挂上快照点 ──
rep('                running = 0.0\n' +
    '                step += 1\n' +
    '                if step >= total_steps:\n' +
    '                    done = True\n' +
    '                    break',
    '                running = 0.0\n' +
    '                step += 1\n' +
    '                # \u5feb\u7167\u70b9\u63d2\u5728**\u53c2\u6570\u5df2\u66f4\u65b0\u4e4b\u540e\u3001\u4e0b\u4e00\u6b65\u4e4b\u524d**\uff0c\u5426\u5219\u8bfb\u5230\u7684\u662f\u4e0a\u4e00\u6b65\u7684\u6743\u91cd\u3002\n' +
    '                # \u8fd9\u79cd\u504f\u4e00\u6b65\u7684\u9519\u4e0d\u4f1a\u62a5\u9519\uff0c\u53ea\u4f1a\u8ba9\u66f2\u7ebf\u6574\u4f53\u5de6\u79fb\u3002\n' +
    '                if step in ckpt_set:\n' +
    '                    curve_point(step)\n' +
    '                if step >= total_steps:\n' +
    '                    done = True\n' +
    '                    break',
    'loop-hook');

// ── 8. report \u91cc\u5e26\u4e0a\u66f2\u7ebf ──
rep('        "genRows": gen_rows, "genCache": bool(args.gen_cache), "genBudget": args.gen_budget,',
    '        "genRows": gen_rows, "genCache": bool(args.gen_cache), "genBudget": args.gen_budget,\n' +
    '        "devLossFinal": None if dl_final is None else round(dl_final, 4),\n' +
    '        "curve": curve, "ckptSteps": sorted(ckpt_set), "ckptGenN": ckpt_gen_n,',
    'report-curve');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
