const byId = id => document.getElementById(id);
let pending = false;
let lastState = null;
let commandError = '';
const format = value => typeof value === 'string' ? BigInt(value).toLocaleString() : value.toLocaleString();

function balances(snapshot) {
  return `Household ${snapshot.household_money} · Firm ${snapshot.firm_money}\nFirm inventory ${snapshot.inventory} · Household stock ${snapshot.household_stock}`;
}
function render(state) {
  lastState = state;
  const s = state.snapshot;
  byId('status').textContent = ({ paused: 'Paused', running: 'Engine running', stepping: 'One tick in progress', error: 'Engine error' })[state.mode];
  byId('dot').className = `status-dot ${state.mode}`;
  byId('clock').textContent = `${state.interval_ms / 1000}s interval · C++ engine`;
  byId('tick').textContent = format(s.tick);
  byId('total').textContent = `${s.total_money} units`;
  byId('conservation').textContent = s.household_money + s.firm_money === 200 ? 'Conserved across transfers' : 'Conservation check failed';
  for (const [id, key] of [['household', 'household_money'], ['firm', 'firm_money'], ['inventory', 'inventory']]) byId(id).textContent = format(s[key]);
  byId('consumed').textContent = format(state.observed_consumed);
  byId('purchased').textContent = format(state.observed_purchased);
  byId('produced').textContent = format(state.observed_produced);
  byId('unmet').textContent = format(state.observed_unmet);
  byId('stock').textContent = format(s.household_stock);
  byId('needs').textContent = format(s.household_needs);
  byId('demand').textContent = s.household_stock < s.household_needs ? 'Below target: will buy if affordable and available' : 'Target reached: no purchase needed';
  byId('quote').textContent = format(s.next_price);
  const m = s.market;
  const labels = { waiting: 'Gathering observations', affordability: 'Lowered: buyers lack money', scarcity: 'Raised: supply is scarce', unsold_goods: 'Lowered: goods remain unsold', stable: 'Held steady', price_floor: 'At the minimum price', price_ceiling: 'At the maximum price' };
  byId('price-decision').textContent = labels[m.last_reason];
  byId('market-window').textContent = `${m.samples} / ${m.period} ticks toward next review · price limits ${m.min_price}–${m.max_price}`;
  byId('market-demand').textContent = `${m.window_requested} requested · ${m.window_affordable} affordable · ${m.window_sales} sold in current window`;
  byId('run').disabled = pending || state.mode === 'running' || state.mode === 'stepping';
  byId('pause').disabled = pending || !['running', 'stepping'].includes(state.mode);
  byId('step').disabled = pending || ['running', 'stepping'].includes(state.mode);
  byId('interval').disabled = pending || ['running', 'stepping'].includes(state.mode);
  const latest = state.history.at(-1);
  if (latest) {
    byId('latest-tick').textContent = `TICK ${format(latest.tick)}`;
    byId('before').textContent = balances(latest.before);
    byId('wage-rule').textContent = `${latest.wage} / production batch`;
    byId('price-rule').textContent = `${latest.price} / good`;
    byId('wage-arrow').textContent = `WAGE · ${latest.wage}`;
    byId('price-arrow').textContent = `PAYMENT · ${latest.price}`;
    const productionReason = latest.before.inventory >= latest.production_threshold ? 'Inventory at or above threshold' : 'Cannot afford wage';
    byId('work').textContent = `${latest.produced ? `Wage paid ${latest.wage} · Produced ${latest.produced}` : `Produced 0 · ${productionReason}`}\n${balances(latest.after_work)}`;
    const reason = latest.before.household_stock >= latest.household_needs ? 'Stock target reached' : latest.after_work.inventory === 0 ? 'No goods available' : 'Not enough money';
    byId('trade').textContent = `${latest.purchased ? `Payment ${latest.price} · Bought 1` : `No purchase · ${reason}`}\n${balances(latest.after_trade)}`;
    byId('consumption').textContent = `${latest.consumed ? 'Consumed 1 stored good' : 'Unmet need: no stored good to consume'}\nStock ${latest.before_consumption.household_stock} → ${latest.after_consumption.household_stock}`;
    byId('market-observation').textContent = `Desired stock gap ${latest.market.desired} · Requested ${latest.market.requested}\nAffordable ${latest.market.affordable} · Available ${latest.market.supply} · Sold ${latest.market.sales}`;
    byId('pricing').textContent = `This tick's quote ${latest.price} → Next quote ${latest.next_price}\n${latest.market.decision === 'waiting' ? 'Waiting for the five-tick review' : labels[latest.market.decision]}`;
    const rows = state.history.slice(-20).reverse().map(tick => {
      const row = document.createElement('tr');
      for (const key of ['tick', 'household_money', 'firm_money', 'produced', 'purchased', 'household_stock', 'consumed', 'unmet_need', 'inventory', 'price', 'next_price']) {
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
