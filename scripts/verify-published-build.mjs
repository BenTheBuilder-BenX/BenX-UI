import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const files = readdirSync('dist/assets').filter(n => n.endsWith('.js'));
const forbidden = ['demo-fra', 'demo-ams', 'demo-seller', 'demo-manager', 'b3f72493-9e4a-4f25-8686-', 'fra.example.com/panel/', 'Sample data · No live servers'];
for (const file of files) {
  const source = readFileSync('dist/assets/' + file, 'utf8');
  for (const value of forbidden) if (source.includes(value)) throw new Error('Published sample fixture found: ' + value);
}
const manifest = JSON.parse(readFileSync('dist/.vite/manifest.json', 'utf8'));
const entry = Object.keys(manifest).find(key => manifest[key].isEntry);
if (!entry) throw new Error('Production entry is missing.');
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  if (!manifest[key]) throw new Error('Missing build dependency: ' + key);
  initial.add(key);
  for (const dependency of manifest[key].imports ?? []) visit(dependency);
}
visit(entry);
let initialBytes = 0, initialGzipBytes = 0;
for (const key of initial) {
  if (/locales\/(fa|ru|zh)\.json|RootApp\.tsx/.test(key)) throw new Error('Workspace or language code loaded before sign-in: ' + key);
  const bytes = readFileSync('dist/' + manifest[key].file);
  initialBytes += bytes.length;
  initialGzipBytes += gzipSync(bytes).length;
}
if (initialGzipBytes > 140000) throw new Error('Initial JavaScript exceeds the 140 KB compressed budget.');
console.log(JSON.stringify({ publishedFixtureCheck: 'passed', javascriptAssets: files.length, initialBytes, initialGzipBytes, initialBudget: 'passed' }));
