// Stand-in for kubectl-radar in tests: serves / and radar's connection API on -port.
// FAKE_RADAR_STATE / FAKE_RADAR_ERROR_TYPE set the reported state; FAKE_RADAR_EXIT=1 exits right away;
// POST /api/connection/retry appends a line to FAKE_RADAR_RETRY_LOG.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

if (process.env.FAKE_RADAR_EXIT === '1') {
  console.error('fake radar: exiting as asked');
  process.exit(3);
}
const port = Number(process.argv[process.argv.indexOf('-port') + 1]);
createServer((req, res) => {
  if (req.url?.startsWith('/api/connection/retry') && req.method === 'POST') {
    if (process.env.FAKE_RADAR_RETRY_LOG) appendFileSync(process.env.FAKE_RADAR_RETRY_LOG, 'retry\n');
    res.writeHead(200).end('{}');
    return;
  }
  if (req.url?.startsWith('/api/connection')) {
    const state = process.env.FAKE_RADAR_STATE ?? 'connected';
    const body = state === 'connected' ? { state } : { state, errorType: process.env.FAKE_RADAR_ERROR_TYPE, error: 'the server has asked for the client to provide credentials' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<html>fake radar</html>');
}).listen(port, '127.0.0.1');
