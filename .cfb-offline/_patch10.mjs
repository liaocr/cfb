
import fs from 'node:fs';
const F = 'deploy/kaggle/start-rwkv7.py';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep('用法\n----\n  python deploy/kaggle/start-rwkv7.py --smoke     # \u53ea\u9a8c\u8bc1\u73af\u5883\uff08\u9ed8\u8ba4\uff09\n' +
    '  python deploy/kaggle/start-rwkv7.py --train     # \u771f\u8bad\n' +
    '  python deploy/kaggle/start-rwkv7.py --status    # \u67e5\u72b6\u6001\n' +
    '  python deploy/kaggle/start-rwkv7.py --stop      # \u505c\u6389\u6b63\u5728\u8dd1\u7684 session\n' +
    '"""',
    '\u4e3a\u4ec0\u4e48\u4f1a\u4e00\u76f4 QUEUED\uff08\u5b9e\u6d4b\uff0c\u4e0d\u662f\u63a8\u6f14\uff09\n' +
    '----------------------------------\n' +
    '\u8fd9\u4e2a\u811a\u672c\u8d70\u7684\u662f **batch \u8f66\u9053**\uff1a\u8bfb\u4e86 kaggle CLI \u6e90\u7801\uff0ckernels_push() \u53ea\u8c03\n' +
    'save_kernel()\uff0c**\u4ece\u4e0d\u8c03** create_kernel_session()\u3002\u800c kagglesdk \u91cc\n' +
    'create_kernel_session() \u7684\u6587\u6863\u5b57\u7b26\u4e32\u5199\u7740\u5b83\u662f\u7ed9 **interactive** session \u7528\u7684\u3002\n' +
    '\u6240\u4ee5\u7f51\u9875\u91cc\u70b9\u5f00\u8dd1\uff08interactive\uff09\u7acb\u523b\u6d3e\u673a\u5668\uff0c\u800c CLI push\uff08batch\uff09\u8981\u7b49\u8c03\u5ea6\u5668\u3002\n' +
    '\u4e24\u8005\u6263\u540c\u4e00\u4efd\u914d\u989d\uff0c\u4f46 batch \u4f1a\u6392\u961f \u2014\u2014 2026-10 \u5b9e\u6d4b\u6392\u4e86 **2 \u5c0f\u65f6**\u3002\n' +
    '\n' +
    '\u6392\u961f\u65f6\u600e\u4e48\u5224\u65ad\u662f\u201c\u6b63\u5e38\u6392\u961f\u201d\u800c\u4e0d\u662f\u201c\u5361\u6b7b\u4e86\u201d\uff08\u56db\u9879\u90fd\u8981\u770b\uff09\uff1a\n' +
    '  1. kernels_status() \u8fd4\u56de QUEUED \u4e14 **kernel_session_id \u4e3a\u7a7a**\uff08\u6ca1\u5206\u5230\u673a\u5668\uff09\uff1b\n' +
    '  2. get_accelerator_quota_statistics() \u91cc timeUsed \u8fdc\u5c0f\u4e8e totalTimeAllowed\uff1b\n' +
    '  3. list_kernels() \u91cc\u6ca1\u6709\u522b\u7684\u5185\u6838\u5728\u62a2\u5361\uff1b\n' +
    '  4. kernels_logs() \u8fd4\u56de **0 \u5b57\u7b26**\uff08\u6ca1\u673a\u5668\u5c31\u6ca1\u65e5\u5fd7\uff09\u3002\n' +
    '\u56db\u6761\u90fd\u7b26\u5408\u5c31\u53ea\u80fd\u7b49 \u2014\u2014 \u4e0d\u8981\u53d6\u6d88\u91cd\u63a8\uff0c\u90a3\u53ea\u4f1a\u91cd\u65b0\u6392\u5230\u961f\u5c3e\u3002\n' +
    '\u771f\u6025\u7740\u8981\u7ed3\u679c\u5c31\u53bb\u7f51\u9875\u91cc\u624b\u52a8\u70b9\u5f00\u8dd1\uff08\u8d70 interactive \u8f66\u9053\uff09\u3002\n' +
    '\n' +
    '\u7528\u6cd5\n' +
    '----\n' +
    '  python deploy/kaggle/start-rwkv7.py --smoke     # \u53ea\u9a8c\u8bc1\u73af\u5883\uff08\u9ed8\u8ba4\uff09\n' +
    '  python deploy/kaggle/start-rwkv7.py --train     # \u771f\u8bad\n' +
    '  python deploy/kaggle/start-rwkv7.py --status    # \u67e5\u72b6\u6001\n' +
    '  python deploy/kaggle/start-rwkv7.py --wait      # \u67e5\u72b6\u6001 + \u62c9\u65e5\u5fd7\uff0c\u76f4\u5230\u7ec8\u6001\n' +
    '  python deploy/kaggle/start-rwkv7.py --stop      # \u505c\u6389\u6b63\u5728\u8dd1\u7684 session\n' +
    '"""',
    'docstring');

