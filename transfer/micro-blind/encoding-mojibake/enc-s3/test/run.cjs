const path = require('path')
const loader = require(path.join('..', 'src', 'loader.cjs'))
const repair = require(path.join('..', 'src', 'repair.cjs'))
const text = loader.read(path.join(__dirname, '..', 'data', 'sample.txt'))
const repaired = repair.repair(text)
const EXPECTED_EVIDENCE = "cafÃ© naÃ¯ve rÃ©sumÃ©"
const EXPECTED_REPAIRED = "café naïve résumé"
const ok = repaired === EXPECTED_REPAIRED
const bugReproduced = text === EXPECTED_EVIDENCE
const facts = { ok, bugReproduced, loaded: Object.keys(require.cache)
  .map((p) => path.basename(p)).filter((b) => b.endsWith('.cjs')).sort(), observed: text.slice(0, 24) }
process.stdout.write(JSON.stringify(facts))
if (!ok || !bugReproduced) process.exitCode = 1
