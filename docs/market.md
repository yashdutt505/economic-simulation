# Market feedback and the C++ logic

The market is the third entity. It records trade signals and supplies information
for the firm's pricing decision. It holds no money or goods; transfers still
happen directly between household and firm. This is a small pricing heuristic,
not a competitive equilibrium model.

## Tick order and demand

Production and wages happen first. The household then buys at the existing quote,
consumes one stored good if available, and the market records that tick. Every
five observations, the firm reviews its quote. The revised quote applies next
tick. JSON `price` is the quote used for this tick; `next_price` is the new quote.

| Signal | Meaning before buying |
| --- | --- |
| `desired` | Full stock gap: `max(needs - stock, 0)` |
| `requested` | 1 if below target, otherwise 0; purchases remain capped at one |
| `affordable` | 1 if requesting a good and cash covers the current quote |
| `supply` | Firm inventory after production |
| `sales` | 1 if affordable demand meets positive inventory, otherwise 0 |
| `unfilled` | Requested goods minus sales |

Zero sales can mean insufficient money or insufficient supply. A household with
zero money can still request a good. Affordable demand is recorded even when no
goods are available, so the market can distinguish stockouts from affordability.

## Pricing rules, in priority order

The firm starts at 12. Each five-tick review changes its quote by at most one,
within 1–30. Only the first matching rule applies.

| Window condition | Action | Reason |
| --- | --- | --- |
| Requested exceeds affordable demand, and inventory remains | Lower by one | `affordability` |
| Affordable demand encountered zero supply, or sales occurred and final inventory is below 5 | Raise by one | `scarcity` |
| Positive inventory was offered on a tick with no sale | Lower by one | `unsold_goods` |
| None of these | Hold | `stable` |
| Moving would exceed a bound | Hold | `price_floor` / `price_ceiling` |

Between reviews, `decision` is `waiting`; `last_reason` retains the previous
review's outcome. After review the window resets, so zero samples alongside a
completed decision is normal. Inventory is a stock, not a per-tick supply flow;
the policy uses final inventory as a simple scarcity signal rather than dividing
demand by total inventory. A sale does not automatically raise the quote.

For example, five requests with zero affordable requests and goods remaining
reduce 12 to 11. Affordable requests facing no supply raise 12 to 13. Offered
goods that remain unsold when the household does not request any also lower price.

## Understanding the C++ methods

`Firm::price` is mutable state, like money. The pricing period and bounds remain
constants. `Economy` contains one `Household`, one `Firm`, and one `Market`.

`Market::observe(demand, budget_demand, supply, sold)` increments `samples` and
adds this tick's demand and sales to the window. `sold ? 1 : 0` chooses 1 when
the Boolean is true and 0 otherwise. An offered good with no sale increments
`unsold_ticks`. Affordable demand with no supply increments `stockout_ticks`.

`Market::update_price(Firm& firm)` receives the actual firm by reference, allowing
it to modify that firm's quote. It returns early until five observations exist.
The local `direction` starts at zero, then becomes -1 or +1 when a rule matches.
The `if` / `else if` chain enforces priority. Bound checks prevent an invalid
quote. Chained assignment resets the six counters after review. The method
returns a reason code; `price_reason()` converts validated codes 0–6 into strings.

`Economy::step()` captures `firm.price` in `TickResult::trade_price` before
executing trade. After consumption it calls `observe()` and `update_price()`.
`TickResult` describes this tick; `Firm` and `Market` retain state for future
ticks. JavaScript displays those results without implementing another pricing
policy. Money and goods accounting remain unchanged by the market.

## Persistence and tests

New checkpoints save the next quote and partial observation window:

```text
economy-v3 TICK HH_MONEY FIRM_MONEY INVENTORY STOCK NEEDS PRICE SAMPLES REQUESTED AFFORDABLE SALES UNSOLD_TICKS STOCKOUT_TICKS REASON
```

V1 and v2 still load, initializing quote 12 and an empty window. V2 keeps its
stock and needs. Both C++ and Node reject invalid prices, inconsistent window
counts, and unknown reason codes. Saving a partial window means restarting after
three observations produces the same fifth-observation decision as uninterrupted
execution. Tests compare the complete resumed and uninterrupted JSON trajectories.
They also cover all pricing outcomes and bounds, migration, HTTP controls, and
money/goods conservation over 1,000 ticks.

## What to code next

The existing income issue remains visible: the first 10 sales exhaust household
cash. The market then lowers the quote toward 1, but zero cash cannot buy even
at that price. Unsold inventory prevents production and therefore prevents
another wage. Improve labor and wage timing next, then allow bounded purchases
greater than one so the household can rebuild its target stock buffer. Compare
demand, sales, inventory, and unmet consumption when experimenting with policies.
