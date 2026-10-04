const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const defaultEngine = path.join(root, 'build', process.platform === 'win32' ? 'economy.exe' : 'economy');

function readCheckpoint(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { tick: '0', household_money: 100, firm_money: 100, inventory: 0, household_stock: 0, household_needs: 2, total_money: 200 }; throw error; }
  const parts = text.trim().split(/\s+/);
  const legacy = parts[0] === 'economy-v1' && parts.length === 5;
  const current = parts[0] === 'economy-v2' && parts.length === 7;
  if ((!legacy && !current) || !parts.slice(1).every(p => /^\d+$/.test(p)))
    throw new Error('Invalid dashboard checkpoint');
  const [, tick, household, firm, inventory, stock = '0', needs = '2'] = parts;
  const snapshot = { tick, household_money: Number(household), firm_money: Number(firm), inventory: Number(inventory), household_stock: Number(stock), household_needs: Number(needs), total_money: Number(household) + Number(firm) };
  if (BigInt(tick) > 9223372036854775807n || snapshot.household_money > 200 || snapshot.firm_money > 200
      || snapshot.total_money !== 200 || ![snapshot.inventory, snapshot.household_stock, snapshot.household_needs].every(Number.isSafeInteger))
    throw new Error('Invalid dashboard checkpoint');
  return snapshot;
}

function createDashboard({ engine = defaultEngine, stateFile = path.join(root, 'build', 'dashboard.state') } = {}) {
  let snapshot = readCheckpoint(stateFile);
  let child = null, completion = null, busy = false, closing = false;
  let mode = 'paused', error = null, intervalMs = 1000, observedConsumed = 0, observedPurchased = 0, observedProduced = 0, observedUnmet = 0;
  const history = [];

  function launch(single) {
    if (closing) throw new Error('Server is shutting down');
    if (child) throw new Error('An engine is already running');
    error = null;
    mode = single ? 'stepping' : 'running';
    const args = [single ? '--ticks' : '--forever'];
    if (single) args.push('1');
    args.push('--interval-ms', String(single ? 0 : intervalMs), '--state', stateFile, '--json');
    const processHandle = spawn(engine, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child = processHandle;
    let stopped = false, stderr = '';
    const lines = readline.createInterface({ input: processHandle.stdout });
    lines.on('line', line => {
      try {
        const tick = JSON.parse(line);
        if (typeof tick.tick !== 'string' || !tick.before || !tick.after_work || !tick.after_trade
            || !Number.isSafeInteger(tick.household_stock) || !Number.isSafeInteger(tick.household_needs)
            || ![0, 1].includes(tick.purchased) || ![0, 1].includes(tick.consumed)
            || ![0, 1].includes(tick.unmet_need) || !Number.isSafeInteger(tick.produced) || tick.produced < 0
            || !tick.after_consumption || !tick.before_consumption
            || ![tick.wage, tick.price, tick.production_batch, tick.production_threshold].every(n => Number.isSafeInteger(n) && n > 0))
          throw new Error('Unexpected engine output; rebuild the C++ engine for batch production and consumption');
        snapshot = tick;
        observedConsumed += tick.consumed;
        observedPurchased += tick.purchased;
        observedProduced += tick.produced;
        observedUnmet += tick.unmet_need;
        history.push(tick);
        if (history.length > 200) history.shift();
      } catch (failure) {
        error = failure.message;
        processHandle.kill();
      }
    });
    processHandle.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    processHandle.on('error', failure => { error = `Cannot launch engine: ${failure.message}`; });
    completion = new Promise(resolve => {
      processHandle.on('close', code => {
        lines.close();
        child = null;
        if (!stopped && code !== 0 && !error) error = stderr.trim() || `Engine exited with code ${code}`;
        // On Windows termination may happen after save but before stdout; reread committed state.
        try { snapshot = { ...snapshot, ...readCheckpoint(stateFile) }; }
        catch (failure) { error = failure.message; }
        mode = error ? 'error' : 'paused';
        resolve();
      });
    });
    return { done: completion, stop: () => { stopped = true; processHandle.kill(); } };
  }

  let active = null;
  async function pause() {
    if (child && active) { active.stop(); await active.done; }
  }
  function state() {
    return { mode, error, interval_ms: intervalMs, snapshot, history, observed_consumed: observedConsumed, observed_purchased: observedPurchased, observed_produced: observedProduced, observed_unmet: observedUnmet };
  }
  async function control(body) {
    if (busy) throw new Error('Another command is in progress');
    busy = true;
    try {
      if (!['start', 'pause', 'step'].includes(body.action)) throw new Error('Unknown action');
      if (body.action === 'pause') { await pause(); return; }
      if (body.action === 'start') {
        const interval = body.interval_ms ?? intervalMs;
        if (!Number.isInteger(interval) || interval < 100 || interval > 10000)
          throw new Error('Tick interval must be an integer from 100 to 10000 ms');
        await pause();
        intervalMs = interval;
        active = launch(false);
      } else {
        if (child) throw new Error('Pause the simulation before stepping');
        active = launch(true);
        await active.done;
        if (error) throw new Error(error);
      }
    } finally { busy = false; }
  }

  const assets = {
    '/': ['dashboard/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['dashboard/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['dashboard/style.css', 'text/css; charset=utf-8'],
    '/architecture.svg': ['docs/architecture.svg', 'image/svg+xml'],
    '/favicon.ico': [null, 'image/x-icon']
  };
  function send(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  const server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '')) return send(response, 403, { error: 'Localhost only' });
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'");
    if (request.method === 'GET' && request.url === '/api/state') return send(response, 200, state());
    if (request.method === 'POST' && request.url === '/api/control') {
      if (request.headers.origin && request.headers.origin !== `http://${host}`)
        return send(response, 403, { error: 'Origin not allowed' });
      if (request.headers['content-type'] !== 'application/json') return send(response, 415, { error: 'Send application/json' });
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 1024) return send(response, 413, { error: 'Request too large' });
        }
        const command = JSON.parse(body);
        if (!command || typeof command !== 'object') throw new Error('Expected a command object');
        await control(command);
        return send(response, 200, state());
      } catch (failure) { return send(response, 400, { error: failure.message }); }
    }
    if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
      const [file, type] = assets[request.url];
      if (!file) { response.writeHead(204); return response.end(); }
      try {
        const data = await fs.promises.readFile(path.join(root, file));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return response.end(data);
      } catch { return send(response, 500, { error: 'Cannot read dashboard asset' }); }
    }
    send(response, 404, { error: 'Not found' });
  });
  return { server, state, async close() {
    closing = true;
    await pause();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (require.main === module) {
  try {
    if (!fs.existsSync(defaultEngine)) throw new Error('Build the C++ engine first (see README.md)');
    const dashboard = createDashboard();
    dashboard.server.on('error', failure => { console.error(failure.message); process.exitCode = 1; });
    dashboard.server.listen(3000, '127.0.0.1', () => console.log('Dashboard: http://localhost:3000 (starts paused)'));
    let shuttingDown = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await dashboard.close();
    });
  } catch (failure) { console.error(failure.message); process.exitCode = 1; }
}
module.exports = { createDashboard, readCheckpoint };
