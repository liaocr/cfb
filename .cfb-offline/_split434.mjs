
import fs from 'node:fs';
import crypto from 'node:crypto';

const F = '.cfb-offline/teacher/v4-full.jsonl';
const EXTRA = '.cfb-offline/teacher/v4-extra-434.jsonl';

const buf = fs.readFileSync(F);
const text = buf.toString('utf8');

// 按**字节偏移**切，不用 JSON round-trip —— round-trip 会重排 key、改浮点表示，
// 那就不是"移走"，是"重写"。append-only 的文件前 722 行必须逐字节原样。
const lines = [];
let start = 0;
for (let i = 0; i < text.length; i++) {
  if (text[i] === '\n') { lines.push([start, i + 1]); start = i + 1; }
}
if (start < text.length) lines.push([start, text.length]);
console.log('总行数', lines.length);

const KEEP = 722;
const headEnd = lines[KEEP - 1][1];              // 第 722 行结尾的字节位置
const head = Buffer.from(text.slice(0, headEnd), 'utf8');
const tail = Buffer.from(text.slice(headEnd), 'utf8');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
console.log('原文件', buf.length, 'bytes sha', sha(buf));
console.log('头部', head.length, 'bytes sha', sha(head), '行', KEEP);
console.log('尾部', tail.length, 'bytes sha', sha(tail), '行', lines.length - KEEP);
console.log('拼回是否等于原文件:', Buffer.concat([head, tail]).equals(buf));

// 先写尾部（万一中断，原文件还在）
fs.writeFileSync(EXTRA, tail);
fs.writeFileSync(F, head);
console.log('已写', EXTRA, '与', F);

// 验证
const a = fs.readFileSync(F, 'utf8').trim().split('\n');
const b = fs.readFileSync(EXTRA, 'utf8').trim().split('\n');
console.log('v4-full 行数', a.length, '| v4-extra 行数', b.length);
const ida = a.map(l => JSON.parse(l).id), idb = b.map(l => JSON.parse(l).id);
console.log('交集', ida.filter(x => idb.includes(x)).length, '（必须为 0）');
console.log('v4-full 前3 id', ida.slice(0, 3));
console.log('v4-full 后3 id', ida.slice(-3));
console.log('v4-extra 前3 id', idb.slice(0, 3));
const dupA = ida.length - new Set(ida).size, dupB = idb.length - new Set(idb).size;
console.log('重复 id: v4-full', dupA, 'v4-extra', dupB);
console.log('v4-full 逐字节等于原来的前 722 行:', fs.readFileSync(F).equals(head));
