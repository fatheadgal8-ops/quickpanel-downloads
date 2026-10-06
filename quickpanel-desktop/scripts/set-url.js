'use strict';
// Usage:  npm run set-url -- https://your-site.example
const fs = require('fs');
const path = require('path');
const url = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^\s/]+[^\s]*$/i.test(url)) {
  console.error('Usage: npm run set-url -- https://your-site.example');
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'app-config.json'), JSON.stringify({ url }, null, 2) + '\n');
console.log('The app will open: ' + url);
