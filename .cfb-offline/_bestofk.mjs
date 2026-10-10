
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';

const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const f100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const byId = new Map(full.map(o=>[o.id,o]));

// 1) 教师在整个 722 上的过门率（gen-ruler/4）
let pass=0, gauge=0, tot=0;
for (const o of full) {
  const d=(o.draft||'').trim(); if(!d) continue; tot++;
  const j=judge({raw:o.raw,ctx:o.ctx,draft:d});
  if (j.gaugeable) { gauge++; if (j.pass) pass++; }
}
console.log('722 教师稿: 有稿', tot, '有受力点', gauge, '过门', pass, '=> 过门率', +(pass/gauge).toFixed(3));

// 2) 100 配对：每个单元两次里过了几次
const k=[0,0,0];
for (const A of f100) {
  const B=byId.get(A.id); if(!B) continue;
  const pa=judge({raw:A.raw,ctx:A.ctx,draft:(A.draft||'').trim()}).pass ? 1:0;
  const pb=judge({raw:B.raw,ctx:B.ctx,draft:(B.draft||'').trim()}).pass ? 1:0;
  k[pa+pb]++;
}
console.log('100 配对: 0次过', k[0], '1次过', k[1], '2次过', k[2]);
console.log('单次过门率', +((k[1]+2*k[2])/(2*100)).toFixed(3));
console.log('best-of-2 实测', +((k[1]+k[2])/100).toFixed(3));

// 3) Beta-二项拟合：单元难度有差异，不是纯噪声
// 矩估计: p_bar = mean, s2 = var;  rho = (s2 - p(1-p)/m) / (p(1-p)(1-1/m))  (m=2)
const m=2, N=100;
const pbar=(k[1]+2*k[2])/(m*N);
const s2=(k.reduce((s,v,i)=>s+v*Math.pow(i/m-pbar,2),0))/N;
const rho=Math.max(0,(s2-pbar*(1-pbar)/m)/(pbar*(1-pbar)*(1-1/m)));
console.log('pbar',+pbar.toFixed(4),'s2',+s2.toFixed(4),'组内相关 rho',+rho.toFixed(4));
// 用 beta 参数
const alpha=pbar*(1/rho-1), beta=(1-pbar)*(1/rho-1);
console.log('beta 参数 alpha',+alpha.toFixed(3),'beta',+beta.toFixed(3));
// best-of-k 预测: 1 - E[(1-p)^k]
function lgamma(x){const g=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];let y=x,t=x+5.5;t-=(x+0.5)*Math.log(t);let s=1.000000000190015;for(let j=0;j<6;j++)s+=g[j]/++y;return -t+Math.log(2.5066282746310005*s/x);}
const lb=(a,b)=>lgamma(a)+lgamma(b)-lgamma(a+b);
function bestOf(kk){ let miss=0; for(let i=0;i<400;i++){ const p=(i+0.5)/400;
  const w=Math.exp(lb(alpha+kk,beta+ (m*N - 0))*0 + (alpha-1)*Math.log(p)+(beta-1)*Math.log(1-p)-lb(alpha,beta));
  miss += w*Math.pow(1-p,kk);} return 1-miss/400; }
console.log('best-of-k 预测（Beta-二项）:');
for (const kk of [1,2,3,4]) console.log('  k='+kk+' -> '+(bestOf(kk)*100).toFixed(1)+'%');

// 4) 代价
const perUnit = 0.00063;
console.log('\\n补齐到 k=3 的额外成本: 722 x 2 x $'+perUnit+' = $'+(722*2*perUnit).toFixed(2));
console.log('对比生成 3942 条新数据: $'+(3942*perUnit).toFixed(2));

// 5) 语言：更正之前的说法
const zhf=s=>{const t=(s||'');return t.length?(t.match(/[\u4e00-\u9fff]/g)||[]).length/t.length:0;};
const all=full.map(o=>zhf(o.draft)).filter(x=>x>=0);
const q=(arr,p)=>{const s=[...arr].sort((x,y)=>x-y);return s[Math.floor(s.length*p)]??0};
console.log('\\n722 教师稿中文占比: p10',+q(all,.1).toFixed(3),'p25',+q(all,.25).toFixed(3),'p50',+q(all,.5).toFixed(3),'p75',+q(all,.75).toFixed(3),'p90',+q(all,.9).toFixed(3));
console.log('中文占比 > 0.5 的条数', all.filter(x=>x>0.5).length, '/', all.length);
console.log('中文占比 > 0.15 的条数', all.filter(x=>x>0.15).length, '/', all.length);
