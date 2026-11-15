import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// An explicit source allowlist. Never archive this working directory wholesale.
const root = resolve('.');
const destination = resolve('test-results/release', `benx-ui-${Date.now()}`);
mkdirSync(destination, { recursive: true });
const copy = (file, to = file) => { if (!existsSync(join(root, file))) throw Error(`Missing release input: ${file}`); cpSync(join(root, file), join(destination, to), { recursive: true, filter: source => !lstatSync(source).isSymbolicLink() && !/(?:^|[/\\])(?:__pycache__|node_modules|\.git)(?:[/\\]|$)|\.pyc$/.test(source) }); };
for (const folder of ['src', 'shared', 'worker', 'agent', 'migrations', 'tests', 'relay', '.github']) copy(folder);
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'eslint.config.js', 'index.html', 'worker-configuration.d.ts', 'LICENSE', 'README.md', 'README.fa.md', 'SECURITY.md', '.gitignore', '.gitattributes', '.dev.vars.example', 'wrangler.example.jsonc']) copy(file);
copy('wrangler.example.jsonc', 'wrangler.jsonc');
mkdirSync(join(destination, 'scripts'));
for (const file of ['sync-agent.mjs', 'sync-migrations.mjs', 'deploy.mjs', 'setup-local.mjs', 'set-repository.mjs', 'verify-published-build.mjs', 'prepare-release.mjs', 'build-relay.mjs', 'test-ssh-runtime.mjs', 'test-install-runtime.mjs']) copy('scripts/' + file);
mkdirSync(join(destination, 'docs'));
for (const file of ['easy-install.md', 'guide.fa.md', 'cloudflare.md', 'validation-2026-11-15.md', 'automatic-setup-2026-10-29.md', 'launch-guide.md', 'release-acceptance.md', 'panel-research.md', 'feature-matrix.md', 'gateway-contract.md', 'masterdnsvpn-shared.md', 'subscription-templates.md', 'team-subscriptions-testing.md', 'dns-masterdns-guide.md', 'certificates-tunnels-ai.md', 'universal-panel-2026-10-28.md']) copy('docs/' + file);
// Public assets may include supplied fonts with unverified redistribution rights.
// Use system fallbacks in the source kit until their license is supplied.
mkdirSync(join(destination, 'public'));
for (const file of ['favicon.svg', 'robots.txt', '_headers']) if (existsSync(join(root, 'public', file))) copy('public/' + file);
for (const folder of ['login', 'storefront']) if (existsSync(join(root, 'public', folder))) copy('public/' + folder);
const sourceCss = join(destination, 'src/styles.css');
writeFileSync(sourceCss, readFileSync(sourceCss, 'utf8').replace(/@font-face\{font-family:'Yekan Bakh';[^}]+\}\s*/, ''));
const hashes = [];
const forbidden = new Set();
// Inspect private values in memory only; never print them or add them to the kit.
for (const file of ['.dev.vars', '.env.live-test']) if (existsSync(join(root, file))) {
  for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^[A-Z][A-Z0-9_]*\s*=\s*(.+)$/);
    const value = match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value && value.length >= 16 && !value.startsWith('replace-')) forbidden.add(value);
  }
}
if (existsSync(join(root, 'wrangler.jsonc'))) for (const match of readFileSync(join(root, 'wrangler.jsonc'), 'utf8').matchAll(/"(?:account_id|database_id)"\s*:\s*"([a-f0-9-]{32,36})"/g)) forbidden.add(match[1]);
function walk(path) { for (const entry of readdirSync(path, { withFileTypes: true })) { const target = join(path, entry.name); if (entry.isDirectory()) walk(target); else { let content = readFileSync(target); if (!content.includes(0)) { try { const normalized = new TextDecoder('utf-8', { fatal: true }).decode(content).replaceAll('\r\n', '\n'); const bytes = Buffer.from(normalized); if (!bytes.equals(content)) { writeFileSync(target, bytes); content = bytes; } } catch { /* Preserve non-UTF-8 binary assets verbatim. */ } } for (const value of forbidden) if (content.includes(Buffer.from(value))) throw Error(`Private runtime value or workspace account ID found in release input: ${relative(destination, target)}`); hashes.push(`${createHash('sha256').update(content).digest('hex')}  ${relative(destination, target).replaceAll('\\', '/')}`); } } }
walk(destination);
writeFileSync(join(destination, 'SHA256SUMS'), hashes.sort().join('\n') + '\n');
writeFileSync(join(destination, 'SOURCE-KIT.txt'), 'BenX-UI 0.9 source preview by Ben the Builder. Not a VPS-accepted deployment.\nRead README.md, README.fa.md and docs/release-acceptance.md.\nThe GitHub/Cloudflare flow creates the database and generates private installation keys; the panel initializes its tables automatically.\nNo workspace account IDs, runtime files, SSH relays, live scripts or supplied font binaries are included.\nSource packaging itself does not publish or deploy.\n');
const archive = destination + '.zip';
const result = spawnSync(process.env.PYTHON || 'python', ['-c', 'import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); archive=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [archive.write(p,p.relative_to(root).as_posix()) for p in sorted(root.rglob("*")) if p.is_file()]; archive.close()', destination, archive], { encoding: 'utf8' });
if (result.status !== 0) throw Error('Source folder prepared, but ZIP creation requires Python 3. ' + (result.stderr || ''));
console.log(JSON.stringify({ source: destination, archive, files: hashes.length, published: false }));
