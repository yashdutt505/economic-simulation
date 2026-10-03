const byId = id => document.getElementById(id);
let pending = false;
let lastState = null;
let commandError = '';
const format = value => typeof value === 'string' ? BigInt(value).toLocaleString() : value.toLocaleString();

function balances(snapshot) {
  return `Household ${snapshot.household_money} · Firm ${snapshot.firm_money}\nInventory ${snapshot.inventory}`;
}
function render(state) {
  lastState = state;
  const s = state.snapshot;
  byId('status').textContent = ({ paused: 'Paused', running: 'Engine running', stepping: 'One tick in progress', error: 'Engine error' })[state.mode];
  byId('dot').className = `status-dot ${state.mode}`;
  byId('clock').textContent = `${state.interval_ms / 1000}s interval · C++ engine`;
  byId('tick').textContent = format(s.tick);
  byId('total').textContent = `${s.household_money + s.firm_money} units`;
  byId('conservation').textContent = s.household_money + s.firm_money === 200 ? 'Conserved across transfers' : 'Conservation check failed';
  for (const [id, key] of [['household', 'household_money'], ['firm', 'firm_money'], ['inventory', 'inventory']]) byId(id).textContent = format(s[key]);
  byId('consumed').textContent = format(state.observed_consumed);
  byId('run').disabled = pending || state.mode === 'running' || state.mode === 'stepping';
  byId('pause').disabled = pending || !['running', 'stepping'].includes(state.mode);
  byId('step').disabled = pending || ['running', 'stepping'].includes(state.mode);
  byId('interval').disabled = pending || ['running', 'stepping'].includes(state.mode);
  const latest = state.history.at(-1);
  if (latest) {
    byId('latest-tick').textContent = `TICK ${format(latest.tick)}`;
    byId('before').textContent = balances(latest.before);
    byId('work').textContent = `${latest.produced ? 'Wage paid 10 · Produced 1' : 'No wage paid · Produced 0'}\n${balances(latest.after_work)}`;
    byId('trade').textContent = `${latest.consumed ? 'Payment 10 · Consumed 1' : 'No purchase · Consumed 0'}\n${balances(latest)}`;
    const rows = state.history.slice(-20).reverse().map(tick => {
      const row = document.createElement('tr');
      for (const key of ['tick', 'household_money', 'firm_money', 'produced', 'consumed', 'inventory']) {
        const cell = document.createElement('td');
        cell.textContent = format(tick[key]);
        row.append(cell);
      }
      return row;
    });
    byId('history').replaceChildren(...rows);
  }
  const message = state.error || commandError;
  byId('error').hidden = !message;
  byId('error').textContent = message;
}
async function command(action) {
  pending = true;
  commandError = '';
  if (lastState) render(lastState);
  try {
    const response = await fetch('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, interval_ms: Number(byId('interval').value) })
    });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error);
    render(state);
  } catch (failure) { commandError = failure.message; }
  finally { pending = false; if (lastState) render(lastState); }
}
for (const [id, action] of [['run', 'start'], ['pause', 'pause'], ['step', 'step']]) byId(id).addEventListener('click', () => command(action));
async function poll() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Dashboard server returned an error');
    render(await response.json());
  } catch {
    byId('status').textContent = 'Disconnected';
    byId('dot').className = 'status-dot error';
    byId('error').hidden = false;
    byId('error').textContent = 'Cannot reach the dashboard server. Start it with npm start, then reconnect.';
    for (const id of ['run', 'pause', 'step', 'interval']) byId(id).disabled = true;
  } finally { setTimeout(poll, 300); }
}
poll();
