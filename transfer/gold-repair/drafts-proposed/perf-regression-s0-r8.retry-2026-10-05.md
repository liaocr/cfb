<!-- ⚠ 已知嫌疑（t96）：这份稿是 t96 相对 t95 的唯一新增变量；收稿后 hand 从 r8 起 5086→10843 字膨胀、始终 0 edit。
    机制不是派活，是「删掉了它已起的头」：r8 raw 里有 Let me check if there are git history，本稿一个 git 没提 ⇒ r9 重新起念
    （I can't use git show. But git log -p might work?）、r10 真发 git show，edit 一直没发。
    离线复跑：node tools/silver-shape.mjs <本文件> --id perf-regression-s0-r8 --plan t96 ⇒ L8 报 4 条未处置起念，L3/L4 亦 ✗。
    留作反例对照，别当范例抄；数据不删。 -->
第 8 轮没有新变量：So the fix: revert compressTargetMax to 450 这句你本轮写了好几遍，缺的从来不是结论。

本轮唯一的动作：`edit_file` 把 `src/config.js` 里 `compressTargetMax: 1800,` 改成 `compressTargetMax: 450,`，同轮 `bash` 跑 `cat src/config.js` 看到 `compressTargetMax: 450,` 即写根因与依据收工。

别再去找"改完跑 analyze-trace 看读数变不变"这种验证——你自己已经推出 it's a fixed synthesized dataset、the trace data is static，读数不会替你确认这一改；能确证的只有文件里那一行。

已排除：`maxOutputTokens`——v11.9 的 260 远低于 850、v11.10 的 1150 远低于 4096，cap 不咬人 ⇒ 抬高只是允许，不是驱动；README 写"只影响 v3 的长度目标"说的是 `compressTargetMax`。
已排除：`env | sort`、`ls -la /`、翻 /opt /srv /data /var 找数据源——`cat /usr/local/bin/analyze-trace` 已回显「bash: /usr/local/bin/analyze-trace: No such file or directory」，没有可读实现，探到底也不改结论。
已排除：把 `birthFinishWaitMs` 改掉——你本轮算出的 finishWaitMs = ttfb + contentSpan（610 + 280 = 890 ≈ 900、640 + 1650 = 2290 ≈ 2400）已经解释了这两个数，1500 与 2400 并不矛盾，动它是猜。

未解：工具到底读 config 还是读静态 trace（本轮那句 so the tool might be reading actual config / or the trace data is static）——确认 `cat src/config.js` 那一行是 450 即收工，未解原样写进结论。若 `cat` 仍是 1800，只说明 edit 没写进去：重发同一条 `edit_file`；也不要改回 1800——读数不回落不构成 1800 正确的证据。
