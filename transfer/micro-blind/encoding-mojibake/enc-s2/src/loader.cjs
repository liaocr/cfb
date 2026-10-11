const fs = require('fs')
exports.read = (p) => fs.readFileSync(p, 'latin1')
