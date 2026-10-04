const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboard, readCheckpoint } = require('../dashboard/server');
const engine = path.resolve('build', process.platform === 'win32' ? 'economy.exe' : 'economy');
const run = args => execFileSync(engine, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').map(line => JSON.parse(line));

test('batch production, consumption, cash and goods accounting over 1000 ticks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-test-'));
  try {
    const file = path.join(dir, 'test.state');
    const ticks = run(['--ticks', '1000', '--interval-ms', '0', '--state', file, '--json']);
    assert.equal(ticks.length, 1000);
    let purchases = 0;
    for (const tick of ticks) {
      assert.equal(tick.household_money + tick.firm_money, 200);
      assert.equal(tick.total_money, 200);
      assert.ok([0, 1].includes(tick.consumed));
      assert.ok([0, 10].includes(tick.produced));
      assert.equal(tick.unmet_need, 1 - tick.consumed);
      assert.equal(tick.household_needs, 2);
      assert.equal(tick.after_trade.household_stock, tick.before.household_stock + tick.purchased);
      assert.equal(tick.household_stock, tick.before.household_stock + tick.purchased - tick.consumed);
      assert.equal(tick.after_consumption.household_stock, tick.household_stock);
      assert.ok(tick.household_stock >= 0);
      assert.equal(tick.inventory + tick.household_stock,
        tick.before.inventory + tick.before.household_stock + tick.produced - tick.consumed);
      const wagePaid = tick.produced > 0 ? 10 : 0;
      assert.equal(tick.household_money, tick.before.household_money + wagePaid - tick.price * tick.purchased);
      assert.equal(tick.firm_money, tick.before.firm_money - wagePaid + tick.price * tick.purchased);
      assert.ok(tick.price >= 1 && tick.price <= 30);
      assert.ok(Math.abs(tick.next_price - tick.price) <= 1);
      assert.equal(tick.market.sales, tick.purchased);
      assert.ok(tick.market.sales <= tick.market.affordable && tick.market.affordable <= tick.market.requested);
      assert.equal(tick.market.unfilled, tick.market.requested - tick.market.sales);
      if (tick.produced) assert.ok(tick.before.inventory < 5 && tick.before.firm_money >= 10);
      if (tick.purchased) assert.ok(tick.before.household_stock < tick.household_needs);
      purchases += tick.purchased;
    }
    assert.equal(purchases, 10);
    assert.equal(ticks[0].after_work.household_money, 110);
    assert.equal(ticks[0].produced, 10);
    assert.equal(ticks[0].inventory, 9);
    assert.equal(ticks[0].household_stock, 0);
    assert.equal(ticks[0].household_money, 98);
    assert.equal(ticks[1].produced, 0);
    assert.equal(ticks[5].produced, 0); // Inventory starts exactly at 5.
    assert.equal(ticks[6].produced, 10); // Inventory starts at 4.
    assert.equal(ticks[10].purchased, 0);
    assert.equal(ticks[10].consumed, 0);
    assert.equal(ticks.at(-1).firm_money, 200);
    assert.equal(ticks.at(-1).household_money, 0);
    assert.equal(ticks.at(-1).inventory, 10);
    assert.match(fs.readFileSync(file, 'utf8'), /^economy-v3 1000 0 200 10 0 2 /);
    assert.equal(readCheckpoint(file).next_price, 1);
    assert.equal(run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0].tick, '1001');
    fs.writeFileSync(file, 'economy-v1 1001 200 0 0\n');
    const stalled = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(stalled.produced, 0);
    assert.equal(stalled.consumed, 0);
    assert.equal(stalled.firm_money, 0);
    fs.writeFileSync(file, 'economy-v1 0 200 0 1\n');
    const stocked = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(stocked.produced, 0);
    assert.equal(stocked.purchased, 1);
    assert.equal(stocked.consumed, 1);
    assert.equal(stocked.household_stock, 0);
    assert.equal(stocked.firm_money, 12);
    fs.writeFileSync(file, 'economy-v1 0 100 101 0\n');
    assert.throws(() => run(['--ticks', '1', '--state', file, '--json']));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('v2 preserves stock and needs; v1 migrates; malformed checkpoints are rejected by both readers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-state-test-'));
  try {
    const file = path.join(dir, 'test.state');
    fs.writeFileSync(file, 'economy-v2 7 100 100 0 4 5\n');
    const bought = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(bought.after_trade.household_stock, 5);
    assert.equal(bought.household_stock, 4);
    assert.equal(bought.household_needs, 5);
    const next = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(next.purchased, 1);
    assert.equal(next.household_stock, 4);
    assert.equal(readCheckpoint(file).household_stock, 4);
    // A target of zero, or stock exceeding the target, is valid and stops buying.
    for (const [stock, needs] of [[0, 0], [4, 2]]) {
      fs.writeFileSync(file, `economy-v2 0 100 100 0 ${stock} ${needs}\n`);
      const tick = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
      assert.equal(tick.purchased, 0);
      assert.equal(tick.household_stock, Math.max(0, stock - 1));
    }
    // Wages arrive before buying: a cashless household can afford a good afterward.
    fs.writeFileSync(file, 'economy-v2 0 0 200 1 0 2\n');
    const unaffordable = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(unaffordable.purchased, 0); // Wage 10 is insufficient for price 12.
    assert.equal(unaffordable.household_stock, 0);
    assert.equal(unaffordable.unmet_need, 1);
    fs.writeFileSync(file, 'economy-v1 9 150 50 3\n');
    assert.equal(readCheckpoint(file).household_stock, 0);
    assert.equal(readCheckpoint(file).household_needs, 2);
    const migrated = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(migrated.tick, '10');
    assert.equal(migrated.before.household_money, 150);
    assert.equal(migrated.before.inventory, 3);
    assert.equal(migrated.household_stock, 0);
    assert.match(fs.readFileSync(file, 'utf8'), /^economy-v3 /);
    // Inventory can legitimately exceed the old arbitrary limit of 200.
    fs.writeFileSync(file, 'economy-v2 0 100 100 200 2 2\n');
    const overstocked = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
    assert.equal(overstocked.inventory, 200);
    assert.equal(overstocked.produced, 0);
    assert.equal(readCheckpoint(file).inventory, 200);
    for (const invalid of [
      'economy-v2 0 100 100 0', 'economy-v2 0 100 100 0 -1 2',
      'economy-v2 0 100 100 0 0 -2', 'economy-v2 0 100 101 0 0 2',
      'economy-v2 0 100 100 0 0 2 extra', 'economy-v3 0 100 100 0 0 2',
      'economy-v2 0 100 100 0 9007199254740992 2',
      'economy-v2 0 100 100 0 0 9007199254740992',
      'economy-v2 9223372036854775808 100 100 0 0 2'
    ]) {
      fs.writeFileSync(file, invalid);
      assert.throws(() => readCheckpoint(file), invalid);
      assert.throws(() => run(['--ticks', '1', '--state', file, '--json']), invalid);
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('market lowers unaffordable/unsold quotes, raises scarce quotes, and respects bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-market-test-'));
  const file = path.join(dir, 'test.state');
  try {
    const scenarios = [
      ['0 200 10 0 2 12 4 4 0 0 4 0 0', 11, 'affordability'],
      ['0 200 10 0 2 1 4 4 0 0 4 0 0', 1, 'price_floor'],
      ['200 0 0 0 2 12 4 4 4 0 0 4 0', 13, 'scarcity'],
      ['200 0 0 0 2 30 4 4 4 0 0 4 0', 30, 'price_ceiling'],
      ['100 100 10 2 2 12 4 0 0 0 4 0 0', 11, 'unsold_goods'],
      ['100 100 9 0 2 12 4 4 4 4 0 0 0', 12, 'stable']
    ];
    for (const [fields, quote, reason] of scenarios) {
      fs.writeFileSync(file, `economy-v3 4 ${fields}\n`);
      const tick = run(['--ticks', '1', '--interval-ms', '0', '--state', file, '--json'])[0];
      assert.equal(tick.next_price, quote, reason);
      assert.equal(tick.market.decision, reason);
      assert.equal(tick.market.samples, 0);
      assert.equal(readCheckpoint(file).next_price, quote);
      assert.equal(readCheckpoint(file).market.last_reason, reason);
    }
    for (const fields of [
      '100 100 0 0 2 0 0 0 0 0 0 0 0', // price out of bounds
      '100 100 0 0 2 31 0 0 0 0 0 0 0',
      '100 100 0 0 2 12 5 0 0 0 0 0 0', // completed window cannot be saved
      '100 100 0 0 2 12 1 0 1 0 0 0 0', // affordable exceeds requested
      '100 100 0 0 2 12 1 1 0 1 0 0 0', // sales exceed affordable
      '100 100 0 0 2 12 1 1 1 1 0 1 0', // stockout inconsistent with sales
      '100 100 0 0 2 12 0 0 0 0 0 0 7' // unknown reason
    ]) {
      fs.writeFileSync(file, `economy-v3 0 ${fields}\n`);
      assert.throws(() => readCheckpoint(file));
      assert.throws(() => run(['--ticks', '1', '--state', file, '--json']));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restart mid-window preserves the exact market and pricing trajectory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-resume-test-'));
  const file = path.join(dir, 'test.state');
  try {
    const uninterrupted = run(['--ticks', '80', '--interval-ms', '0', '--json']);
    const first = run(['--ticks', '13', '--interval-ms', '0', '--state', file, '--json']);
    assert.equal(readCheckpoint(file).market.samples, 3);
    const second = run(['--ticks', '67', '--interval-ms', '0', '--state', file, '--json']);
    assert.deepEqual([...first, ...second], uninterrupted);
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
    assert.equal(stepped.state.snapshot.household_stock, 0);
    assert.equal(stepped.state.snapshot.produced, 10);
    assert.equal(stepped.state.observed_produced, 10);
    assert.equal(stepped.state.observed_purchased, 1);
    assert.equal(stepped.state.observed_consumed, 1);
    assert.equal(stepped.state.snapshot.market.requested, 1);
    assert.equal(stepped.state.snapshot.market.affordable, 1);
    assert.equal(stepped.state.snapshot.market.sales, 1);
    assert.equal(stepped.state.snapshot.next_price, 12);
    assert.equal((await command({ action: 'start', interval_ms: 0 })).code, 400);
    assert.equal((await command({ action: 'start', interval_ms: 100 })).code, 200);
    const deadline = Date.now() + 5000;
    while (BigInt(dashboard.state().snapshot.tick) < 3n && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(BigInt(dashboard.state().snapshot.tick) >= 3n);
    assert.equal(dashboard.state().snapshot.household_stock, 0);
    assert.ok(dashboard.state().observed_purchased >= 3);
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
    assert.equal(restarted.state().snapshot.household_stock, 0);
    assert.equal(restarted.state().snapshot.household_needs, 2);
    assert.equal(restarted.state().snapshot.total_money, 200);
    assert.equal(restarted.state().snapshot.next_price, again.state.snapshot.next_price);
    assert.equal(restarted.state().snapshot.market.samples, again.state.snapshot.market.samples);
    assert.equal(restarted.state().history.length, 0);
    await restarted.close();
  } finally { await dashboard.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
