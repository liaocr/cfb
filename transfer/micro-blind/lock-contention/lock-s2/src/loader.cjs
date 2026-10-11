const fs = require('fs')
exports.read = (p) => { const st = JSON.parse(fs.readFileSync(p, 'utf8'))
  return st.busy ? 'lock wait timeout after ' + (st.tries || 0) + ' retries' : 'lock acquired' }
