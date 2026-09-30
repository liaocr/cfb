// 同一个本地协调器/ACK/HMAC/watermark，真实子进程/文件；fixture不是HF/LoRA权重。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openTrainingAuthorities } from '../tools/helpers/training-workflow.mjs'
import { trainingFixtureRows } from '../tools/helpers/training-demo.mjs'
import { buildTrainingDataset } from '../tools/helpers/training-data.mjs'
import { prepareTrainingPlan } from '../tools/helpers/training-plan.mjs'
import { openTrainingState } from '../tools/helpers/training-state.mjs'
import { coordinateLocalTraining, offlineLocalWorkerAdapter } from '../tools/helpers/training-local-worker.mjs'
import { reconcileLocalTraining, localHostIdentity, localProcessIdentity, inspectCertifiedCheckpoint } from '../tools/helpers/training-local-checkpoint.mjs'
import { readJson, writeJson } from '../tools/helpers/eval-files.mjs'
let pass=0,fail=0
const test=async(name,fn)=>{try{await fn();pass++;console.log('PASS '+name)}catch(e){fail++;console.log('FAIL '+name+'\n'+e.stack)}}
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'cfb-local-worker-'))
async function fixture({maxComputeSteps=8}={}){
 const root=fs.mkdtempSync(path.join(ROOT,'case-')),authority=openTrainingAuthorities(path.join(root,'private'),{verifyReview:()=>true,authorize:()=>true})
 const rows=authority.reviews.approveBatch(trainingFixtureRows(),{mode:'fixture',reviewer:'fixture',checks:{identifierSafe:true,completeNative:true,goalVerified:true,criterionFrozen:true}}),input=path.join(root,'input.jsonl');fs.writeFileSync(input,rows.map(JSON.stringify).join('\n')+'\n')
 const dataset=path.join(root,'data');await buildTrainingDataset({input,output:dataset,reviews:authority.reviews})
 const planFile=path.join(root,'plan.json'),plan=await prepareTrainingPlan({dataset,reviews:authority.reviews,profile:{schema:'cfb.training-profile/1',backend:'local-lora',recipe:{maxSteps:5,checkpointEvery:2,gradientAccumulation:1},limits:{maxComputeSteps}},file:planFile}),approval=authority.governance.approve(plan,{mode:'fixture',owner:'fixture',maxUsd:0})
 const directory=path.join(root,'state'),markerPath=path.join(root,'public.json'),opts={plan,reviews:authority.reviews,approval,directory,markerPath,planFile,execute:true}
 return {...opts,root,authority,session:()=>openTrainingState({directory,markerPath,plan,scope:approval.id})}
}
const run=(f,extra={})=>coordinateLocalTraining({...f,adapter:offlineLocalWorkerAdapter(),...extra})
try{
 await test('01 ACK前預占、每步增资源/逻辑进度，完整checkpoint才candidate',async()=>{
  const f=await fixture(),r=await run(f);assert.equal(r.trainedStep,5);assert.equal(r.computeSteps,5);assert.equal(r.candidate.simulated,true);assert.equal(f.session().read().phase,'candidate')
  const c=await run(f);assert.equal(c.cached,true);assert.equal(c.computeSteps,5)
 })
 await test('02 正常pause自动使用已认证latest checkpoint，原作业续训',async()=>{
  const f=await fixture(),first=await run(f,{stopAfter:2});assert.equal(first.paused,true);assert.equal(first.trainedStep,2)
  const next=await run(f);assert.equal(next.trainedStep,5);assert.equal(next.computeSteps,5)
 })
 await test('03 非正常第3步退出不是成功；未reconcile拒绝再launch',async()=>{
  const f=await fixture(),first=await run(f,{adapter:offlineLocalWorkerAdapter({fault:'crash-after-uncheckpointed-step'})});assert.equal(first.phase,'recoverable');assert.equal(first.computeSteps,3);assert.equal(first.modelSuccessClaimed,false)
  await assert.rejects(run(f),/training-local-reconciliation-required/)
 })
 await test('04 reconcile回逻辑2但已花3保留，重做也花钱，最终5/6',async()=>{
  const f=await fixture();await run(f,{adapter:offlineLocalWorkerAdapter({fault:'crash-after-uncheckpointed-step'})})
  const before=f.session().read(),r=await reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory});assert.equal(r.restoredLogicalStep,2);assert.equal(r.computeStepsRetained,3);assert.equal(r.elapsedMsRetained,before.elapsedMs)
  const next=await run(f);assert.equal(next.trainedStep,5);assert.equal(next.computeSteps,6)
 })
 await test('05 没有重做预算时暂停4/5而非退款后报完成',async()=>{
  const f=await fixture({maxComputeSteps:5});await run(f,{adapter:offlineLocalWorkerAdapter({fault:'crash-after-uncheckpointed-step'})});await reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory})
  const next=await run(f);assert.equal(next.paused,true);assert.equal(next.trainedStep,4);assert.equal(next.computeSteps,5);assert.equal(f.session().read().candidate,null)
  await assert.rejects(run(f),/training-compute-budget-exhausted/)
 })
 await test('06 无ACK伪造step不推进逻辑、不授candidate',async()=>{
  const f=await fixture(),r=await run(f,{adapter:offlineLocalWorkerAdapter({fault:'no-ack-step'})});assert.equal(r.phase,'unknown');assert.equal(r.computeSteps,0);assert.match(r.reason,/step-not-authorized/)
 })
 await test('07 外部路径伪造checkpoint不读仓库/不执行恢复',async()=>{
  const f=await fixture(),r=await run(f,{adapter:offlineLocalWorkerAdapter({fault:'foreign-checkpoint'})});assert.equal(r.phase,'unknown');assert.equal(r.checkpointRef,null);assert.equal(r.reason,'training-checkpoint-outside-attempt')
 })
 await test('08 无任何见证的unknown不能靠resume文件名复活',async()=>{
  const f=await fixture();await run(f,{adapter:offlineLocalWorkerAdapter({fault:'crash-before-checkpoint'})})
  await assert.rejects(reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory}),/training-checkpoint-unverified/)
 })
 await test('09 optimizer/RNG文件也校验；改pt拒绝reconcile和cache',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});const proof=await inspectCertifiedCheckpoint({session:f.session(),plan:f.plan,jobDirectory:f.directory,ref:f.session().read().latestCheckpointRef})
  fs.appendFileSync(path.join(proof.directory,'optimizer.pt'),'changed');await assert.rejects(run(f),/training-checkpoint-artifact-drift/)
 })
 await test('10 旧worker仍活不能猜退出、不能拿checkpoint清pending',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});f.session().update(s=>({...s,phase:'unknown',pending:{type:'local-worker'},localAttempts:s.localAttempts.map((a,i)=>i===s.localAttempts.length-1?{...a,exitConfirmed:false,process:localProcessIdentity(process.pid)}:a)}))
  await assert.rejects(reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory}),/training-worker-still-alive/)
 })
 await test('11 移机不能用本机PID缺失证明旧机退出；需同步可信attestation',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});f.session().update(s=>({...s,phase:'unknown',pending:{type:'local-worker'},localAttempts:s.localAttempts.map((a,i)=>i===s.localAttempts.length-1?{...a,exitConfirmed:false,process:{pid:999999,startToken:'x',hostIdentity:'f'.repeat(64)}}:a)}))
  await assert.rejects(reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory}),/foreign-worker-exit-unverified/)
  await assert.rejects(reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory,attestForeignExit:async()=>true}),/foreign-worker-exit-unverified/)
  const r=await reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory,attestForeignExit:()=>true});assert.equal(r.computeStepsRetained,2)
 })
 await test('12 租约故障不抢外部/活worker，不随便删锁',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});const lock=path.join(f.directory,'.local-worker.lock');writeJson(lock,{attemptId:'other',hostIdentity:localHostIdentity()})
  await assert.rejects(run(f),/training-local-worker-lease/)
  await assert.rejects(reconcileLocalTraining({session:f.session(),plan:f.plan,directory:f.directory}),/training-local-worker-lease-binding/);assert.equal(fs.existsSync(lock),true)
 })
 await test('13 trainedStep倒退需HMAC恢复见证；墙钟/compute/HTTP不倒退',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});assert.throws(()=>f.session().update(s=>({...s,trainedStep:1})),/logical-rollback-unverified/);assert.throws(()=>f.session().update(s=>({...s,elapsedMs:0})),/training-state-update/)
 })
 await test('14 预取消零worker/零水位，角色伪造不触发真实训练',async()=>{
  const f=await fixture(),ctl=new AbortController();ctl.abort();await assert.rejects(run(f,{signal:ctl.signal}),/aborted-before-worker/);assert.equal(fs.existsSync(f.markerPath),false)
  await assert.rejects(run(f,{approval:{...f.approval}}),/local-compute-approval-required/)
 })
 await test('15 任意--resume路径不能代替已见证checkpoint',async()=>{
  const f=await fixture();await run(f,{stopAfter:2});await assert.rejects(run(f,{resume:f.root}),/resume-not-certified-latest/)
 })
}finally{fs.rmSync(ROOT,{recursive:true,force:true})}
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);if(fail)process.exitCode=1
