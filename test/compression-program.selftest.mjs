// Continuation programme apparatus. All model/transport examples here are
// explicitly synthetic fixtures; no host/API/tokenizer/model inference is claimed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildReviewedDev } from '../tools/micro-generator/build-program-dev.mjs'
import { buildControls } from '../tools/micro-generator/build-program-controls.mjs'
import { buildSourceRegistry, reviewReport, workStatus, PROGRAM_DIR } from '../tools/micro-generator/program.mjs'
import { buildFormalSft, toFlatSft, writeFormalBundle } from '../tools/micro-generator/formal-sft.mjs'
import { makeReaderStudyPlan, evaluateReaderObservations, readerAuthorizationScope } from '../tools/micro-generator/reader-study.mjs'
import { validateCompleteReview, checkTextCoverage, flatRowDigest, boundAnnotationDigest, digestJson } from '../tools/micro-generator/review-contract.mjs'
import { sha256, readJsonl } from '../tools/micro-generator/lib.mjs'
import { auditReadback, parseReadbackLog } from '../tools/readback-audit.mjs'
import { replacementEvidence, requestEvidence } from '../src/readback-evidence.js'
import { streamProvenanceRecord } from '../src/messages.js'
import { birthStart, birthFinish } from '../src/birth.js'
import { normalizeConfig } from '../src/config.js'
import { carryCheck, preflightUpstream, preflightScopeOf, PREFLIGHT_CACHE_MAX_AGE_MS } from '../tools/traj-run.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-compression-program-'))
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.error('FAIL ' + name + '\n' + e.stack) } }
const clone = structuredClone
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/micro-generator/task-contract.json'), 'utf8'))
const annotations = readJsonl(path.join(ROOT, PROGRAM_DIR, 'reviewed-dev.jsonl'))
const reviews = readJsonl(path.join(ROOT, PROGRAM_DIR, 'complete-reviews.jsonl'))
const registry = buildSourceRegistry(ROOT)
const control = buildControls(ROOT)
const formal = (patch = {}) => buildFormalSft({ root: ROOT, annotations, reviews, registry, contract, prompt: 'fixture compressor instruction', model: { id: 'fixture-model', revision: 'a'.repeat(40) }, ...patch })
const chatCounter = (model = 'DeepSeek-V4.1-Flash') => {
  let calls = 0
  const chat = async (body) => { calls++; const L = body.messages.reduce((n,m) => n + String(m.reasoning_content || '').length, 0); return { message: { reasoning_content: 'fixture reasoning', content: '2' }, usage: { prompt_tokens: 100 + Math.ceil(L * .5), completion_tokens: 1 }, model, fp: null, finish: 'stop' } }
  return { chat, calls: () => calls }
}

