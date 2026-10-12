#!/usr/bin/env node
// CPU-only: never download a model, install torch, or launch a remote kernel.
import { spawnSync } from 'node:child_process'
let python = null
for (const candidate of ['python3', 'python']) {
  const check = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { encoding: 'utf8' })
  if (check.status === 0) { python = candidate; break }
}
if (!python) {
  console.log('SKIP trainer-contract: requires Python >= 3.10; no GPU verification inferred')
  console.log('PASS=0 FAIL=0 SKIP=1'); process.exit(0)
}
const result = spawnSync(python, ['-B', 'test/trainer-contract.selftest.py'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 4 * 1024 * 1024 })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error || result.status === null) {
  console.error(String(result.error || 'Python process did not exit normally'))
  console.log('PASS=0 FAIL=1 SKIP=0'); process.exit(1)
}
process.exit(result.status)
