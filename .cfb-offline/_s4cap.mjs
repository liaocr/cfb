
// 验证：把 S4 改成「到 0.5 封顶」之后，退化阶梯是否单调。
const W = { S1:0.28, S2:0.18, S3:0.18, S4:0.13, S5:0.13, S6:0.10 };
const SUM6 = 0.28+0.18+0.18+0.13+0.13+0.10;
// 阶梯实测的 sub 均值（来自 _orderprobe.mjs）与 tokRatio（由旧 S4 反推）
const rows = [
  {n:'L0 原稿',       S1:0.634,S2:0.938,S3:0.832,S4old:0.533,S5:0.426,S6:0.836, E:0.798},
  {n:'L1 去末25%句',  S1:0.622,S2:0.944,S3:0.821,S4old:0.687,S5:0.398,S6:0.838, E:0.819},
  {n:'L2 去后一半',   S1:0.540,S2:0.954,S3:0.765,S4old:0.831,S5:0.295,S6:0.867, E:0.856},
  {n:'L4 打乱句序',   S1:0.634,S2:0.934,S3:0.832,S4old:0.535,S5:0.426,S6:0.826, E:0.603},
  {n:'L7 只留末句',   S1:0.075,S2:0.625,S3:0.337,S4old:1.000,S5:0.058,S6:0.975, E:0.930},
];
const tr = r => { const g = r.S4old; return 1 - (g*0.75 + 0.10); };  // 反推 tokRatio
const scoreOld = r => W.S1*r.S1+W.S2*r.S2+W.S3*r.S3+W.S4*r.S4old+W.S5*r.S5+W.S6*r.S6;
const sat = (tok, T=0.5) => Math.max(0, Math.min(1, (1-tok)/(1-T)));
const scoreNew = r => { const tok=tr(r), g=sat(tok);
  return (W.S1*r.S1+W.S2*r.S2+W.S3*r.S3+W.S4*g+W.S5*r.S5+W.S6*r.S6)/SUM6; };
console.log('档'.padEnd(16)+'tokRatio'.padEnd(10)+'S4旧'.padEnd(8)+'S4新'.padEnd(8)+'旧分'.padEnd(9)+'新分(无顺序)');
for (const r of rows) { const tok=tr(r);
  console.log(r.n.padEnd(14)+tok.toFixed(3).padEnd(10)+r.S4old.toFixed(3).padEnd(8)+sat(tok).toFixed(3).padEnd(8)
    +scoreOld(r).toFixed(4).padEnd(9)+scoreNew(r).toFixed(4)); }

console.log('\n--- 加入 S7(顺序, 权重 0.15)，总分除以 1.15 ---');
const SUM7 = SUM6 + 0.15;
const full = r => { const tok=tr(r), g=sat(tok);
  return (W.S1*r.S1+W.S2*r.S2+W.S3*r.S3+W.S4*g+W.S5*r.S5+W.S6*r.S6+0.15*r.E)/SUM7; };
for (const r of rows) console.log(r.n.padEnd(14)+'顺序E='+r.E.toFixed(3)+'  总分 '+full(r).toFixed(4));