// Positive protocol-wire fixtures below intentionally exercise declared receipt
// fields in TEMP directories. They are not actual source/reader/CPU evidence, are
// never copied to the repository corpus, and perform no inference/training.
function makeFormalWireFixture(label) {
  const root=path.join(temp,'formal-'+label);fs.mkdirSync(root)
  const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});const bytes=JSON.stringify(value,null,2)+'\n';fs.writeFileSync(file,bytes);return{path:name,sha256:sha256(bytes)}}
  const aa=[0,6,12].map((n,i)=>{const a=clone(control.controls[n].annotation);a.caseId='unit-formal-'+i;a.family='unit-family-'+i;a.finalSplit=i<2?'train':'dev';a.provenanceSplit='unit-only';a.trainingEligible=true;return a})
  const rr=[0,6,12].map((n,i)=>{const r=clone(control.controls[n].review);r.caseId=aa[i].caseId;r.annotationSha256=boundAnnotationDigest(aa[i]);return r})
  const entries=aa.map((a,i)=>({inputSha256:rr[i].inputSha256,rawSha256:a.sourceHashes.rawSha256,ctxSha256:a.sourceHashes.ctxSha256,families:[a.family],repo:'unit/repo-'+i,exposure:['unit-only'],records:[{caseId:a.caseId,recordSha256:boundAnnotationDigest(a)}],sourceAdmission:{admitted:true,modelVersionVerified:true,temporalBoundaryVerified:true,licenseReviewed:true,privacyReviewed:true,reviewRef:write('proof-'+i+'.json',{schema:'cfb.source-admission-review/1',status:'admitted',sourceModel:{id:contract.receiver.id,servedVersion:'unit-source-version-not-evidence'},inputSha256:rr[i].inputSha256,rawSha256:a.sourceHashes.rawSha256,ctxSha256:a.sourceHashes.ctxSha256,fixtureOnly:false,note:'Artificial declaration fields solely for temporary codepath test; no actual source admission.'})}}))
  const reg={schema:'cfb.source-registry/1',errors:[],entries}
  const c=clone(contract);c.resources.resourceBudgetConfirmed=true
  const model={id:'fla-hub/rwkv7-0.1B-g1',revision:'a'.repeat(40)}
  const prereg=write('unit-prereg.json',{status:'frozen-for-content-and-original-reader-evaluation',promotionThresholds:{unitTestThreshold:1}})
  const evidence={preregistration:prereg,ruler:write('unit-ruler.json',{preregSha256:prereg.sha256,validity:{unitWire:'PASS',VALID:'VALID'},fixtureOnly:false,originalReaderValidated:true,note:'Synthetic protocol fixture, not a valid project ruler.'}),readerStudy:write('unit-reader.json',{schema:'cfb.original-reader-study/1',actualExecution:true,fixtureOnly:false,receiver:c.receiver.id,readerVersion:'unit-fixture-not-a-model',aAControlExecuted:true,allRegisteredCasesAccounted:true,referenceUtilityVerified:true,preregSha256:prereg.sha256,note:'Artificial protocol fields; not reader execution.'}),cpu:write('unit-cpu.json',{kind:'cpuQualityAndLatencyVerified',verified:true,actualExecution:true,fixtureOnly:false,model,note:'Artificial protocol fields; no CPU model executed.'})}
  const args={root,annotations:aa,reviews:rr,registry:reg,contract:c,prompt:'Unit-only compressor system. Never use these fixtures to train.',model,evidence}
  const result=buildFormalSft(args)
  return {root,args,result,export:()=>{const out=path.join(root,'export');writeFormalBundle({...args,out,result});return out}}
}
function runPythonPreflight(dir) {
  return spawnSync('python3',['deploy/kaggle/train_rwkv7.py','--preflight-only','--data',path.join(dir,'train.jsonl'),'--dev',path.join(dir,'dev.jsonl'),'--admission',path.join(dir,'admission.json'),'--model-revision','a'.repeat(40)],{cwd:ROOT,encoding:'utf8'})
}
function makeReaderWireFixture(label) {
  const root=path.join(temp,'reader-'+label);fs.mkdirSync(root)
  const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});const bytes=JSON.stringify(value,null,2)+'\n';fs.writeFileSync(file,bytes);return{path:name,sha256:sha256(bytes)}}
  const plan=makeReaderStudyPlan(ROOT)
  for(const ref of [plan.annotations,plan.completeReviews,plan.preregistration]){const dest=path.join(root,ref.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(ROOT,ref.path),dest)}
  plan.servedVersion='unit-provider-version-not-model-evidence'
  plan.channelScopeRef=write('channel.json',{receiver:plan.receiver,servedVersion:plan.servedVersion,requestModel:plan.receiver,endpoint:'https://fixture.invalid/no-call'})
  plan.toolsRef=write('tools.json',[]);plan.decodingRef=write('decoding.json',{temperature:0,stream:false,max_tokens:128})
  for(const [k,r] of [['channelScopeSha256','channelScopeRef'],['toolsSha256','toolsRef'],['decodingSha256','decodingRef']])plan[k]=plan[r].sha256
  const bodies=[]
  for(const [i,c]of plan.cases.entries()){
    const a=annotations[i],body={model:plan.receiver,messages:[{role:'user',content:a.ctx},{role:'assistant',reasoning_content:a.raw,content:'fixture only'},{role:'user',content:'continue fixture only'}],tools:[],temperature:0,stream:false,max_tokens:128};bodies.push(body)
    c.birthStateRef=write('state-'+i+'.json',{schema:'cfb.reader-birth-state/1',caseId:c.caseId,inputSha256:c.inputSha256,rawSha256:c.rawSha256,ctxSha256:c.ctxSha256,compressorCtx:a.ctx,reasoningMessageIndex:1,requestBeforeReplacement:body,environmentSnapshots:[write('env-'+i+'.json',{synthetic:true,note:'unit environment, not actual birth state'})]})
  }
  plan.requestBudget={authorized:true,maximumPaidRequests:9,maximumRetriesPerRequest:0,maximumUsd:1,credentialsInPlanAllowed:false,approvalRef:null}
  plan.requestBudget.approvalRef=write('approval.json',{kind:'user-authorized-reader-study-scope',authorized:true,scopeSha256:readerAuthorizationScope(plan),note:'Artificial protocol fixture only, not actual paid-call authorization.'})
  delete plan.planSha256;plan.planSha256=digestJson(plan)
  const observations=[]
  for(const [i,c]of plan.cases.entries())for(const arm of plan.arms){
    const body=clone(bodies[i]);if(arm==='reference')body.messages[1].reasoning_content=annotations[i].referenceDraft
    const callId='fixture-call-'+i+'-'+arm,requestRef=write('req-'+callId+'.json',body),responseRef=write('resp-'+callId+'.json',{id:callId,model:plan.servedVersion,choices:[{message:{role:'assistant',content:'fixture response'}}],usage:{prompt_tokens:100,completion_tokens:10}})
    const outcome={taskSuccess:true,falseCompletion:false,constraintViolations:0,extraToolRounds:0}
    observations.push({schema:'cfb.reader-continuation-observation/1',caseId:c.caseId,arm,planSha256:plan.planSha256,inputSha256:c.inputSha256,birthStateSha256:c.birthStateRef.sha256,channelScopeSha256:plan.channelScopeSha256,toolsSha256:plan.toolsSha256,decodingSha256:plan.decodingSha256,readerModel:plan.receiver,readerVersion:plan.servedVersion,executionMode:'actual-provider',actualExecution:true,fixtureOnly:false,callId,requestRef,responseRef,outcome,status:'completed',latencyMs:10,outcomeReviewRef:write('grade-'+callId+'.json',{caseId:c.caseId,callId,responseSha256:responseRef.sha256,requestSha256:requestRef.sha256,birthStateSha256:c.birthStateRef.sha256,outcomeSha256:digestJson(outcome),status:'complete',reviewerId:'unit-reviewer',fixtureOnly:false,note:'Artificial protocol fields in unit fixture, not actual review.'})})
  }
  return {root,plan,observations,write,evaluate:(rows=observations,p=plan)=>evaluateReaderObservations({root,plan:p,observations:rows})}
}

