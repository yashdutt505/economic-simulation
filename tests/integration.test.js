const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server');
const engine = path.resolve('build', process.platform === 'win32' ? 'economy.exe' : 'economy');
const run = args => execFileSync(engine, args, { encoding: 'utf8' }).trim().split('\n').map(line => JSON.parse(line));

test('C++ conserves money over 1000 ticks and resumes from a checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-test-'));
  try {
    const file = path.join(dir, 'test.state');
    const ticks = run(['--ticks', '1000', '--interval-ms', '0', '--state', file, '--json']);
    assert.equal(ticks.length, 1000);
    for (const tick of ticks) {
      assert.equal(tick.household_money + tick.firm_money, 200);
      assert.equal(tick.before.household_money, 100);
      assert.equal(tick.after_work.household_money, 110);
      assert.equal(tick.after_work.firm_money, 90);
      assert.equal(tick.after_work.inventory, 1);
      assert.equal(tick.inventory, 0);
      assert.equal(tick.consumed, 1);
    }
    assert.equal(run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0].tick, '1001');
    fs.writeFileSync(file, 'economy-v1 1001 200 0 0\n');
    const stalled = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(stalled.produced, 0);
    assert.equal(stalled.consumed, 0);
    assert.equal(stalled.firm_money, 0);
    fs.writeFileSync(file, 'economy-v1 0 200 0 1\n');
    const stocked = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(stocked.produced, 0);
    assert.equal(stocked.consumed, 1);
    assert.equal(stocked.firm_money, 10);
    fs.writeFileSync(file, 'economy-v1 0 100 101 0\n');
    assert.throws(() => run(['--ticks', '1', '--state', file, '--json']));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dashboard controls real C++ ticks, pauses, and reloads committed state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const stateFile = path.join(dir, 'test.state');
  const dashboard = createDashboard({ engine, stateFile });
  await new Promise(resolve => dashboard.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${dashboard.server.address().port}`;
  const command = async body => {
    const response = await fetch(`${url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { code: response.status, state: await response.json() };
  };
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(`${url}/architecture.svg`)).status, 200);
    assert.equal(dashboard.state().mode, 'paused');
    const stepped = await command({ action: 'step' });
    assert.equal(stepped.code, 200);
    assert.equal(stepped.state.snapshot.tick, '1');
    assert.equal(stepped.state.history[0].after_work.household_money, 110);
    assert.equal((await command({ action: 'start', interval_ms: 0 })).code, 400);
    assert.equal((await command({ action: 'start', interval_ms: 100 })).code, 200);
    const deadline = Date.now() + 5000;
    while (BigInt(dashboard.state().snapshot.tick) < 3n && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(BigInt(dashboard.state().snapshot.tick) >= 3n);
    assert.equal((await command({ action: 'step' })).code, 400);
    const paused = await command({ action: 'pause' });
    assert.equal(paused.state.mode, 'paused');
    const tick = dashboard.state().snapshot.tick;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(dashboard.state().snapshot.tick, tick);
    const again = await command({ action: 'step' });
    assert.equal(BigInt(again.state.snapshot.tick), BigInt(tick) + 1n);
    const blocked = await fetch(`${url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{"action":"start"}' });
    assert.equal(blocked.status, 403);
    const restarted = createDashboard({ engine, stateFile });
    assert.equal(restarted.state().snapshot.tick, again.state.snapshot.tick);
    assert.equal(restarted.state().history.length, 0);
    await restarted.close();
  } finally { await dashboard.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
