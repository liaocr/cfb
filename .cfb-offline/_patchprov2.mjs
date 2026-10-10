
import fs from 'node:fs';
const F = 'deploy/kaggle/data/PROVENANCE.md';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep('| | 值 |\n' +
    '| --- | --- |\n' +
    '| 教师稿已产 | **722 / 4687**（15.4%，0 失败） |\n' +
    '| 可用（过 raw/draft 长度闸） | 722 |\n' +
    '| 训练候选（切分后、过滤前） | 633 |\n' +
    '| 训练集 | **256**（按尺子过滤后留存 40.4%） |\n' +
    '| 验证集 | **89**（**不按尺子过滤**，见下） |\n' +
    '| 教师基线 | 验证集 **31/89 = 34.8%**；剔掉 16 条 G0 后 **31/73 = 42.5%** |',
    '| | 值 |\n' +
    '| --- | --- |\n' +
    '| 教师稿已产 | **722 / 4687**（15.4%，0 失败） |\n' +
    '| 可用（过 raw/draft 长度闸） | 722 |\n' +
    '| 训练候选（切分后、过滤前） | 633 |\n' +
    '| 训练集 | **412**（按 gen-ruler/4 过滤后留存 65.1%） |\n' +
    '| 验证集 | **89**（**不按尺子过滤**，见下） |\n' +
    '| 教师基线 | 验证集 **55/89 = 61.8%**；剔掉 16 条 G0 后 **55/73 = 75.3%** |\n' +
    '\n' +
    '> 上一版（gen-ruler/3）是训练 256 / 教师基线 31/89 = 34.8%。\n' +
    '> **dev 集两次完全一致**（89 条的 id/raw/ctx 逐条相同），所以旧的学生稿\n' +
    '> 仍可直接跟新基线配对比较。旧版数据在 git 历史里：\n' +
    '> git show eb46fdc:deploy/kaggle/data/sft-train.jsonl',
    'table');

rep('| G7 compressed（压缩比不够） | 254 |\n| G0 no-leverage（空稿也能过门的洞） | 100 |',
    '| G0 no-leverage（空稿也能过门的洞） | 100 |',
    'drop-g7row');

rep('**G0 是 ' + String.fromCharCode(96) + 'gen-ruler/3' + String.fromCharCode(96) + ' 新加的，加之前那个 44.9% 是虚高的。**',
    '### 为什么 G7 不在这张表里（gen-ruler/4）\n' +
    '\n' +
    '压缩比从硬门**下架、转软标准**（COMPRESSION_TARGET = 0.5）。四条实测理由：\n' +
    '24 条教师稿只挂 G7 一件事而软分与整体持平（0.6993 vs 0.703）；阈值 0.55 落在\n' +
    '分布内部没有自然断点；压缩本来就在软分 S4 里；**阈值一放宽，师生差距从 15.1 点\n' +
    '扩大到 41.1 点** —— 它一直在掩盖学生的缺口。详见 docs/RULER-V4-AND-G1-GUARD.md。\n' +
    '\n' +
    '以后再训练到 0.5 时，把尺子的 COMPRESSION_HARD_MAX 设成 0.5 就重新装上。\n' +
    '\n' +
    '### G0 的来历\n' +
    '\n' +
    '**G0 是 gen-ruler/3 新加的，加之前那个 44.9% 是虚高的。**',
    'g7-note');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
