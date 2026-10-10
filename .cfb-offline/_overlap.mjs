
import fs from 'node:fs';
const rd = p => fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = rd('.cfb-offline/teacher/v4-full.jsonl');
const f100 = rd('.cfb-offline/teacher/v4-100.jsonl');
const f30  = rd('.cfb-offline/teacher/v4-30.jsonl');
const f5_30 = rd('.cfb-offline/teacher/v5-30.jsonl');
const ids = o => new Set(o.map(x=>x.id));
const F = ids(full), H = ids(f100), T = ids(f30), V = ids(f5_30);
const inter = (a,b) => [...a].filter(x=>b.has(x)).length;
console.log('v4-full', full.length, 'v4-100', f100.length, 'v4-30', f30.length, 'v5-30', f5_30.length);
console.log('v4-100 ∩ v4-full =', inter(H,F));
console.log('v4-30  ∩ v4-full =', inter(T,F));
console.log('v4-30  ∩ v4-100  =', inter(T,H));
console.log('v5-30  ∩ v4-full =', inter(V,F));
console.log('v5-30  ∩ v4-30   =', inter(V,T));
// 是不是「短名单前 N 条」？
const short = rd('.cfb-offline/ruler/raw-mine-shortlist.jsonl').map(o=>o.unitId);
console.log('v4-30 是短名单前 30 条:', JSON.stringify(f30.map(o=>o.id)) === JSON.stringify(short.slice(0,30)));
console.log('v4-100 是短名单前 100 条:', JSON.stringify(f100.map(o=>o.id)) === JSON.stringify(short.slice(0,100)));
console.log('v4-full 是短名单前 722 条:', JSON.stringify(full.map(o=>o.id)) === JSON.stringify(short.slice(0,722)));
console.log('v5-30 与 v4-30 是同一批单元:', JSON.stringify([...V].sort()) === JSON.stringify([...T].sort()));
