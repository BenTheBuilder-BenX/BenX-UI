import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Project migrations use ordinary SQLite statements, without triggers. */
export function splitSQL(source) {
  const result = []; let statement = '', quote = '', comment = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === '--') { if (c === '\n') { comment = ''; statement += '\n'; } continue; }
    if (comment === '/*') { if (c === '*' && next === '/') { comment = ''; i++; statement += ' '; } continue; }
    if (quote) { statement += c; if (c === quote) { if (next === quote) { statement += next; i++; } else quote = ''; } continue; }
    if (c === '-' && next === '-') { comment = '--'; i++; continue; }
    if (c === '/' && next === '*') { comment = '/*'; i++; continue; }
    if (["'", '"', '`', '['].includes(c)) { quote = c === '[' ? ']' : c; statement += c; continue; }
    if (c === ';') { if (statement.trim()) result.push(statement.trim()); statement = ''; } else statement += c;
  }
  if (quote || comment === '/*') throw Error('Unterminated migration string/comment.');
  if (statement.trim()) result.push(statement.trim());
  if (result.some(s => /^(?:CREATE\s+(?:TEMP\s+)?TRIGGER|BEGIN|COMMIT|ROLLBACK)\b/i.test(s))) throw Error('Migration needs a reviewed statement parser before adding triggers or explicit transactions.');
  return result.filter(s => !/^PRAGMA\s+foreign_keys\s*=/i.test(s));
}
export function syncMigrations() {
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const bundle = files.map(name => ({ name, statements: splitSQL(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')) }));
  writeFileSync(new URL('../worker/migration-bundle.json', import.meta.url), JSON.stringify(bundle));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) syncMigrations();