try {
  await test('contract keeps continuation, source epistemics, fallback and unknown budgets distinct', () => {
    assert.equal(contract.input.temporalBoundary.includes('No subsequent'), true)
    assert.equal(contract.quality.universalNeverWorseClaimAllowed, false)
    assert.equal(contract.resources.resourceBudgetConfirmed, false)
    assert.ok(Object.values(contract.authorization).every((x) => x === false))
    assert.equal(contract.executionOrder[0], 'task contract and actual readback observability')
  })
  await test('registry deduplicates source inputs without inventing independent n or admitted data', () => {
    assert.deepEqual(registry.errors, [])
    assert.equal(registry.counts.retainedRecords, 42); assert.equal(registry.counts.uniqueRawCtx, 22)
    assert.equal(registry.counts.trainingAdmitted, 0); assert.equal(registry.independentSampleCount, null)
    assert.ok(registry.entries.every((r) => !r.trainingAdmitted))
    assert.equal(registry.entries.filter((r) => r.roles.includes('off-target-auxiliary')).length, 6)
  })
  await test('stale source bytes cannot silently enter the registry', () => {
    const root = path.join(temp, 'stale-registry'); fs.mkdirSync(root)
    const row = clone(annotations[0]); row.raw += ' altered'
    fs.writeFileSync(path.join(root, 'cases.jsonl'), JSON.stringify(row) + '\n')
    const r = buildSourceRegistry(root, [{ path: 'cases.jsonl', role: 'fixture', scope: 'existing-dev' }])
    assert.ok(r.errors.some((e) => e.includes('stale source hashes')))
  })
  await test('exposed family cannot be moved into train by a new Boolean', () => {
    const root = path.join(temp, 'split-registry'); fs.mkdirSync(root)
    const row = clone(annotations[0]); row.finalSplit = 'train'; row.trainingEligible = true
    fs.writeFileSync(path.join(root, 'cases.jsonl'), JSON.stringify(row) + '\n')
    assert.ok(buildSourceRegistry(root, [{ path: 'cases.jsonl', role: 'fixture', scope: 'existing-dev' }]).errors.some((e) => e.includes('reassigned to train')))
  })
  await test('case ID collision is not repaired by directory/file ordering', () => {
    const root = path.join(temp, 'collision-registry'); fs.mkdirSync(root)
    const a = clone(annotations[0]), b = clone(a); b.referenceDraft += ' changed'; b.sourceHashes.referenceSha256 = sha256(b.referenceDraft)
    fs.writeFileSync(path.join(root, 'cases.jsonl'), [a,b].map(JSON.stringify).join('\n') + '\n')
    assert.ok(buildSourceRegistry(root, [{ path: 'cases.jsonl', role: 'fixture', scope: 'existing-dev' }]).errors.some((e) => e.includes('case ID reused')))
  })
  await test('full development review is exactly reproducible and remains untrainable', () => {
    const built = buildReviewedDev(ROOT)
    assert.deepEqual(built.annotations, annotations); assert.deepEqual(built.reviews, reviews)
    assert.equal(annotations.length, 3)
    assert.equal(annotations.reduce((n,a) => n + a.facts.length, 0), 74)
    assert.equal(reviews.reduce((n,r) => n + r.draftClaims.length, 0), 20)
    for (const [i,a] of annotations.entries()) { assert.deepEqual(validateCompleteReview(a,reviews[i]), []); assert.equal(a.trainingEligible, false); assert.equal(a.finalSplit,'dev') }
  })
  await test('review reporting does not claim original receiver or human certification', () => {
    const r = reviewReport(ROOT); assert.deepEqual(r.errors, []); assert.equal(r.completeAiReviewedCases, 3)
    assert.equal(r.humanReviews, 0); assert.equal(r.independentSecondReviews, 0)
    assert.equal(r.originalReceiverValidated, false); assert.equal(r.trainingAdmitted, false)
  })
  await test('stale complete-review annotation hashes fail closed', () => {
    const a = clone(annotations[0]); a.referenceDraft += ' added'
    assert.ok(validateCompleteReview(a,reviews[0]).some((e) => e.includes('binding mismatch')))
  })
  await test('complete review cannot hide an unreviewed source paragraph', () => {
    const r = clone(reviews[0]); r.sourceUnits.raw.shift()
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('unreviewed non-whitespace')))
  })
  await test('overlapping whole-source coverage units do not manufacture completeness', () => {
    const r = clone(reviews[0]); r.sourceUnits.raw.push(clone(r.sourceUnits.raw[0]))
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('overlapping')))
  })
  await test('material unit must cite explicitly annotated source facts', () => {
    const r = clone(reviews[0]); const u = r.sourceUnits.raw.find((u) => u.classification === 'material'); u.factIds = []
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('requires explicit atomic facts')))
  })
  await test('draft coverage must adjudicate all output text, not just a few claims', () => {
    const r = clone(reviews[0]); r.draftClaims.pop()
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('unreviewed non-whitespace')))
  })
  await test('unsupported claims cannot be covered by a zero-count summary', () => {
    const r = clone(reviews[0]); r.draftClaims[0].status = 'unsupported'
    const errors = validateCompleteReview(annotations[0],r)
    assert.ok(errors.some((e) => e.includes('unsafe claims'))); assert.ok(errors.some((e) => e.includes('unsupported count')))
  })
  await test('supported claims require valid source fact references', () => {
    const r = clone(reviews[0]); r.draftClaims[0].sourceFactIds = []
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('without source facts')))
  })
  await test('invented human/second review never upgrades complete AI review', () => {
    const r = clone(reviews[0]); r.humanReviewerCount = 1; r.independentSecondReview = true
    assert.ok(validateCompleteReview(annotations[0],r).some((e) => e.includes('provenance mismatch')))
  })
  await test('UTF-16 offsets preserve astral characters; code-point offsets fail', () => {
    assert.deepEqual(checkTextCoverage('🧪 value', [{ start:0,end:8,quote:'🧪 value' }], 'fixture'), [])
    assert.ok(checkTextCoverage('🧪 value', [{ start:0,end:7,quote:'🧪 value' }], 'fixture').length)
  })
  await test('explicit-label counterfactual and equivalent controls are apparatus-only', () => {
    assert.equal(control.controls.length, 30); assert.equal(control.report.apparatusMatchedAll, true)
    assert.equal(control.report.validity.VALID, 'NOT_VALIDATED'); assert.equal(control.report.originalReaderValidated, false)
    assert.equal(control.report.counterfactualSourcePairs, 4)
    assert.ok(control.controls.every((r) => r.trainingAdmitted === false && r.fixtureOnly === true))
    assert.ok(control.report.results.filter((r) => /equivalent/.test(r.role)).every((r) => r.observed))
    assert.ok(control.report.results.filter((r) => /harmful/.test(r.role)).every((r) => !r.observed))
  })
  await test('syntax 400 is not positive semantic/carry evidence', async () => {
    let calls = 0
    const chat = async () => { if (++calls === 2) throw new Error('HTTP 400 missing reasoning_content'); return { usage:{ prompt_tokens:100 }, fp:null } }
    const r = await carryCheck({ chat, o:{ model:'fixture' }, messages:[{role:'assistant',reasoning_content:'x'.repeat(100)}], tools:[{type:'function'}] })
    assert.equal(r.verdict, 'syntax-contract-only'); assert.equal(r.ok, false); assert.equal(r.semanticCarryVerified,false)
  })
  await test('prompt accounting delta remains only an accounting observation', async () => {
    const fake = chatCounter(); const r = await carryCheck({ chat:fake.chat, o:{model:'fixture'}, messages:[{role:'assistant',reasoning_content:'x'.repeat(100)}] })
    assert.equal(r.ok,true); assert.equal(r.deltaAccountingVerified,true); assert.equal(r.semanticCarryVerified,false)
  })
  await test('predecessor/year alias is no longer silently relabelled V4.1', async () => {
    const fake = chatCounter('deepseek-v4-flash-2026')
    const r = await preflightUpstream({ chat:fake.chat, o:{model:'DeepSeek-V4.1-Flash',baseUrl:'http://fixture',requireFp:false} })
    assert.ok(r.failed.includes('model'))
  })
  await test('preflight cache is scoped to channel/model/tool mode, not just an output folder', () => {
    const o={model:'DeepSeek-V4.1-Flash',baseUrl:'https://fixture-a',textTools:false,requireFp:true}
    for (const patch of [{model:'DeepSeek-V4-Flash'},{baseUrl:'https://fixture-b'},{textTools:true},{requireFp:false}]) assert.notEqual(preflightScopeOf(o),preflightScopeOf({...o,...patch}))
  })
  await test('only explicit fresh scoped accounting cache can avoid probes; semantics stays false', async () => {
    const out=path.join(temp,'good-cache'); fs.mkdirSync(out)
    const o={out,model:'DeepSeek-V4.1-Flash',baseUrl:'https://fixture',requireFp:true,reusePreflight:true}
    const cached={schema:'cfb.preflight/1',ok:true,scopeSha256:preflightScopeOf(o),observedAt:new Date().toISOString(),at:new Date().toISOString(),carry:{ok:true,deltaAccountingVerified:true},semanticCarryVerified:true}
    fs.writeFileSync(path.join(out,'preflight.jsonl'),JSON.stringify(cached)+'\n')
    const fake=chatCounter(); const r=await preflightUpstream({chat:fake.chat,o}); assert.equal(r.cached,true);assert.equal(fake.calls(),0);assert.equal(r.semanticCarryVerified,false)
  })
  await test('wrong scope, expired, legacy and implicit preflight reuse all probe afresh', async () => {
    for (const [id,patch,oPatch] of [['wrong',{scopeSha256:'a'.repeat(64)},{}],['old',{observedAt:new Date(Date.now()-PREFLIGHT_CACHE_MAX_AGE_MS-1000).toISOString()},{}],['legacy',{observedAt:null,scopeSha256:null},{}],['implicit',{}, {reusePreflight:false}]]) {
      const out=path.join(temp,'cache-'+id);fs.mkdirSync(out)
      const o={out,model:'DeepSeek-V4.1-Flash',baseUrl:'https://fixture',requireFp:true,reusePreflight:true,...oPatch}
      const cached={schema:'cfb.preflight/1',ok:true,scopeSha256:preflightScopeOf(o),observedAt:new Date().toISOString(),carry:{ok:true,deltaAccountingVerified:true},...patch}
      fs.writeFileSync(path.join(out,'preflight.jsonl'),JSON.stringify(cached)+'\n')
      const fake=chatCounter();const r=await preflightUpstream({chat:fake.chat,o});assert.notEqual(r.cached,true);assert.ok(fake.calls()>0)
    }
  })
  await test('hash-only capture never mutates messages or records raw/credentials', () => {
    const body={model:'fixture',messages:[{role:'assistant',reasoning_content:'private exact source'}],apiKey:'secret-value'}
    const original=JSON.stringify(body),r=requestEvidence({body,sessionId:'fixture',fixtureOnly:true})
    assert.equal(JSON.stringify(body),original);assert.equal(JSON.stringify(r).includes('private exact source'),false);assert.equal(JSON.stringify(r).includes('secret-value'),false)
  })
  await test('default host tracing has no new expensive hash capture until opt-in', () => {
    assert.equal(normalizeConfig({}).traceReadbackHashes,false)
    const cfg=normalizeConfig({traceReadbackHashes:true});assert.ok(!cfg.unknownOptions.includes('traceReadbackHashes'))
    const r=streamProvenanceRecord({n:1,options:{messages:[]},session:null});assert.equal(r.readbackEvidence,undefined)
  })
  await test('birth chunks, assembled assistant and next hook are correlated in a fixture only', async () => {
    const events=[],raw='Known evidence. No edit performed. Next inspect the file. '.repeat(30),draft='Known evidence. No edit performed. Next inspect the file.'
    const cfg=normalizeConfig({mode:'birth',dryRun:false,compressPrompt:'v2',birthMinChars:1,birthMinSavedChars:1,birthTokenGate:false,traceReadbackHashes:true})
    const deps={cfg,sessionId:'fixture-host',trace:(tag,data)=>events.push({tag,data}),archive:async()=> 'art:fixture:handle',distill:async()=>({ok:true,text:draft,meta:{}})}
    const task=birthStart({index:0,text:raw,end:{type:'block-end',index:0,block:{type:'reasoning',text:raw}}},deps)
    const settled=await birthFinish(task,deps);assert.equal(settled.why,'condensed')
    const block=settled.chunks.find((c)=>c.type==='block-end').block
    assert.equal(block.text,draft)
    const body={model:'fixture',messages:[{role:'assistant',content:[block]}]}
    const observed=streamProvenanceRecord({n:2,options:body,session:null,sessionId:'fixture-host',readbackHashes:true})
    events.push({tag:'llm-stream',data:observed})
    const report=auditReadback(events);assert.equal(report.placements.length,1);assert.equal(report.placements[0].status,'hook-only-not-wire-proof');assert.equal(report.liveHostVerified,false)
  })
  await test('provider serialization dropping reasoning is detected despite a matching host hook', () => {
    const r=control.report.readbackFixtureAudit
    assert.equal(r.placements[2].laterHookDigestMatches,1);assert.equal(r.placements[2].laterTransportDigestMatches,0)
    assert.equal(r.liveHostVerified,false);assert.equal(r.originalReaderEffectVerified,false)
  })
  await test('copied and key-reordered readback observations never invent n', () => {
    const copied=clone(control.bodyEvents[0]);copied.at='later'
    const reversed=Object.fromEntries(Object.entries(copied).reverse())
    const r=auditReadback([...control.bodyEvents,reversed]);assert.equal(r.counts.duplicateObservations,1);assert.equal(r.independentSampleCount,null)
  })
  await test('conflicting birth identity is quarantined rather than first/last wins', () => {
    const changed=clone(control.bodyEvents[0]);changed.draftSha256='b'.repeat(64)
    const r=auditReadback([...control.bodyEvents,changed]);assert.equal(r.ok,false);assert.ok(r.errors.some((e)=>e.includes('conflicting-birth')));assert.equal(r.placements.length,2)
  })
  await test('readback JSONL and trace framing are strict and attributes must be known', () => {
    assert.equal(parseReadbackLog(JSON.stringify(control.bodyEvents[0])+'\n').length,1)
    assert.equal(parseReadbackLog('[2026-10-12T00:00:00Z] [birth-replacement-evidence] '+JSON.stringify(control.bodyEvents[0])+'\n').length,1)
    assert.throws(()=>parseReadbackLog('{broken\n'),/invalid JSON/)
    assert.throws(()=>parseReadbackLog('unstructured line\n'),/invalid trace framing/)
    const r=clone(control.bodyEvents[0]);r.sessionId=null;assert.equal(auditReadback([r]).ok,false)
  })
  await test('flat SFT mapping is exact; prompt and original teacher provenance are distinct', () => {
    const a=annotations[0],r=toFlatSft(a,{repo:'fixture/known-repo',system:'fixture system'})
    assert.deepEqual(Object.keys(r),['id','repo','system','user','assistant'])
    assert.deepEqual(JSON.parse(r.user),{raw:a.raw,ctx:a.ctx});assert.equal(r.assistant,a.referenceDraft)
    assert.throws(()=>toFlatSft(a,{repo:'unknown',system:'fixture'}),/known-repository/)
  })
  await test('JS flat-row identity agrees with the Python trainer without torch/tokenizer', () => {
    const r=toFlatSft(annotations[0],{repo:'fixture/known-repo',system:'fixture system'})
    const script='import json,hashlib,sys;r=json.load(sys.stdin);print(hashlib.sha256(json.dumps([r[k] for k in ["id","repo","system","user","assistant"]],ensure_ascii=False,separators=(",",":")).encode()).hexdigest())'
    const p=spawnSync('python3',['-c',script],{input:JSON.stringify(r),encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),flatRowDigest(r))
  })
  await test('formal export cannot use fully reviewed dev cases as admitted training', () => {
    const r=formal();assert.equal(r.manifest.trainingReady,false);assert.equal(r.groups.train.length,0);assert.equal(r.groups.dev.length,0)
    assert.ok(r.rejected.every((r)=>r.reasons.includes('explicit-training-eligibility-is-false')))
    assert.ok(r.manifest.blockers.includes('resource-budget-not-confirmed'))
  })
  await test('off-target/source/license and repository identity require bound source proof', () => {
    const r=formal();assert.ok(r.rejected.every((r)=>r.reasons.includes('source-model-birth-license-privacy-not-admitted')))
    assert.ok(r.rejected.every((r)=>r.reasons.includes('repository-identity-not-attested')))
  })
  await test('missing complete-review sidecars cannot be bypassed by an eligibility declaration', () => {
    const a=clone(annotations);a[0].trainingEligible=true
    const r=formal({annotations:a,reviews:[]});assert.equal(r.manifest.trainingReady,false);assert.ok(r.rejected[0].reasons.includes('missing complete review sidecar'))
  })
  await test('blind labels are never accepted by the formal SFT entry', () => {
    const a=clone(annotations);a[0].finalSplit='blind'
    assert.ok(formal({annotations:a}).manifest.blockers.includes('blind-labels-not-accepted-by-formal-exporter'))
  })
  await test('formal command exits 2 and writes only a fresh blocked report, not training files', () => {
    const out=path.join(temp,'blocked-export')
    const p=spawnSync(process.execPath,['tools/micro-generator/formal-sft.mjs','--out',out],{cwd:ROOT,encoding:'utf8'});assert.equal(p.status,2,p.stderr)
    assert.deepEqual(fs.readdirSync(out),['formal-preflight.json'])
    const initial=fs.readFileSync(path.join(out,'formal-preflight.json'))
    const again=spawnSync(process.execPath,['tools/micro-generator/formal-sft.mjs','--out',out],{cwd:ROOT,encoding:'utf8'});assert.notEqual(again.status,0);assert.deepEqual(fs.readFileSync(path.join(out,'formal-preflight.json')),initial)
  })
  await test('reader study plan remains blocked without budget, state or served version', () => {
    const p=makeReaderStudyPlan(ROOT);assert.equal(p.cases.length,3);assert.equal(p.expectedMinimumContinuationArms,9);assert.equal(p.requestBudget.maximumPaidRequests,0);assert.equal(p.requestBudget.authorized,false);assert.equal(p.executeImplemented,false)
    assert.ok(p.cases.every((c)=>c.birthStateRef===null))
  })
  await test('all missing reader arms stay in the registered denominator', () => {
    const r=evaluateReaderObservations({plan:makeReaderStudyPlan(ROOT),observations:[]})
    assert.equal(r.denominator,3);assert.equal(r.missing.length,3);assert.ok(r.missing.every((r)=>r.missingArms.length===3));assert.equal(r.status,'not-evaluable');assert.equal(r.promotionAllowed,false)
  })
  await test('fixture outcomes or wrong plan/version cannot certify reader utility', () => {
    const plan=makeReaderStudyPlan(ROOT),c=plan.cases[0]
    const r=evaluateReaderObservations({plan,observations:[{schema:'cfb.reader-continuation-observation/1',caseId:c.caseId,arm:'reference',planSha256:'a'.repeat(64),inputSha256:c.inputSha256,fixtureOnly:true,actualExecution:false,readerModel:plan.receiver,readerVersion:'fixture',callId:'fixture-call'}]})
    assert.equal(r.status,'not-evaluable');assert.equal(r.rejected.length,1);assert.ok(r.rejected[0].reasons.includes('fixture-or-unattested-execution'));assert.equal(r.referenceUtilityVerified,false)
  })
  await test('birth input identity exactly agrees with the retained dataset registry',()=>{
    for(const a of annotations)assert.equal(replacementEvidence({raw:a.raw,ctx:a.ctx,draft:a.referenceDraft}).inputSha256,reviews.find(r=>r.caseId===a.caseId).inputSha256)
  })
  await test('formal producer and Python consumer agree on a temporary complete protocol fixture',()=>{
    const f=makeFormalWireFixture('positive');assert.deepEqual(f.result.errors,[]);assert.deepEqual(f.result.rejected,[]);assert.equal(f.result.manifest.trainingReady,true,JSON.stringify(f.result.manifest.blockers))
    const out=f.export(),p=runPythonPreflight(out);assert.equal(p.status,0,p.stderr+'\n'+p.stdout);assert.equal(JSON.parse(p.stdout).scope,'attached-complete-review-integrity-not-independent-semantic-certification')
    assert.equal(fs.readdirSync(path.join(out,'source-reviews')).length,3)
  })
  await test('declared wire fixture bundles carry every source proof and preflight under the new mount',()=>{
    const f=makeFormalWireFixture('bundle');const out=f.export(),bundle=path.join(f.root,'kaggle-bundle')
    const p=spawnSync('python3',['deploy/kaggle/start-rwkv7.py','--train','--data',path.join(out,'train.jsonl'),'--dev',path.join(out,'dev.jsonl'),'--admission',path.join(out,'admission.json'),'--model-revision','a'.repeat(40),'--bundle-dir',bundle],{cwd:ROOT,encoding:'utf8'})
    assert.equal(p.status,0,p.stderr+'\n'+p.stdout);const receipt=JSON.parse(fs.readFileSync(path.join(bundle,'BUNDLE.json'),'utf8'));assert.equal(receipt.executed,false);assert.equal(receipt.bundlePreflight.completeReviewRows,3);assert.equal(fs.readdirSync(path.join(bundle,'training-data/source-reviews')).length,3)
    assert.ok(!fs.existsSync(path.join(bundle,'code/kernel-metadata.json')))
  })
  await test('complete source-proof files, not just inline claims, must remain hash bound',()=>{
    const f=makeFormalWireFixture('corrupt-proof');const out=f.export(),name=fs.readdirSync(path.join(out,'source-reviews'))[0];fs.appendFileSync(path.join(out,'source-reviews',name),'changed')
    const p=runPythonPreflight(out);assert.notEqual(p.status,0);assert.match(p.stderr,/source-review|binding-drift/)
  })
  await test('prior exposed family stays excluded even for a different input',()=>{
    const f=makeFormalWireFixture('family-exposure');f.args.registry.entries.push({inputSha256:'f'.repeat(64),families:[f.args.annotations[0].family],exposure:['already-exposed-dev'],records:[]})
    const r=buildFormalSft(f.args);assert.equal(r.manifest.trainingReady,false);assert.ok(r.rejected.some(x=>x.reasons.includes('prior-exposed-input-cannot-become-train')))
  })
  await test('extra reviews and empty numerical gates are not a formal passing bundle',()=>{
    const f=makeFormalWireFixture('extra-review');f.args.reviews.push({...clone(f.args.reviews[0]),caseId:'unknown-extra'})
    assert.ok(buildFormalSft(f.args).errors.includes('annotation-review-case-sets-must-match'))
    fs.writeFileSync(path.join(f.root,f.args.evidence.preregistration.path),JSON.stringify({status:'frozen-for-content-and-original-reader-evaluation',promotionThresholds:{}}));f.args.evidence.preregistration.sha256=sha256(fs.readFileSync(path.join(f.root,f.args.evidence.preregistration.path)))
    assert.ok(buildFormalSft(f.args).manifest.blockers.includes('new-thresholds-not-frozen'))
  })
  await test('JS/Python record digests cover exponent, integral float, key ordering and lone surrogate edges',()=>{
    const values=[1e-7,1e-6,1,0,1e20,1e21,1.2e-20,'🧪 中文','\ud800',{'17':'x','2':'y','01':'z'},[null,false,true]]
    const script='import importlib.util,json,sys;s=importlib.util.spec_from_file_location("t","deploy/kaggle/train_rwkv7.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps([m.compact_sha256(v) for v in json.load(sys.stdin)]))'
    const p=spawnSync('python3',['-c',script],{cwd:ROOT,input:JSON.stringify(values),encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.deepEqual(JSON.parse(p.stdout),values.map(digestJson))
  })
  await test('bound initial continuation fixtures are descriptive only, never original-reader certification',()=>{
    const f=makeReaderWireFixture('positive');const r=f.evaluate();assert.deepEqual(r.errors,[]);assert.equal(r.status,'descriptive-development-only');assert.equal(r.complete.length,3);assert.equal(r.acceptedObservationCount,9);assert.equal(r.promotionAllowed,false);assert.equal(r.fullContinuationTrajectoriesVerified,false);assert.equal(r.actualBillingVerified,false)
  })
  await test('key-reordered and timestamp copies cannot inflate reader observation counts',()=>{
    const f=makeReaderWireFixture('duplicate'),copy=Object.fromEntries(Object.entries({...f.observations[0],at:'later'}).reverse()),r=f.evaluate([...f.observations,copy]);assert.equal(r.duplicates.length,1);assert.equal(r.acceptedObservationCount,9);assert.equal(r.independentSampleCount,null)
  })
  await test('reader provider call conflict invalidates BOTH arms, never keeps the first',()=>{
    const f=makeReaderWireFixture('conflict');f.observations[1].callId=f.observations[0].callId
    const r=f.evaluate();assert.equal(r.status,'not-evaluable');assert.equal(r.acceptedObservationCount,7);assert.deepEqual(r.missing[0].missingArms,['raw-a','raw-b'])
  })
  await test('a matching draft elsewhere cannot excuse changing the designated reader slot',()=>{
    const f=makeReaderWireFixture('slot'),row=f.observations[2],request=JSON.parse(fs.readFileSync(path.join(f.root,row.requestRef.path),'utf8'))
    request.messages[1].reasoning_content='wrong reasoning';request.messages.push({role:'assistant',reasoning_content:annotations[0].referenceDraft});row.requestRef=f.write('wrong-slot.json',request)
    const r=f.evaluate();assert.ok(r.rejected[0].reasons.includes('serialized-request-does-not-carry-registered-reasoning-at-birth-slot'));assert.ok(r.rejected[0].reasons.includes('request-modified-beyond-designated-reasoning-slot'))
  })
  await test('unchanged reasoning alone cannot excuse a different task/decoding/tools/version',()=>{
    const f=makeReaderWireFixture('scope'),row=f.observations[0],request=JSON.parse(fs.readFileSync(path.join(f.root,row.requestRef.path),'utf8'))
    request.messages[0].content='different task';request.temperature=1;request.tools=[{type:'function'}];row.requestRef=f.write('wrong-scope.json',request)
    const r=f.evaluate();assert.ok(r.rejected[0].reasons.includes('request-modified-beyond-designated-reasoning-slot'));assert.ok(r.rejected[0].reasons.includes('serialized-request-decoding-mismatch:temperature'));assert.ok(r.rejected[0].reasons.includes('serialized-request-model-or-tools-mismatch'))
  })
  await test('reader plan bindings and scope authorization cannot be changed by rehashing the plan alone',()=>{
    const f=makeReaderWireFixture('approval');const p=clone(f.plan);p.requestBudget.maximumPaidRequests=100;delete p.planSha256;p.planSha256=digestJson(p)
    const r=f.evaluate(f.observations,p);assert.ok(r.errors.includes('plan:budget-approval-not-bound'))
    const corrupt=clone(f.plan);corrupt.cases[0].rawSha256='c'.repeat(64);delete corrupt.planSha256;corrupt.planSha256=digestJson(corrupt)
    assert.ok(f.evaluate([],corrupt).errors.some(e=>e.includes('registered-input-not-bound')))
  })
  await test('outside-root symlink evidence and conflicting terminal outcomes are refused',()=>{
    const f=makeReaderWireFixture('unsafe'),outside=path.join(temp,'outside-reader.json');fs.writeFileSync(outside,'{}');fs.symlinkSync(outside,path.join(f.root,'escape.json'))
    f.observations[0].responseRef={path:'escape.json',sha256:sha256('{}')};assert.ok(f.evaluate().rejected[0].reasons.some(e=>e.includes('unsafe path')))
    const g=makeReaderWireFixture('terminal'),other=clone(g.observations[0]);other.callId='other-fixture';const r=g.evaluate([...g.observations,other]);assert.equal(r.acceptedObservationCount,8);assert.ok(r.rejected.some(x=>x.reasons.includes('multiple-terminal-observations-for-one-arm')))
  })
  await test('off-target source cannot be admitted by flipping version/license Booleans',()=>{
    const f=makeFormalWireFixture('off-target'),ref=f.args.registry.entries[0].sourceAdmission.reviewRef,file=path.join(f.root,ref.path),proof=JSON.parse(fs.readFileSync(file,'utf8'));proof.sourceModel.id='Qwen-unit-off-target';fs.writeFileSync(file,JSON.stringify(proof));ref.sha256=sha256(fs.readFileSync(file))
    assert.ok(buildFormalSft(f.args).rejected[0].reasons.includes('source-model-not-attested-in-initial-target-scope'))
  })
  await test('formal export rechecks input bytes and refuses source symlink escape',()=>{
    const f=makeFormalWireFixture('export-race');f.args.annotations[0].referenceDraft+=' changed'
    assert.throws(()=>writeFormalBundle({...f.args,out:path.join(f.root,'race-output'),result:f.result}),/input-changed-after-preflight/);assert.equal(fs.existsSync(path.join(f.root,'race-output')),false)
    const g=makeFormalWireFixture('proof-escape'),ref=g.args.registry.entries[0].sourceAdmission.reviewRef,outside=path.join(temp,'outside-source-proof.json');fs.copyFileSync(path.join(g.root,ref.path),outside);fs.unlinkSync(path.join(g.root,ref.path));fs.symlinkSync(outside,path.join(g.root,ref.path))
    assert.ok(buildFormalSft(g.args).rejected[0].reasons.some(e=>e.includes('unsafe file')))
  })
  await test('resource-bearing CLIs reject ambiguous abbreviated flags without creating a bundle',()=>{
    const dest=path.join(temp,'abbreviated-bundle'),p=spawnSync('python3',['deploy/kaggle/start-rwkv7.py','--mode','train','--bundle-dir',dest],{cwd:ROOT,encoding:'utf8'});assert.notEqual(p.status,0);assert.match(p.stderr,/unrecognized arguments/);assert.equal(fs.existsSync(dest),false)
  })
  await test('a missing required retained source is not silently called a complete registry',()=>{
    const root=path.join(temp,'missing-source');fs.mkdirSync(root)
    const r=buildSourceRegistry(root,[{path:'missing.jsonl',role:'fixture-required',scope:'existing-dev'}]);assert.ok(r.errors.some(e=>e.includes('required-retained-catalog-source-not-materialized')))
  })
  await test('current programme status is locally consistent, never model ready', () => {
    const r=workStatus(ROOT);assert.equal(r.ok,true);assert.equal(r.readiness.ready,false);assert.equal(r.paidApiCallsByThisCommand,0);assert.equal(r.newBlindConsumedByThisCommand,0)
  })
} finally { fs.rmSync(temp,{recursive:true,force:true}) }
console.log(`PASS=${pass} FAIL=${fail} SKIP=0`)
if(fail) process.exitCode=1
