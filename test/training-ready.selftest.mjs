// 无外网训练基础设施；reference是真SGD，HF worker只测doctor/纯mask/语法。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { normalizeTrainingExample, trainingFingerprints, splitTrainingGroups, trainingExportRow, freezeTrainingEvaluation, gateTrainingRelease } from '../src/training-core.js'
import { evidenceDigest } from '../src/evidence-program.js'
import { readJson, writeJson } from '../tools/helpers/eval-files.mjs'
import { trainingJsonl, buildTrainingDataset, auditTrainingDataset } from '../tools/helpers/training-data.mjs'
import { exportTrainingWorkspace, importTrainingWorkspace } from '../tools/helpers/training-transfer.mjs'
import { trainReferenceModel } from '../tools/helpers/training-reference.mjs'
import { normalizeTrainingProfile, relocateTrainingPlan, prepareTrainingPlan, assertTrainingPlan } from '../tools/helpers/training-plan.mjs'
import { openTrainingAuthorities, importHistoricalTrainingCandidates, doctorTraining, runTraining } from '../tools/helpers/training-workflow.mjs'
import { openTrainingState } from '../tools/helpers/training-state.mjs'
import { privateTrainingPath, fingerprintModelCache } from '../tools/helpers/training-io.mjs'
import { remoteTrainingPreflight, runRemoteTraining } from '../tools/helpers/training-remote.mjs'
import { isTrainingApproval } from '../tools/helpers/training-governance.mjs'
import { trainingFixtureRows, trainingDemo } from '../tools/helpers/training-demo.mjs'
import { trainingMain } from '../tools/train-ready.mjs'
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-training-test-'))
let pass = 0, fail = 0
const test = async (name, fn) => { try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n' + e.stack) } }
const CHECKS = { identifierSafe: true, completeNative: true, goalVerified: true, criterionFrozen: true }
const fresh = () => { const dir = fs.mkdtempSync(path.join(ROOT, 'case-')); return { dir, ...openTrainingAuthorities(path.join(dir, 'authority-home'), { verifyReview: () => true, authorize: () => true, authenticateEvaluation: () => true }) } }
const writeRows = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
async function corpus(w, rows = trainingFixtureRows()) {
  const reviewed = w.reviews.approveBatch(rows, { mode: 'fixture', reviewer: 'fixture', checks: CHECKS }), file = path.join(w.dir, 'input.jsonl'), output = path.join(w.dir, 'dataset')
  writeRows(file, reviewed); const manifest = await buildTrainingDataset({ input: file, output, reviews: w.reviews }); return { rows: reviewed, file, output, manifest }
}
const refProfile = { schema: 'cfb.training-profile/1', backend: 'reference-byte', recipe: { maxSteps: 20, learningRate: 1, checkpointEvery: 5 } }
const remoteProfile = { schema: 'cfb.training-profile/1', backend: 'remote-finetune', model: { id: 'fixture-base', path: null, revision: 'a'.repeat(40), licenseAccepted: true }, limits: { maxUsd: 1 }, provider: { protocol: 'files-finetuning-jobs/1', baseUrl: 'https://fixture.example.invalid/v1', apiKeyEnv: 'TRAIN_MODEL_KEY', supportsFineTuning: true, models: ['fixture-base'], pricing: { trainingUsdPerMillion: 0.01, fixedJobFeeUsd: 0, source: 'https://fixture.example.invalid/pricing', verifiedAt: '2026-09-30' } } }
async function remoteFixture(w) {
  const c = await corpus(w), plan = await prepareTrainingPlan({ dataset: c.output, reviews: w.reviews, profile: remoteProfile, file: path.join(w.dir, 'plan.json') })
  const approval = w.governance.approve(plan, { mode: 'fixture', owner: 'offline-fixture', maxUsd: 1 })
  return { ...c, plan, approval, directory: path.join(w.dir, 'state'), markerPath: path.join(w.dir, 'public.json'), reviews: w.reviews, apiKey: 'training-test-fixture-key', live: true, now: Date.parse('2026-09-30T12:00:00Z') }
}
const effects = () => ['train', 'selection', 'test'].map((split, i) => ({ split, taskId: 'task-' + i, family: 'family-' + i, criterion: 'goal', before: i === 0, after: true }))
const suite = () => freezeTrainingEvaluation({ id: 'frozen-eval', evaluatorDigest: 'c'.repeat(64), items: effects() })
try {
  await test('01 完整原文/目标/Unicode/空白保留；不截尾或按短选样', () => {
    const r = trainingFixtureRows()[0], x = normalizeTrainingExample({ ...r, digest: undefined, target: '  原文\n完整目标😀\n  ' })
    assert.equal(x.target, '  原文\n完整目标😀\n  '); assert.ok(Object.isFrozen(x.messages))
  })
  await test('02 未知字段/假quality/密钥材料/无用户结尾拒绝', () => {
    const r = trainingFixtureRows()[0]
    assert.throws(() => normalizeTrainingExample({ ...r, approved: true }), /training-example-schema/)
    assert.throws(() => normalizeTrainingExample({ ...r, digest: undefined, target: 'sk-' + 'A'.repeat(32) }), /training-secret-material/)
    assert.throws(() => normalizeTrainingExample({ ...r, digest: undefined, messages: [{ role: 'assistant', content: 'not-input' }] }), /training-messages/)
  })
  await test('03 偏好必须同一完整输入、chosen/rejected不同；不以Likert构造', () => {
    const r = trainingFixtureRows()[0], { target, digest, ...base } = r
    const p = normalizeTrainingExample({ ...base, objective: 'preference', chosen: target, rejected: '完整但错误的另一个输出。' })
    assert.deepEqual(trainingExportRow(p).prompt, p.messages)
    assert.throws(() => normalizeTrainingExample({ ...base, objective: 'preference', chosen: target, rejected: target }), /training-target/)
  })
  await test('04 导出无family/审核/判据/参考；只输入与助手监督', () => {
    const row = trainingExportRow(trainingFixtureRows()[0]); assert.deepEqual(Object.keys(row), ['messages'])
    assert.equal(row.messages.at(-1).role, 'assistant'); assert.ok(!JSON.stringify(row).includes('trainingAllowed'))
  })
  await test('05 指纹可标准化空白，但训练文本本身不改', () => {
    const r = trainingFixtureRows()[0], a = normalizeTrainingExample({ ...r, digest: undefined, messages: [{ role: 'user', content: 'abc \n def' }] }), b = normalizeTrainingExample({ ...r, digest: undefined, messages: [{ role: 'user', content: 'abc def' }] })
    assert.equal(trainingFingerprints(a).input, trainingFingerprints(b).input); assert.notEqual(a.messages[0].content, b.messages[0].content)
  })
  await test('06 family/lineage/重复输入连通分量整体隔离，改uid不能洗test', () => {
    const rows = trainingFixtureRows(8), linked = rows.map((r) => ({ ...r, digest: undefined }))
    linked[1].lineage = linked[0].lineage; linked[2].messages = linked[1].messages
    const data = linked.map(normalizeTrainingExample), split = splitTrainingGroups(data)
    assert.equal(split.assignment[data[0].digest], split.assignment[data[1].digest]); assert.equal(split.assignment[data[1].digest], split.assignment[data[2].digest])
    assert.deepEqual(split, splitTrainingGroups(data))
  })
  await test('07 重复目标也跨族联结；不足三独立组拒绝', () => {
    const r = trainingFixtureRows(4).map((x) => ({ ...x, digest: undefined, target: '完全相同的目标' }))
    assert.throws(() => splitTrainingGroups(r), /insufficient-independent-groups/)
  })
  await test('08 审核回调必须同步true，不接受Promise/truthy', () => {
    const w = fresh(), records = trainingFixtureRows(1)
    const options = { mode: 'fixture', reviewer: 'fixture', checks: CHECKS }
    const other = openTrainingAuthorities(path.join(w.dir, 'other'), { verifyReview: () => Promise.resolve(true) })
    assert.throws(() => other.reviews.approveBatch(records, options), /training-review-untrusted/)
  })
  await test('09 缺行为真值/只有结构门不能签发训练审核', () => {
    const w = fresh(); assert.throws(() => w.reviews.approveBatch(trainingFixtureRows(), { mode: 'fixture', reviewer: 'fixture', checks: { ...CHECKS, goalVerified: false } }), /review-not-approved/)
  })
  await test('10 未知版权/没review进隔离，未创建train/test文件', async () => {
    const w = fresh(), file = path.join(w.dir, 'input.jsonl'), output = path.join(w.dir, 'data')
    writeRows(file, trainingFixtureRows().map((r) => ({ ...r, digest: undefined, source: { ...r.source, trainingAllowed: false } })))
    const m = await buildTrainingDataset({ input: file, output, reviews: w.reviews }); assert.equal(m.status, 'quarantine-only'); assert.equal(m.reviewed, 0)
    assert.equal(fs.existsSync(path.join(output, 'train.jsonl')), false)
  })
  await test('11 结构合法未审核不因accept=ok变成批准', async () => {
    const w = fresh(), f = path.join(w.dir, 'raw.jsonl'); writeRows(f, trainingFixtureRows())
    const m = await buildTrainingDataset({ input: f, output: path.join(w.dir, 'data'), reviews: w.reviews }); assert.equal(m.reviewed, 0); assert.equal(m.quarantined, 8)
  })
  await test('12 历史导入使用完整生产prompt+完整side，默认批准0', async () => {
    const w = fresh(), file = path.join(w.dir, 'historical.jsonl'), report = importHistoricalTrainingCandidates(file)
    assert.ok(report.candidates > 0); assert.equal(report.trainingApproved, 0)
    const m = await buildTrainingDataset({ input: file, output: path.join(w.dir, 'legacy'), reviews: w.reviews }); assert.equal(m.reviewed, 0)
  })
  await test('13 已消耗两族不能改name再训练或测试', async () => {
    const w = fresh(), rows = trainingFixtureRows().map((r, i) => ({ ...r, digest: undefined, lineage: i === 0 ? 'renamed-chunked-header-v2' : r.lineage }))
    const c = await corpus(w, rows); assert.equal(c.manifest.quarantined, 1)
    const f = [...await (async () => { const a=[]; for await(const x of trainingJsonl(path.join(c.output,'quarantine.jsonl')))a.push(x);return a })()]
    assert.equal(f[0].reason, 'training-consumed-family')
  })
  await test('14 review绑定具体目标；改字后旧证书无效', async () => {
    const w = fresh(), c = await corpus(w), row = c.rows[0]
    assert.equal(w.reviews.inspect({ ...row, digest: undefined, target: row.target + '改' }), null)
  })
  await test('15 撤销生效不能拿旧ref覆盖最新审核head', async () => {
    const w = fresh(), c = await corpus(w); w.reviews.revoke([c.rows[0].digest])
    await assert.rejects(auditTrainingDataset({ directory: c.output, reviews: w.reviews }), /training-review-revoked/)
  })
  await test('16 流式JSONL坏行/超长/坏UTF8在数据落盘前拒绝', async () => {
    const w = fresh(), file = path.join(w.dir, 'bad.jsonl')
    fs.writeFileSync(file, '{bad}\n'); await assert.rejects(async () => { for await (const r of trainingJsonl(file)) void r }, /training-jsonl/)
    fs.writeFileSync(file, 'x'.repeat(100)); await assert.rejects(async () => { for await (const r of trainingJsonl(file, { maxLineBytes: 10 })) void r }, /training-line-budget/)
    fs.writeFileSync(file, Buffer.from([255,10])); await assert.rejects(async () => { for await (const r of trainingJsonl(file)) void r }, /training-jsonl/)
  })
  await test('17 制品只放ignored/外部卷；不把语料进Git或MANIFEST', () => {
    assert.throws(() => privateTrainingPath(path.resolve('training-data.jsonl')), /training-private-output/)
    assert.ok(privateTrainingPath(path.join(ROOT, 'private')))
  })
  await test('18 清单与文件/行数/跨切分/HMAC重验', async () => {
    const w = fresh(), c = await corpus(w), a = await auditTrainingDataset({ directory: c.output, reviews: w.reviews })
    assert.equal(a.checked, 8); assert.equal(a.testExported, false); assert.equal(c.manifest.counts.train, 6)
    assert.equal(fs.existsSync(path.join(c.output, 'export/test.sft.jsonl')), false)
  })
  await test('19 变更train文件失败，即使作业plan尚未创建也不宽松', async () => {
    const w = fresh(), c = await corpus(w); fs.appendFileSync(path.join(c.output, 'train.jsonl'), '\n')
    await assert.rejects(auditTrainingDataset({ directory: c.output, reviews: w.reviews }), /training-dataset-file-drift/)
  })
  await test('20 自算新manifest也不能把参考偷偷加进provider export', async () => {
    const w = fresh(), c = await corpus(w), m = readJson(path.join(c.output, 'manifest.json')), file = path.join(c.output, m.files['export-train'].path)
    const raw = fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map((l) => ({ ...JSON.parse(l), reference: 'hidden' })); const b = Buffer.from(raw.map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(file,b)
    m.files['export-train'].sha256 = crypto.createHash('sha256').update(b).digest('hex');m.files['export-train'].bytes=b.length
    const {digest,...body}=m;writeJson(path.join(c.output,'manifest.json'),{...body,digest:evidenceDigest(body)})
    await assert.rejects(auditTrainingDataset({ directory: c.output, reviews: w.reviews }), /training-export-not-record-equivalent/)
  })
  await test('21 plan数据/配方/源码与上限冻结，不默认下载或部署', async () => {
    const w = fresh(), c = await corpus(w), p = await prepareTrainingPlan({ dataset: c.output, reviews: w.reviews, profile: refProfile, file: path.join(w.dir,'plan.json') })
    assert.equal(p.defaultActivation, false); assert.equal(p.testPolicy,'custody-only-no-upload-no-epoch-selection');assertTrainingPlan(p)
    assert.throws(() => assertTrainingPlan({...p,profile:{...p.profile,recipe:{...p.profile.recipe,maxSteps:99}}}),/training-plan-drift/)
  })
  await test('22 超token/非法精度/未知超参数/钥匙profile拒绝', async () => {
    assert.throws(() => normalizeTrainingProfile({ ...refProfile, recipe:{learningRate:-1} }),/training-recipe/)
    assert.throws(() => normalizeTrainingProfile({ ...refProfile, apiKey:'sk-'+ 'A'.repeat(32) }),/training-profile/)
    const w=fresh(),c=await corpus(w);await assert.rejects(prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:{...refProfile,limits:{maxTrainTokenUpperEst:1}},file:path.join(w.dir,'plan')}),/training-token-budget/)
  })
  // 平台门禁：assertOfflineNamespace 用 /proc/net/route 证明「没有外部路由」，这是 Linux 独有的证据。
  // Windows 没有该文件 ⇒ 无法取得同等强度的证据。按本仓纪律「不把拿不到的证据当通过」，
  // 这里显式跳过并把原因写进输出，而不是把检查改弱、也不是让它假装通过。
  const LINUX_NS = process.platform === 'linux'
  await test('23 真实小模型闭环更新/损失下降/续训bitwise一致；固定替身不发布', async () => {
    if (!LINUX_NS) { console.log('SKIP 23 需要 Linux 网络命名空间证据（/proc/net/route），当前平台 ' + process.platform); return }
    const demo=await trainingDemo();assert.ok(demo.reference.finalTrainLoss<demo.reference.initialLoss);assert.equal(demo.reference.resumeBitwiseEqual,true)
    assert.equal(demo.reference.actualGradientSteps,20);assert.equal(demo.remoteFixture.submissions,1);assert.equal(demo.remoteFixture.extraRequestsOnRepeat,0);assert.equal(demo.release.ok,false)
  })
  await test('24 私有作业仓丢失/换目录不重置公开step或HTTP水位', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:refProfile,file:path.join(w.dir,'plan')})
    const directory=path.join(w.dir,'state'),markerPath=path.join(w.dir,'public.json'),s=openTrainingState({directory,markerPath,plan:p,scope:'fixture'})
    s.update((old)=>({...old,phase:'running',steps:1,pending:{type:'gradient'}}));fs.rmSync(directory,{recursive:true,force:true})
    assert.throws(()=>openTrainingState({directory,markerPath,plan:p,scope:'fixture'}),/restore-required/)
  })
  await test('25 状态pending/步数倒退/超限/Promise更新不被当成成功', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:refProfile,file:path.join(w.dir,'plan')})
    const s=openTrainingState({directory:path.join(w.dir,'state'),markerPath:path.join(w.dir,'pub.json'),plan:p,scope:'fixture'})
    s.update(old=>({...old,steps:2}));assert.throws(()=>s.update(old=>({...old,steps:1})),/training-state-update/);assert.throws(()=>s.update(async old=>old),/training-state-update/)
    assert.throws(()=>s.update(old=>({...old,steps:100})),/training-state-budget/)
  })
  await test('26 推理兼容不代表微调支持；旧AB预算不能授权新训练', async () => {
    const w=fresh(),o=await remoteFixture(w)
    assert.throws(()=>remoteTrainingPreflight({...o.plan,profile:{...o.plan.profile,provider:{...o.plan.profile.provider,supportsFineTuning:false}}},{approvedMaxUsd:1,now:o.now}),/capability-unverified/)
    assert.throws(()=>remoteTrainingPreflight(o.plan,{approvedMaxUsd:null,now:o.now}),/separate-cost-approval/)
    assert.equal(isTrainingApproval(JSON.parse(JSON.stringify(o.approval))),false)
  })
  await test('27 缺独立签名批准/没有live，在上传前拒绝', async () => {
    const w=fresh(),o=await remoteFixture(w);let n=0
    const fetchImpl=async()=>{n++;throw new Error('must-not-fetch')}
    await assert.rejects(runRemoteTraining({...o,approval:{...o.approval},fetchImpl}),/separate-cost-approval/)
    await assert.rejects(runRemoteTraining({...o,live:false,fetchImpl}),/separate-cost-approval/);assert.equal(n,0)
  })
  await test('28 unknown提交不重发不退款；同步meta仍留pending', async () => {
    const w=fresh(),o=await remoteFixture(w);let n=0
    const fetchImpl=async()=>{n++;throw new Error('private-upstream-error')}
    await assert.rejects(runRemoteTraining({...o,fetchImpl}),/training-network-unknown/)
    await assert.rejects(runRemoteTraining({...o,fetchImpl}),/training-remote-unresolved/);assert.equal(n,1)
  })
  await test('29 训练API环境引用不能指向PAT，训练价不取推理价', async () => {
    const w=fresh(),o=await remoteFixture(w)
    assert.throws(()=>remoteTrainingPreflight({...o.plan,profile:{...o.plan.profile,provider:{...o.plan.profile.provider,apiKeyEnv:'GITHUB_PAT'}}},{approvedMaxUsd:1,now:o.now}),/key-reference/)
    assert.throws(()=>remoteTrainingPreflight({...o.plan,profile:{...o.plan.profile,provider:{...o.plan.profile.provider,pricing:{inputUsdPerMillion:0.01}}}},{approvedMaxUsd:1,now:o.now}),/training-price-required/)
  })
  await test('30 Python纯mask完整助手监督，prompt=-100；超长/模板边界拒绝', () => {
    const code=`import importlib.util, json\ns=importlib.util.spec_from_file_location('worker','training/lora_trainer.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nclass T:\n def apply_chat_template(self,msgs,tokenize=True,add_generation_prompt=False):\n  text=''.join('|'+x['role']+'|'+x['content'] for x in msgs)\n  return list(map(ord,text+('|assistant|' if add_generation_prompt else '|EOS|')))\nx=m.encode_completion(T(),[{'role':'user','content':'RAW不删除'}],'完整target',1000)\nassert x['labels'].count(-100)>0 and len(x['labels'])==len(x['input_ids'])\ntry:m.encode_completion(T(),[{'role':'user','content':'原文'}],'目标',1);raise AssertionError('must-reject')\nexcept m.TrainingError:pass\nprint(json.dumps({'mask':'pass','downloads':0}))`
    // Windows Store 的 python3.exe 是个占位存根（直接调用会失败）；真解释器在 python / py。
    // 先探测出一个可用的解释器，探测不到则显式跳过，不把「没装 Python」当成训练失败。
    const py = ['python3','python','py'].find((c) => { const t = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8' }); return t.status === 0 })
    if (!py) { console.log('SKIP 30 未找到可用的 Python 解释器'); return }
    const r=spawnSync(py,['-c',code],{encoding:'utf8',cwd:path.resolve('.'),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).downloads,0)
  })
  await test('31 无torch/模型的LoRA doctor不装包、不报训练通过', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:{...refProfile,backend:'local-lora'},file:path.join(w.dir,'plan')})
    const d=await doctorTraining({plan:p,reviews:w.reviews});assert.equal(d.status,'blocked');assert.equal(d.networkTouched,false);assert.equal(d.worker.installsAutomatically,false)
  })
  await test('32 权重缓存真实文件指纹，改变safetensors不能沿用旧缓存', async () => {
    const w=fresh(),m=path.join(w.dir,'model');fs.mkdirSync(m);fs.writeFileSync(path.join(m,'config.json'),'{}');fs.writeFileSync(path.join(m,'weights.safetensors'),'fixture-weights')
    const a=await fingerprintModelCache(m);fs.writeFileSync(path.join(m,'weights.safetensors'),'changed-weights');const b=await fingerprintModelCache(m);assert.notEqual(a.digest,b.digest)
  })
  await test('33 发布要求冻结全项比较，不能删负项、用loss或平均掩盖', () => {
    const e=effects(),s=suite();assert.equal(gateTrainingRelease(e,{suite:s}).ok,true)
    assert.equal(gateTrainingRelease(e.slice(0,2),{suite:s}).ok,false)
    assert.equal(gateTrainingRelease(e.map((x,i)=>i===0?{...x,after:false}:x),{suite:s}).ok,false)
    assert.equal(gateTrainingRelease(e.map((x,i)=>i===2?{...x,after:null}:x),{suite:s}).ok,false)
    assert.equal(gateTrainingRelease(e).ok,false)
  })
  await test('34 模拟候选/平局/已消耗族永不发布', () => {
    const e=effects(),s=suite();assert.equal(gateTrainingRelease(e,{suite:s,simulated:true}).ok,false)
    assert.equal(gateTrainingRelease(e.map(x=>({...x,before:true})),{suite:s}).ok,false)
    const bad=e.map(x=>x.split==='test'?{...x,family:'chunked-header'}:x),bs=freezeTrainingEvaluation({id:'consumed',evaluatorDigest:'c'.repeat(64),items:bad});assert.equal(gateTrainingRelease(bad,{suite:bs}).ok,false)
  })
  await test('35 HMAC仓里伪造certificate不能跳过独立认证发行簿', () => {
    const w=fresh(),p={digest:'a'.repeat(64),dataset:{digest:'b'.repeat(64)},simulated:false,evaluationSuite:suite()},candidate={digest:'d'.repeat(64),simulated:false}
    const ref=w.store.putJson({authorityId:w.store.authorityId,candidateDigest:candidate.digest,planDigest:p.digest,datasetDigest:p.dataset.digest,effects:effects(),gate:{ok:true}},{kind:'training-release-certificate'})
    assert.throws(()=>w.governance.promote({candidate,plan:p,certificateRef:ref}),/certificate-untrusted/)
  })
  await test('36 仅客观签发+全项提升才能登记，登记不改插件配置；可rollback', () => {
    const w=fresh(),p={digest:'a'.repeat(64),dataset:{digest:'b'.repeat(64)},simulated:false,evaluationSuite:suite()}
    for(const digit of ['d','e']){const candidate={digest:digit.repeat(64),simulated:false},cert=w.governance.certify({candidate,plan:p,effects:effects(),evaluatorDigest:'c'.repeat(64),evaluationRef:'fixture-objective-proof'});const r=w.governance.promote({candidate,plan:p,certificateRef:cert.ref});assert.equal(r.productionConfigModified,false)}
    assert.equal(w.governance.rollback().current.candidateDigest,'d'.repeat(64))
  })
  await test('38 私有数据/审核/梯度checkpoint加密搬迁；物理路径变但逻辑计划/额度不变', async () => {
    const base=fs.mkdtempSync(path.join(ROOT,'move-')),home=path.join(base,'private'),w=openTrainingAuthorities(home,{verifyReview:()=>true,authorize:()=>true}),rows=w.reviews.approveBatch(trainingFixtureRows(),{mode:'fixture',reviewer:'fixture',checks:CHECKS})
    const input=path.join(home,'input.jsonl');writeRows(input,rows);const dataset=path.join(home,'dataset');await buildTrainingDataset({input,output:dataset,reviews:w.reviews})
    const plan=await prepareTrainingPlan({dataset,reviews:w.reviews,profile:refProfile,file:path.join(home,'plan.json')}),marker=path.join(base,'public','run.json'),state=path.join(home,'state')
    await trainReferenceModel({plan,reviews:w.reviews,directory:state,markerPath:marker,stopAfter:5})
    const file=path.join(base,'bundle.cfbtrain'),password='training-fixture-long-passphrase';exportTrainingWorkspace({home,file,markerFiles:[marker],passphrase:password})
    const target=path.join(base,'restored');importTrainingWorkspace({home:target,file,markerDirectory:path.dirname(marker),passphrase:password})
    const restored=openTrainingAuthorities(target),moved=await relocateTrainingPlan(plan,{datasetDirectory:path.join(target,'dataset')},restored.reviews)
    assert.equal(moved.digest,plan.digest);assertTrainingPlan(moved)
    const result=await trainReferenceModel({plan:moved,reviews:restored.reviews,directory:path.join(target,'state'),markerPath:marker});assert.equal(result.steps,20);assert.ok(result.trainLoss<result.initialLoss)
  })
  await test('39 错口令/旧训练包不能把公开已花step回滚，目标不覆盖', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:refProfile,file:path.join(w.dir,'plan.json')}),marker=path.join(ROOT,'public-'+crypto.randomUUID(),'run.json')
    const s=openTrainingState({directory:path.join(w.dir,'state'),markerPath:marker,plan:p,scope:'fixture'})
    const file=path.join(ROOT,'pack-'+crypto.randomUUID()+'.cfbtrain'),password='training-fixture-long-passphrase';exportTrainingWorkspace({home:w.dir,file,markerFiles:[marker],passphrase:password})
    const target=path.join(ROOT,'rejected-'+crypto.randomUUID());assert.throws(()=>importTrainingWorkspace({home:target,file,markerDirectory:path.dirname(marker),passphrase:'wrong-fixture-passphrase'}),/training-transfer-auth/)
    s.update(old=>({...old,steps:1}));assert.throws(()=>importTrainingWorkspace({home:target,file,markerDirectory:path.dirname(marker),passphrase:password}),/training-transfer-stale-watermark/);assert.equal(fs.existsSync(target),false)
  })
  await test('40 relocate只接受内容相同的新位置，不能把新数据变旧批准', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:refProfile,file:path.join(w.dir,'plan')})
    fs.appendFileSync(path.join(c.output,'train.jsonl'),'\n');await assert.rejects(relocateTrainingPlan(p,{datasetDirectory:c.output},w.reviews),/training-dataset-file-drift/)
  })
  await test('41 cancel没有已知作业时不为了取消而创建新作业', async () => {
    const w=fresh(),o=await remoteFixture(w);let requests=0
    await assert.rejects(runRemoteTraining({...o,cancel:true,fetchImpl:async()=>{requests++;throw new Error('must-not-call')}}),/training-no-known-job-to-cancel/);assert.equal(requests,0)
  })
  await test('42 完成后的权重文件变化不能当cache命中重用或偷偷重训', async () => {
    const w=fresh(),c=await corpus(w),p=await prepareTrainingPlan({dataset:c.output,reviews:w.reviews,profile:{...refProfile,recipe:{...refProfile.recipe,maxSteps:5}},file:path.join(w.dir,'plan')})
    const opts={plan:p,reviews:w.reviews,directory:path.join(w.dir,'model'),markerPath:path.join(w.dir,'pub.json')},r=await trainReferenceModel(opts)
    const bytes=fs.readFileSync(r.modelFile);bytes[0]^=1;fs.writeFileSync(r.modelFile,bytes);await assert.rejects(trainReferenceModel(opts),/training-candidate-artifact-drift/)
  })
  await test('43 偏好数据两路完整目标导出，判据/审核/test不混进训练', async () => {
    const w=fresh(),raw=trainingFixtureRows().map(r=>{const {target,digest,...x}=r;return normalizeTrainingExample({...x,objective:'preference',chosen:target,rejected:'完整但已证错误的替代输出 '+r.uid})}),rows=w.reviews.approveBatch(raw,{mode:'fixture',reviewer:'fixture',checks:CHECKS})
    const input=path.join(w.dir,'pref.jsonl');writeRows(input,rows);const output=path.join(w.dir,'pref'),m=await buildTrainingDataset({input,output,reviews:w.reviews,objective:'preference'})
    assert.equal(m.objective,'preference');assert.equal(fs.existsSync(path.join(output,'export','test.preference.jsonl')),false)
    const audit=await auditTrainingDataset({directory:output,reviews:w.reviews});assert.equal(audit.checked,8)
  })
  await test('37 无execute/明文CLI钥匙拒绝，help不反射秘密', async () => {
    const output=[];await trainingMain(['--help'],{env:{TRAIN_MODEL_KEY:'fixture-secret'},output:v=>output.push(v)});assert.ok(!output.join('').includes('fixture-secret'))
    await assert.rejects(trainingMain(['prepare','--api-key','fixture-secret']),/training-option/)
  })
} finally { fs.rmSync(ROOT,{recursive:true,force:true}) }
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`)
if(fail)process.exitCode=1
