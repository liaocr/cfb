import fs from 'node:fs';
import path from 'node:path';
const home = process.platform === 'win32'
  ? (process.env.USERPROFILE || 'C:/Users/Administrator')
  : (process.env.HOME || '/home/liaocr');
const guideFile = process.env.DSH_GUIDE_FILE
  || path.join(home, '.dsh', '.agent-presets', 'router-rl-minimal', 'router-bootstrap-v1.mjs');
const src = fs.readFileSync(guideFile, 'utf8');
const lines = src.split(/\r?\n/);

// 从 startLineIdx 起逐行取首尾单引号之间内容，遇到 stopRe 结束
function collectBlock(startLineIdx, stopRe) {
  let out = '';
  for (let i = startLineIdx; i < lines.length; i++) {
    const l = lines[i];
    const s = l.indexOf("'");
    if (s === -1) continue;
    const e = l.lastIndexOf("'");
    if (e > s) out += l.slice(s + 1, e);
    if (stopRe.test(l)) break;
  }
  return out.replace(/\\n/g, '\n');
}

const gi = lines.findIndex((l) => /const RL_GUIDE\s*=/.test(l));
const guide = collectBlock(gi + 1, /;$/);
const vi = lines.findIndex((l, i) => i > gi && /^\s{4}visual:\s*$/.test(l));
const ei = lines.findIndex((l, i) => i > vi && /^\s{4}exec:\s*$/.test(l));
const visual = collectBlock(vi + 1, /',$/);
console.log('RL_GUIDE:', guide.length, '| visual:', visual.length, '| 总量:', guide.length + visual.length);
console.log('物理因果流水线:', visual.includes('物理因果推演流水线') ? 'OK' : 'MISS');
console.log('四原则完整性:', ['空间公理', '物理因果布光', '介质分层推导', '细节生长与预算闭环'].every((k) => visual.includes(k)) ? 'OK' : 'MISS');
console.log('单一源头反漂移:', visual.includes('单一源头') && visual.includes('次生字面量') ? 'OK' : 'MISS');
console.log('验证闭环:', visual.includes('验证闭环') && visual.includes('达标即止') ? 'OK' : 'MISS');
console.log('v4.6.1 计划先行指令:', src.includes('请先不要急于行动') && src.includes('深入详述你的完整思路') && src.includes('构思完备后直接全面开展落地') ? 'OK' : 'MISS');