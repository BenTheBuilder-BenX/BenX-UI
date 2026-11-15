import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function deployButton(repository) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || !['github.com', 'gitlab.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname)) throw Error('Use the actual public GitHub/GitLab repository URL without credentials or query parameters.');
  const source = url.origin + url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  return { source, markdown: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(source)})` };
}
export function setRepository(repository, cwd = process.cwd()) {
  const button = deployButton(repository), path = resolve(cwd, 'README.md');
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  pkg.repository = { type: 'git', url: button.source + '.git' };
  let readme = readFileSync(path, 'utf8');
  const block = `<!-- BENX_DEPLOY_BUTTON -->\n${button.markdown}\n<!-- /BENX_DEPLOY_BUTTON -->`;
  readme = readme.includes('<!-- BENX_DEPLOY_BUTTON -->') ? readme.replace(/<!-- BENX_DEPLOY_BUTTON -->[\s\S]*?<!-- \/BENX_DEPLOY_BUTTON -->/, block) : readme.replace(/^(# .+\n)/, '$1\n' + block + '\n');
  writeFileSync(path, readme); writeFileSync(resolve(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return button.source;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) { try { if (process.argv.length !== 3) throw Error('Usage: npm run release:repository -- https://github.com/OWNER/REPOSITORY'); console.log('Prepared Deploy button for ' + setRepository(process.argv[2]) + '. No repository or deployment was created.'); } catch (e) { console.error(e.message); process.exitCode = 1; } }
