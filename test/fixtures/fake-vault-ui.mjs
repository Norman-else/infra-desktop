// Stand-in for `python -m vault_mcp.web_ui` in tests: same flags, ready line, /api/health and /api/login.
// FAKE_VAULT_STATE sets the health ("authenticated" / "unauthenticated" / "error");
// FAKE_VAULT_LOGIN_FIXES=1 makes POST /api/login switch it to "authenticated";
// requests are appended to FAKE_VAULT_LOG.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const port = Number(arg('--port'));
const env = arg('--env');
let state = process.env.FAKE_VAULT_STATE ?? 'authenticated';
const log = (line) => process.env.FAKE_VAULT_LOG && appendFileSync(process.env.FAKE_VAULT_LOG, line + '\n');

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    log(`${req.method} ${req.url} ${body}`.trim());
    if (req.url === '/api/health') {
      const out = { environment: env, vault: state, ...(state === 'error' ? { message: 'boom' } : {}) };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } else if (req.url === '/api/login' && req.method === 'POST') {
      if (process.env.FAKE_VAULT_LOGIN_FIXES === '1') state = 'authenticated';
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}');
    } else res.writeHead(200, { 'content-type': 'text/html' }).end('<html>fake vault</html>');
  });
});
server.on('error', () => {
  console.error(`Port ${port} is already in use`);
  process.exit(2);
});
server.listen(port, '127.0.0.1', () => console.log(`VAULT_WEB_UI_READY http://127.0.0.1:${port}`));
