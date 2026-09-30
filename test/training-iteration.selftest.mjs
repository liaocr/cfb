// 有限候选/总预算/独立三值观察器/test一次性，callback模拟不证明模型泛化。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evidenceDigest } from '../src/evidence-program.js'
import { freezeEffectSuite } from '../src/effect-archive.js'
import { openTrainingAuthorities } from '../tools/helpers/training-workflow.mjs'
import { trainingFixtureRows } from '../tools/helpers/training-demo.mjs'
import { buildTrainingDataset } from '../tools/helpers/training-data.mjs'
import { prepareTrainingPlan } from '../tools/helpers/training-plan.mjs'
import { freezeTrainingIteration, runTrainingIteration } from '../tools/helpers/training-iteration.mjs'
import { trainingIterationDemo } from '../tools/helpers/training-iteration-demo.mjs'
import { readJson } from '../tools/helpers/eval-files.mjs'
let pass=0,fail=0
const test=async(n,f)=>{try{await f();pass++;console.log('PASS '+n)}catch(e){fail++;console.log('FAIL '+n+'\n'+e.stack)}}
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'cfb-iteration-tests-'))
async function fixture({maxComputeSteps=9}={}){
 const dir=fs.mkdtempSync(path.join(ROOT,'case-')),a=openTrainingAuthorities(path.join(dir,'private'),{verifyReview:()=>true,authorize:()=>true}),rows=a.reviews.approveBatch(trainingFixtureRows(),{mode:'fixture',reviewer:'fixture',checks:{identifierSafe:true,completeNative:true,goalVerified:true,criterionFrozen:true}}),input=path.join(dir,'input.jsonl');fs.writeFileSync(input,rows.map(JSON.stringify).join('\n')+'\n');const dataset=path.join(dir,'data');await buildTrainingDataset({input,output:dataset,reviews:a.reviews})
 const plans=[];for(const maxSteps of [2,3,4])plans.push(await prepareTrainingPlan({dataset,reviews:a.reviews,profile:{schema:'cfb.training-profile/1',backend:'reference-byte',recipe:{maxSteps,checkpointEvery:1,learningRate:1}},file:path.join(dir,'plan-'+maxSteps+'.json')}))
 const parts=Object.fromEntries(['train','selection','test'].map((split,i)=>[split,[{id:'goal-'+split,family:'family-'+split,input:{nonce:i},predicate:{op:'equals',field:'goal',value:true}}]])),suite=freezeEffectSuite({id:'fixture-suite',evaluatorVersion:'protected-fixture-v1',...parts}),definition=freezeTrainingIteration({id:'fixture',candidatePlans:plans,suite,evaluationScope:'a'.repeat(64),maxCandidates:3,maxComputeSteps,timeoutMs:5000})
 let trainings=0,observations=0,proposals=0
 const callbacks={propose({allowedCandidateDigests,feedback}){proposals++;assert.ok(!JSON.stringify(feedback).includes('"test"'));return allowedCandidateDigests[0]||null},train({plan}){trainings++;return{candidate:{digest:evidenceDigest({p:plan.digest}),planDigest:plan.digest,datasetDigest:plan.dataset.digest,simulated:true}}},evaluate({candidate,input}){observations++;assert.ok(!Object.hasOwn(input,'predicate'));return {observation:{goal:!!candidate},valid:true,candidateDigest:candidate?.digest||null}},authenticateTraining:r=>r.candidate!=null,authenticateObservation:r=>r.valid===true}
 const options={definition,directory:path.join(dir,'registry'),markerPath:path.join(dir,'public.json'),...callbacks}
 return {dir,plans,suite,definition,options,counts:()=>({trainings,observations,proposals})}
}
try{
 await test('01 冻结空间：不能换数据/模型/保护字段，只有限候选',async()=>{
  const f=await fixture(),p=f.plans[1],{digest,...body}=p,b={...body,dataset:{...p.dataset,digest:'f'.repeat(64)}},changed={...b,digest:evidenceDigest(b)}
  assert.throws(()=>freezeTrainingIteration({id:'bad',candidatePlans:[f.plans[0],changed],suite:f.suite,evaluationScope:'a'.repeat(64),maxCandidates:3,maxComputeSteps:9}),/protected-fields/)
 })
 await test('02 共用baseline、逐项严格选择、final test一次，后续全cache0callback',async()=>{
  const f=await fixture(),r=await runTrainingIteration(f.options);assert.equal(r.reservedCandidates,3);assert.equal(r.computeUpperReserved,9);assert.equal(r.testEffects.length,1);assert.equal(r.accepted,true);assert.equal(r.released,false);const c=f.counts();assert.equal((await runTrainingIteration(f.options)).cached,true);assert.deepEqual(f.counts(),c)
 })
 await test('03 全平局正常关闭且不消费test/不制造正收益',async()=>{
  const f=await fixture(),r=await runTrainingIteration({...f.options,evaluate:()=>({observation:{goal:false},valid:true})});assert.equal(r.selectedCandidate,null);assert.equal(r.testEffects.length,0);assert.equal(r.accepted,false)
  assert.ok(!readJson(f.options.markerPath).consumedTestFamilies.includes('family-test'))
 })
 await test('04 一格负项不能被其他格平均正项抵消',async()=>{
  const f=await fixture(),r=await runTrainingIteration({...f.options,evaluate:({candidate,input})=>({observation:{goal:input.nonce===0?!candidate:!!candidate},valid:true})});assert.equal(r.selectedCandidate,null);assert.equal(r.accepted,false)
 })
 await test('05 不可信/Promise认证/缺失观测是unknown，不用not变pass',async()=>{
  const f=await fixture(),r=await runTrainingIteration({...f.options,authenticateObservation:async()=>true});assert.equal(r.selectedCandidate,null);assert.ok(r.evaluations.every(e=>e.effects.every(x=>x.sign==='?')))
 })
 await test('06 未批准proposal不执行train，不将任意模型参数当授权',async()=>{
  const f=await fixture();await assert.rejects(runTrainingIteration({...f.options,propose:()=> 'outside-space'}),/outside-frozen-space/);assert.equal(f.counts().trainings,0)
 })
 await test('07 总compute上限先预占再train；未知不退款或重试',async()=>{
  const f=await fixture({maxComputeSteps:1});await assert.rejects(runTrainingIteration(f.options),/training-iteration-budget/);assert.equal(f.counts().trainings,0)
  await assert.rejects(runTrainingIteration(f.options),/unresolved-no-retry/)
 })
 await test('08 train未知保留预占，callback秘密只剩安全错误码',async()=>{
  const f=await fixture();await assert.rejects(runTrainingIteration({...f.options,train:()=>{throw new Error('private-callback-body')}}),e=>e.message==='training-iteration-callback-error')
  const m=readJson(f.options.markerPath);assert.equal(m.cycles[0].computeUpperReserved,2);assert.equal(m.cycles[0].status,'unknown');assert.ok(!JSON.stringify(m).includes('private-callback-body'))
 })
 await test('09 test在任何test观察器执行前已经持久消费并锁定候选',async()=>{
  const f=await fixture();let checked=false
  await runTrainingIteration({...f.options,evaluate:({candidate,input})=>{if(input.nonce===2){const m=readJson(f.options.markerPath);assert.ok(m.consumedTestFamilies.includes('family-test'));assert.equal(m.cycles[0].testReserved,true);checked=true}return {observation:{goal:!!candidate},valid:true}}});assert.equal(checked,true)
 })
 await test('10 换cycle不重用同test：训练/propose前就拒绝',async()=>{
  const f=await fixture();await runTrainingIteration(f.options);const c=f.counts(),def=freezeTrainingIteration({...f.definition,id:'renamed-cycle'})
  await assert.rejects(runTrainingIteration({...f.options,definition:def}),/test-already-consumed/);assert.deepEqual(f.counts(),c)
 })
 await test('11 final test未知不会再提议/换candidate/返还族',async()=>{
  const f=await fixture(),r=await runTrainingIteration({...f.options,evaluate:({candidate,input})=>input.nonce===2?{observation:{},valid:true}:{observation:{goal:!!candidate},valid:true}});assert.equal(r.accepted,false);assert.equal(r.testEffects[0].sign,'?');assert.ok(readJson(f.options.markerPath).consumedTestFamilies.includes('family-test'))
 })
 await test('12 public保留而private目录丢失不重新初始化搜索额度',async()=>{
  const f=await fixture();await runTrainingIteration(f.options);fs.rmSync(f.options.directory,{recursive:true,force:true});await assert.rejects(runTrainingIteration(f.options),/iteration-restore-required/)
 })
 await test('13 训练认证也要同步true，不能自报candidate就训练成功',async()=>{
  const f=await fixture();await assert.rejects(runTrainingIteration({...f.options,authenticateTraining:()=> 'yes'}),/training-unverified/)
 })
 await test('14 deadline未知不猜，late回调不成为当前证书',async()=>{
  const f=await fixture(),def=freezeTrainingIteration({...f.definition,timeoutMs:20});let aborted=false
  await assert.rejects(runTrainingIteration({...f.options,definition:def,train:(_args,signal)=>new Promise((_res)=>{signal.addEventListener('abort',()=>{aborted=true})})}),/iteration-timeout/);assert.equal(aborted,true)
 })
 await test('15 实际reference训练闭环保留被证伪目标，无候选时0 test；工程路径正项也不发布',async()=>{
  const r=await trainingIterationDemo();assert.equal(r.actualReferenceTrainings,3);assert.equal(r.rejectedGoalCase.selected,false);assert.equal(r.rejectedGoalCase.originalCriterionKept,true);assert.equal(r.rejectedGoalCase.testComparisons,0);assert.equal(r.engineeringRoute.finalTestComparisons,1);assert.equal(r.engineeringRoute.modelQualityClaimed,false);assert.equal(r.productionActivated,false)
 })
}finally{fs.rmSync(ROOT,{recursive:true,force:true})}
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);if(fail)process.exitCode=1