rep('    g.add_argument("--status", action="store_true")\n    g.add_argument("--stop", action="store_true")',
    '    g.add_argument("--status", action="store_true")\n    g.add_argument("--wait", action="store_true",\n' +
    '                   help="\u8f6e\u8be2\u5230\u7ec8\u6001\u5e76\u62c9\u65e5\u5fd7\uff08\u6392\u961f\u53ef\u80fd\u5f88\u4e45\uff0c\u89c1\u6587\u6863\u5b57\u7b26\u4e32\uff09")\n' +
    '    ap.add_argument("--interval", type=int, default=60, help="--wait \u7684\u8f6e\u8be2\u95f4\u9694\uff08\u79d2\uff09")\n' +
    '    g.add_argument("--stop", action="store_true")',
    'wait-flag');

rep('    if args.status:\n' +
    '        r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid])\n' +
    '        return r.returncode',
    '    if args.status:\n' +
    '        r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid])\n' +
    '        return r.returncode\n' +
    '\n' +
    '    if args.wait:\n' +
    '        return wait_kernel(kid, args.interval)',
    'wait-branch');

rep('def build_kernel(mode: str, tune: dict | None = None) -> str:',
    'TERMINAL = {"COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED", "CANCELLED"}\n' +
    '\n' +
    '\n' +
    'def wait_kernel(kid: str, interval: int) -> int:\n' +
    '    """\u8f6e\u8be2\u5230\u7ec8\u6001\u3002\u6bcf\u6b21\u72b6\u6001\u53d8\u5316\u624d\u6253\u4e00\u884c\uff0c\u907f\u514d\u5237\u5c4f\u3002\n' +
    '\n' +
    '    \u4e3a\u4ec0\u4e48\u8981\u6709\u8fd9\u4e2a\uff1a\u6392\u961f\u53ef\u80fd\u6570\u5c0f\u65f6\uff0c\u800c\u6392\u961f\u671f\u95f4 kernels_logs() \u8fd4\u56de\u7a7a \u2014\u2014\n' +
    '    \u4eba\u5de5\u53cd\u590d\u8dd1 --status \u4f1a\u628a\u201c\u6b63\u5e38\u6392\u961f\u201d\u8bef\u8bfb\u6210\u201c\u5361\u6b7b\u4e86\u201d\uff0c\u7136\u540e\u53d6\u6d88\u91cd\u63a8\uff0c\u91cd\u65b0\u6392\u5230\u961f\u5c3e\u3002\n' +
    '    """\n' +
    '    last = None\n' +
    '    t0 = time.time()\n' +
    '    while True:\n' +
    '        try:\n' +
    '            st = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid],\n' +
    '                                capture_output=True, text=True)\n' +
    '            raw = (st.stdout or "") + (st.stderr or "")\n' +
    '            cur = "?"\n' +
    '            for name in TERMINAL | {"RUNNING", "QUEUED"}:\n' +
    '                if name in raw:\n' +
    '                    cur = name\n' +
    '                    break\n' +
    '        except Exception as exc:  # noqa: BLE001\n' +
    '            cur = f"status-error({exc!r})"\n' +
    '        if cur != last:\n' +
    '            print(f"\u00b7 [{time.strftime(\'%H:%M:%S\')}] \u72b6\u6001 {cur}"\n' +
    '                  f"\uff08\u5df2\u7b49 {(time.time()-t0)/60:.0f} \u5206\u949f\uff09", flush=True)\n' +
    '            last = cur\n' +
    '        if cur in TERMINAL:\n' +
    '            out = Path(".cfb-offline/kaggle-out/v10")\n' +
    '            out.mkdir(parents=True, exist_ok=True)\n' +
    '            lg = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "logs", kid],\n' +
    '                                capture_output=True, text=True)\n' +
    '            (out / "kernel.log").write_text((lg.stdout or "") + (lg.stderr or ""), encoding="utf-8")\n' +
    '            print(f"\u00b7 \u65e5\u5fd7\u5df2\u5b58 {out / \'kernel.log\'}\uff08{(len(lg.stdout or \'\'))} \u5b57\u7b26\uff09")\n' +
    '            return 0 if cur == "COMPLETE" else 1\n' +
    '        time.sleep(interval)\n' +
    '\n' +
    '\n' +
    'def build_kernel(mode: str, tune: dict | None = None) -> str:',
    'wait-fn');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
