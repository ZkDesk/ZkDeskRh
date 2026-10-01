// Invokes a Vercel Function handler locally with .env.local, for testing against the live chain + DB.
// Usage: node scripts/ops/call-api.mjs api/cron/tick.js [GET|POST] [json-body-file] [query-json]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const [file, method = 'GET', bodyFile, query = '{}'] = process.argv.slice(2);
const { default: handler } = await import(pathToFileURL(file).href);
const req = {
  method,
  query: JSON.parse(query),
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  body: bodyFile ? JSON.parse(readFileSync(bodyFile, 'utf8')) : undefined,
};
const res = {
  statusCode: 200, headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  end(body) { console.log(this.statusCode, body); process.exit(0); },
};
await handler(req, res);
