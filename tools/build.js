// Developer build step (not shipped to anyone): bundles the tested modules into one
// Apps Script file. Order matters: each module only uses the ones before it.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

const ORDER = [
  'src/rules/calendar.js', 'src/rules/clash.js', 'src/rules/leave.js', 'src/rules/minutes.js',
  'src/server/schema.js', 'src/server/cachegrid.js', 'src/server/store.js', 'src/server/core.js', 'src/server/attendance.js', 'src/server/admin.js', 'src/server/views.js', 'src/server/jobs.js', 'src/server/api.js',
  'src/gas/main.js',
];

const version = require(path.join(root, 'package.json')).version;
let out = `// GJ Leave & Attendance - server bundle v${version}\n// GENERATED FILE. Do not edit here. Edit src/ and run: node tools/build.js\n`;
for (const file of ORDER) {
  out += `\n// ===== ${file} =====\n` + fs.readFileSync(path.join(root, file), 'utf8');
}
fs.mkdirSync(path.join(root, 'apps-script'), { recursive: true });
fs.writeFileSync(path.join(root, 'apps-script', 'Code.js'), out);
fs.writeFileSync(path.join(root, 'apps-script', 'appsscript.json'), JSON.stringify({
  timeZone: 'Asia/Kolkata', exceptionLogging: 'STACKDRIVER', runtimeVersion: 'V8',
  webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' },
}, null, 2) + '\n');
console.log('Built apps-script/Code.js (' + out.length + ' bytes)');

// Demo server for the browser: the SAME rule and server modules, on sample data in memory.
// Used only when docs/config.js has no API_URL. Nothing is saved anywhere.
let mock = '// GENERATED FILE. Demo mode only: the real server modules running in the browser on sample data.\n';
for (const file of ORDER.filter(f => !f.startsWith('src/gas/'))) mock += `\n// ===== ${file} =====\n` + fs.readFileSync(path.join(root, file), 'utf8');
mock += '\n' + fs.readFileSync(path.join(root, 'tools', 'mock-boot.js'), 'utf8');
fs.writeFileSync(path.join(root, 'docs', 'mock-server.js'), mock);
console.log('Built docs/mock-server.js (' + mock.length + ' bytes)');

// Fresh files after every release: each script and style address in index.html carries the hash of its content.
(function stampIndex() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const docs = path.join(__dirname, '..', 'docs'), file = path.join(docs, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const out = html.replace(/(src|href)="([a-z-]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g, (m, attr, name) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(docs, name))).digest('hex').slice(0, 10);
    return attr + '="' + name + '?v=' + hash + '"';
  });
  if (out !== html) fs.writeFileSync(file, out);
})();
