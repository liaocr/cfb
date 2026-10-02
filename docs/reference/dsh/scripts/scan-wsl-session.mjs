import fs from 'node:fs';

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n').filter(Boolean);

let reasonTokens = 0;
let toolCalls = [];
let userMsgs = 0;
let firstUser = '';
let turns = new Set();
// 双语 / 正则宽容匹配：同时兼容旧英文引导与当前中文 RL_GUIDE / DETAIL_GUIDE（两阶段双检查点）。
const guideChecks = [
  { label: '路由注入·引导消息', re: /\[路由注入·引导消息\]/ },
  { label: 'v4.6.1 计划先行指令', re: /请先不要急于行动|深入详述你的完整思路|构思完备后直接全面开展落地/ },
  { label: 'RL_GUIDE 稳重·空间公理', re: /空间与公理先行|Design order is fixed/ },
  { label: 'RL_GUIDE 稳重·前向物理', re: /前向物理锁定|Watch the sum/ },
  { label: 'RL_GUIDE 稳重·离线预算', re: /离线推演定界不默写代码|离线预算与证伪|Model deliberately/ },
  { label: 'RL_GUIDE 细心·空间断言', re: /业务与空间断言优先|Understand first/ },
  { label: 'RL_GUIDE 细心·单变量探针', re: /最小单变量探针/ },
  { label: 'RL_GUIDE 细心·终验', re: /改动必落地与终验|Finish honestly/ },
  { label: 'RL_GUIDE 细心·探针先证伪', re: /探针先证伪/ },
  { label: 'RL_GUIDE 诚实·自证陷阱', re: /破除自证陷阱|技术可运行≠需求达成/ },
  { label: 'RL_GUIDE 诚实·单一事实源', re: /单一事实源/ },
  { label: 'RL_GUIDE 诚实·验证权威', re: /验证权威完整/ },
  { label: 'RL_GUIDE 克制·达标即止', re: /判据达标即止|hints, not a checklist/ },
  { label: 'DETAIL·visual 物理因果流水线', re: /物理因果推演流水线/ },
  { label: 'DETAIL·visual 空间公理', re: /空间公理与拓扑定界|空间公理与形体|空间与装配公理|空间与形体（第一步）|先定死绝对尺寸与空间坐标系|先定死绝对尺寸与全局空间基准/ },
  { label: 'DETAIL·visual 单一源头反漂移', re: /单一源头|次生字面量|数据漂移|动态计算引用/ },
  { label: 'DETAIL·visual 装配数学硬断言', re: /d = r1 \+ r2|防双重偏移|100%基于字典|节圆半径|啮合中心距/ },
  { label: 'DETAIL·visual 材料与布光', re: /材料语义三位一体|材料语义分层|材质与质感（第二步）|物理因果布光|能量乘积/ },
  { label: 'DETAIL·visual 检查点一·冒烟断言', re: /检查点一|第1次冒烟检查|冒烟断言/ },
  { label: 'DETAIL·visual 细节三律/介质/状态机', re: /完美细节生成因果|完美细节与严禁零思考盲修|功能因果|尺度层级|拓扑嵌套|高光清漆模型|opacity: 0.05-0.12|有界状态机|lerp \+ clamp\(t,0,1\)|介质分层推导|菲涅尔/ },
  { label: 'DETAIL·visual 光感/预算闭环', re: /光感、环境与预算闭环|第2次终验|细节生长与预算闭环|细节生长与预算|ACES|验证闭环|达标即止/ },
];

for (const line of lines) {
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (e.type === 'reasoning-chunks' && Array.isArray(e.data?.texts)) {
    reasonTokens += e.data.texts.join('').length;
  }
  if (e.type === 'tool/call' && e.data?.name) {
    toolCalls.push({ name: e.data.name, step: e.data.step, time: e.data.time });
  }
  if (e.type === 'turn/start' && e.data?.turn) turns.add(e.data.turn);
  if (e.type === 'user/message' && e.data?.source?.kind === 'user' && Array.isArray(e.data.content)) {
    userMsgs++;
    if (!firstUser) firstUser = e.data.content.map((c) => c.text || '').join('');
  }
}

console.log('=== 会话 basic ===');
console.log('reasoning chars:', reasonTokens);
console.log('tool calls:', toolCalls.length);
console.log('turns:', turns.size);
console.log('user messages:', userMsgs);
console.log('\n=== tool 分布 ===');
const byName = {};
for (const t of toolCalls) byName[t.name] = (byName[t.name] || 0) + 1;
console.log(Object.entries(byName).sort((a, b) => b[1] - a[1]));
console.log('\n=== 引导注入验证（RL_GUIDE/visual 关键词，中英双语宽容匹配）===');
for (const c of guideChecks) {
  if (text.match(c.re)) console.log('  ✓', c.label);
  else console.log('  ✗', c.label);
}
console.log('\n=== 首条 user (前150字) ===');
console.log(firstUser.slice(0, 150));
