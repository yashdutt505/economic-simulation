# Understanding the project

Start with `src/main.cpp`. It contains the complete economic model and the
command-line engine. Everything in `dashboard/` observes or controls that engine.
There is no second simulation written in JavaScript.

## 1. The model before the syntax

There are two entities: a household and a firm. Each initially has 100 money
units. The firm initially has zero goods. A tick is one complete economic cycle;
it does not yet represent a day, month, or year.

One tick executes these steps in order:

1. If the firm can afford a wage of 10, it pays the household and produces one good.
2. If a good is available and the household can afford its price of 10, the
   household pays the firm and immediately consumes one good.
3. The engine increments the tick counter, saves state if requested, and emits a record.
4. The engine waits before the next tick, unless the requested run has finished.

| Stage | Household money | Firm money | Firm inventory |
| --- | ---: | ---: | ---: |
| Before work | 100 | 100 | 0 |
| After wage and production | 110 | 90 | 1 |
| After purchase and consumption | 100 | 100 | 0 |

The total money is always 200 because both financial operations transfer money.
Production creates a good; consumption removes it. Equal wages and prices make
the default economy repeat exactly. The tick count and amount of observed activity
increase even though the final balances stay constant. This is intentional:
it gives us a small, deterministic starting point to extend.

There is no explicit labor inventory, household food storage, utility, debt,
profit calculation, bankruptcy, price discovery, random event, or calendar yet.
The household's work is implicit in the successful wage/production operation.

## 2. Headers and platform branches

`#include` makes declarations from another file available to this compilation.
The standard library supplies almost everything:

| Header | Purpose |
| --- | --- |
| `<chrono>` | Millisecond durations on non-Windows platforms |
| `<cerrno>` | File error codes such as `ENOENT` |
| `<csignal>` | Ctrl+C / termination handlers and `sig_atomic_t` |
| `<cstdio>` | `fopen`, `fclose`, and POSIX file replacement via `rename` |
| `<fstream>` | Reading and writing checkpoint files |
| `<iostream>` | Standard output and standard error |
| `<limits>` | The maximum supported tick number |
| `<stdexcept>` | Exceptions with readable error messages |
| `<string>` | Option strings, file paths, and integer conversion |
| `<thread>` | Sleeping between ticks on non-Windows platforms |

`#ifdef _WIN32` selects code at compile time for Windows. It includes `windows.h`
for `Sleep` and `MoveFileExA`. `NOMINMAX` prevents Windows headers from defining
`min` and `max` macros that can interfere with C++ names. This branch lets the
project compile with the older local MinGW distribution, which lacks usable
standard thread support.

`std::` means a name belongs to the standard library. We keep it explicit rather
than importing every standard name into our own namespace.

## 3. Internal namespace and stopping

The unnamed `namespace { ... }` keeps its functions and types local to this source
file. Other source files cannot refer to them by external linkage. `main` stays
outside it because it is the program's entry point.

```cpp
volatile std::sig_atomic_t stopping = 0;
void stop(int) { stopping = 1; }
```

The operating system can deliver a signal while ordinary code is executing.
The handler only sets a simple signal-compatible flag. It avoids file I/O,
allocation, printing, and other work that is unsafe in signal handlers.
`volatile` tells the compiler that this flag can change outside the ordinary
flow it sees; it is not a general-purpose thread synchronization tool.

`std::signal(SIGINT, stop)` installs the handler for Ctrl+C;
`SIGTERM` installs it for normal termination requests. The loop checks the flag
before the next tick and during its short sleeps. A standalone engine can finish
its current tick before stopping.

The dashboard pauses by terminating its child process. On POSIX this normally
delivers SIGTERM. On Windows Node termination is abrupt, so the server rereads
the committed checkpoint after the process closes. A completed checkpoint can
be newer than the last stdout record if termination occurred between save and
report. Intermediate activity from such a tick may not appear in session history.

## 4. Entity structs

```cpp
struct Household { long long money = 100; };
struct Firm { long long money = 100; long long inventory = 0; };
```

A `struct` groups related data. Its members are public by default. Here it is a
small entity record, with no inheritance or framework.

`long long` stores integer quantities with a range large enough for a long run.
Integer money avoids floating-point rounding in transfers. A money unit is an
abstract simulation unit, not a rupee or dollar. Later, we could define one unit
as a cent or paise without needing fractional arithmetic.

`= 100` and `= 0` are default member initializers: constructing an entity without
overrides gives it these values. `household.money` accesses a member with the dot
operator. `firm.inventory` counts goods currently held by the firm.

## 5. TickResult: observing intermediate operations

`TickResult` holds what happened during one tick:

- `produced` and `consumed` say whether those operations succeeded.
- The `*_before` fields capture the state at the beginning.
- The `*_after_work` fields capture the state after wages and production.

It does not own the lasting economy state. It is a record returned by `step()`
so we can inspect movements that final balances alone hide. `bool` represents
true or false; the report converts it to 1 or 0.

## 6. Economy and step(): the actual economic rules

`Economy` contains a persistent tick counter and one instance of each entity:

```cpp
struct Economy {
    long long tick = 0;
    Household household;
    Firm firm;
    TickResult step() { /* one complete economic cycle */ }
};
```

`step()` is a member function. It can read and modify this economy's members
directly. It takes no arguments because the wage and price are fixed internally.

First, it checks whether incrementing `tick` would overflow. If the counter is
already at `std::numeric_limits<long long>::max()`, it throws an exception before
changing any state. That prevents undefined signed integer overflow.

`const long long wage = 10` and `price = 10` create constants for this step.
`const` prevents accidentally modifying these variables. A fresh `TickResult`
captures the original balances and inventory before any transfers.

The employment/production block is:

```cpp
if (firm.money >= wage) {
    firm.money -= wage;
    household.money += wage;
    ++firm.inventory;
    result.produced = true;
}
```

`>=` tests affordability. `-=` subtracts from an existing variable; `+=` adds
to one. `++` adds one. The firm cannot pay a wage it cannot afford. A successful
payment also produces exactly one good. Wages and production are coupled in this
first model. Then the function captures the intermediate state for the dashboard.

The trade condition is:

```cpp
const bool traded = firm.inventory > 0 && household.money >= price;
```

`&&` means both conditions must be true: a good exists and the household can pay.
C++ evaluates it left to right, and skips the right condition if the left one is
false. If the trade succeeds, the household loses 10, the firm gains 10, and
`--firm.inventory` removes one good. That removal stands for immediate consumption;
the household does not retain a separate goods stock.

Finally, `++tick` advances simulated time even if no work or trade succeeded.
The function stores the trade outcome and returns the `TickResult` by value.

For example, a valid checkpoint with household money 200, firm money 0, and
inventory 0 stalls economically: no wages or goods can be produced, and there
is nothing to buy. Ticks still advance. If the same firm has one stored good,
the household can buy it, giving the firm enough money to pay a wage next tick.
These alternate states are covered by the integration checks.

## 7. load(): restoring and validating state

```cpp
void load(Economy& economy, const std::string& path)
```

`Economy&` is a reference to the caller's economy, so assigning to it updates the
actual object. `const std::string&` reads the path without copying it and without
modifying it. `void` means the function returns no value.

An `std::ifstream` opens the checkpoint for input. If opening fails, the function
checks a C-style `fopen` result and `errno` to distinguish a missing checkpoint
from other access errors. Only `ENOENT` means start with the default economy;
other failures stop the run. There must already be a writable parent directory
for a new checkpoint.

The file format is deliberately simple:

```text
economy-v1 5 100 100 0
```

These fields are version, completed tick, household money, firm money, and
firm inventory. Spaces and line breaks delimit fields.

`input >> value` extracts and converts the next field. Extraction failures make
the stream test false. The parser loads into a temporary `Economy loaded`,
then checks the format version, unexpected trailing fields, and state invariants:

- Tick is nonnegative.
- Both balances are nonnegative and sum to 200.
- Household money is at most 200.
- Inventory is between 0 and 200.

The inventory ceiling is a conservative validation limit for this tiny version,
not a universal economic rule. If production/storage rules expand, this bound
and the money validation assumptions must evolve.

Only after validation does `economy = loaded` replace the running state. This
prevents a partially parsed checkpoint from partially modifying the economy.

## 8. save(): committing the checkpoint

`save(const Economy& economy, const std::string& path)` reads the economy through
a const reference, so it cannot accidentally alter simulation state.

The function writes to `path + ".tmp"` using `std::ofstream` and `std::ios::trunc`,
which replaces the temporary file's previous contents. `<<` inserts values into
the output stream. `close()` completes the write, then the stream is checked for
failure, including failures discovered while flushing or closing.

It then replaces the final file with the temporary one: `MoveFileExA` with
`MOVEFILE_REPLACE_EXISTING` on Windows, or `std::rename` on POSIX. Both paths
avoid overwriting the live checkpoint a field at a time. No other process should
write the same checkpoint concurrently.

This is a lightweight checkpoint, not a database transaction system. It does not
call fsync or guarantee persistence through a machine/power/storage failure.
Pause or restart normally can resume the last committed state. A failed write
stops the engine rather than pretending progress was safely stored.

## 9. report(): terminal text or structured JSON

`report` receives the finished economy and its tick record as const references.
Without `--json`, it prints the original human-readable status line. With
`--json`, it prints one JSON object per line, often called newline-delimited JSON.

```json
{"tick":"1","household_money":100,"firm_money":100,"inventory":0,"produced":1,"consumed":1,"before":{"household_money":100,"firm_money":100,"inventory":0},"after_work":{"household_money":110,"firm_money":90,"inventory":1}}
```

The tick number is a JSON string: JavaScript's normal `Number` cannot precisely
represent every 64-bit integer. The browser uses `BigInt` to format this string
without losing precision. Balances and inventory are bounded small integers and
can be ordinary JSON numbers.

The manual JSON construction is safe here because the fields are numeric or a
numeric tick string, with no arbitrary text requiring JSON escaping. If entities
later get names or descriptions, use proper escaping or a JSON library.

`std::endl` adds a newline and flushes stdout so the dashboard receives each tick
promptly. This flush is separate from durable checkpoint storage. `report()` runs
after `save()`, so reported state has already passed the save step.

## 10. number(): parsing option values

`std::stoll` converts a string to `long long`. The `used` output reports how many
characters it consumed. Checking `used == value.size()` rejects trailing text
such as `10ticks`; checking the result rejects negative values. `stoll` itself
throws for nonnumeric inputs or values outside the integer range.

`auto` asks the compiler to deduce a variable's type from its initializer. Here
`const auto result` is still a constant integer; it is not dynamically typed.

## 11. main(): options, lifecycle, and the loop

`int main(int argc, char** argv)` is the executable's entry point. `argc` is the
number of command-line arguments; `argv` points to their strings. `argv[0]` is
the executable name, so parsing starts at index 1.

Defaults are 10 additional ticks, 1,000 milliseconds between ticks, no persistence,
and human-readable output. Boolean options (`--forever`, `--json`) consume no
value. The other options consume the next argument with `argv[++i]`:

| Option | Meaning |
| --- | --- |
| `--help` | Print usage and exit successfully |
| `--ticks N` | Run N additional ticks; zero performs no steps |
| `--forever` | Continue until stopped; takes precedence over a tick count |
| `--interval-ms N` | Delay after each tick, up to one day |
| `--state PATH` | Load and replace a checkpoint at this path |
| `--json` | Emit structured per-tick records |

`continue` advances to the next parser iteration after a flag. Missing values or
unknown options throw errors. Continuous execution requires a positive delay to
avoid an accidental busy loop; finite fast runs may use zero.

After installing signals and loading optional state, the outer loop runs while
the stop flag is unset and either continuous mode is enabled or the requested
number of ticks has not been completed.

`ran` counts ticks in this invocation; `economy.tick` counts ticks across saved
runs. They differ after a restart. In continuous mode `ran` is not incremented,
avoiding overflow in an unnecessary counter.

Each iteration calls `step`, optionally saves, then reports. A finite run breaks
after its final tick, so it does not sleep unnecessarily. The inner loop splits
the remaining delay into chunks of at most 100 ms so shutdown can be noticed
promptly. Windows uses `Sleep`; other platforms use `std::this_thread::sleep_for`.
Timing is a delay between ticks, not a precise scheduler: work and disk I/O add
to actual elapsed wall time. Missed time while the program is offline is not
automatically simulated on restart.

The outer `try`/`catch` handles exceptions from parsing, loading, ticking, and
saving. It prints `error: ...` to `std::cerr` and returns 1. Returning 0 indicates
normal completion. These exit codes let scripts and Docker detect failures.

## 12. dashboard/server.js: process supervision and HTTP

The server uses only Node built-in modules. `http` serves requests, `fs` reads
files, `path` builds platform-correct paths, `child_process.spawn` launches the
C++ executable, and `readline` reads stdout one JSON line at a time.

`readCheckpoint()` gives the UI an initial snapshot before any new tick has run.
It checks the fixed checkpoint format and the same basic invariants as the
engine. This is serialization validation, not a duplicate economic model.

`createDashboard()` creates a server and its associated worker state. The factory
also lets tests provide a separate executable and temporary checkpoint. The
normal executable is `build/economy.exe` on Windows and `build/economy` elsewhere.

`launch(single)` builds an argument array and spawns the executable directly,
without a shell. Single-step mode uses `--ticks 1 --interval-ms 0`; continuous
mode uses `--forever` and the selected delay. Both use `--state` and `--json`.
There is one worker at a time. Node does not calculate wages, production, or trade.

As stdout arrives, the server parses each JSON record, updates the snapshot,
counts observed consumption, and retains at most 200 records. It captures a
bounded amount of stderr for error display. Invalid stdout or worker startup
failure becomes a visible engine error rather than fake data.

`completion` is a Promise that resolves when the child closes. A Promise
represents a result that becomes available later. `await` suspends that async
function until the result is ready without blocking the whole Node server.
`pause()` terminates the current worker and waits for its close before another
worker can start. The close handler rereads committed state for consistency.

`control()` serializes control commands using `busy`. Start validates the interval
(100–10,000 ms), pauses any old worker, and launches one worker. Step requires a
paused economy and waits for its single tick. Pause waits for shutdown. `finally`
clears the command lock even when an error occurs. This is a small local worker
supervisor, not a distributed job queue.

The HTTP routes are:

| Route | Purpose |
| --- | --- |
| `GET /` | Dashboard page |
| `GET /style.css`, `/app.js` | UI files |
| `GET /architecture.svg` | Architecture picture |
| `GET /api/state` | Mode, error, interval, snapshot, recent records, session consumption |
| `POST /api/control` | JSON command: start, pause, or step |

Assets use an explicit allowlist, so requests cannot browse arbitrary files.
The server binds to `127.0.0.1:3000`. It checks the Host header and rejects
cross-origin browser control requests. JSON control bodies have a small size
limit. A content security policy permits the local scripts/styles/assets and
prevents framing. There is no authentication or remote dashboard hosting yet;
keep this endpoint local.

The `require.main === module` block runs only when this file is launched directly,
not when tests import the factory. It checks that the engine exists, starts the
HTTP listener, and installs Node shutdown handlers. The exported functions make
testing possible without starting a second normal dashboard.

If Node is forcibly killed or the machine crashes, an orphaned worker may require
manual cleanup; a production service should use OS/container supervision for the
entire process tree. Run just one normal dashboard instance per checkpoint.

## 13. dashboard/index.html, style.css, and app.js

`index.html` defines the static UI: controls, summary cards, entities, latest tick
phases, recent activity table, and expandable architecture image. IDs give the
script stable targets. Buttons are real HTML buttons; inputs have labels and
errors/status use appropriate announcement roles.

`style.css` contains presentation only. Grid and flexbox arrange the cards and
entity relationships; media queries stack content on narrower screens. No
external fonts, CSS framework, or asset service is required. Styling does not
calculate or alter simulation state.

`app.js` attaches click handlers and polls `/api/state` every 300 ms after the
previous request completes. It renders the latest actual snapshot and builds
the last 20 history rows with `textContent`, keeping records as text rather than
injecting HTML. Intermediate balances come directly from the C++ `before` and
`after_work` fields. The fixed relationship labels describe the current rules;
they will need updating if the wage or price becomes configurable.

`command()` posts a JSON control request, disables controls while it is pending,
renders the response, and shows errors. The buttons prevent stepping while the
worker runs; the server independently enforces that rule. Network failure shows
Disconnected and disables commands until polling succeeds again.

No page reload is needed to observe changes. Closing a browser tab does not close
Node or its worker. UI history and observed consumption reset with the Node
process; checkpoint state and total completed ticks survive a restart.

## 14. Build, deployment, and repository files

- `CMakeLists.txt` defines one C++17 executable and enables useful compiler warnings.
  It does not download libraries. With Visual Studio the output may be in
  `build/Debug/`; copy it to `build/economy.exe` for the dashboard's default path.
- `package.json` defines `npm start` and `npm test`. There are no package dependencies,
  so `npm install` is unnecessary. `private: true` prevents accidental npm publication;
  it does not determine GitHub repository visibility.
- `Dockerfile` builds the engine in a GCC image, then copies only the executable
  into a smaller Debian runtime. It runs as a non-root user and stores state in
  `/data`. Its default command is continuous execution. It contains no dashboard.
- `compose.yaml` starts that engine container, mounts a named volume, restarts it
  after failure, and rotates logs. This prepares an engine deployment; it does
  not provision a VM or deploy a public service.
- `.gitignore` excludes compiled artifacts and mutable checkpoint files.
- `.dockerignore` keeps Git metadata, builds, and checkpoints out of the image context.
- `README.md` gives build/run instructions. `docs/architecture.svg` is an editable,
  standalone picture of the architecture and default tick sequence.
- `docs/linkedin-post.md` is an announcement draft, not an automatically published post.

## 15. What the tests establish

`tests/integration.test.js` uses Node's built-in test runner and the real compiled
engine. The first check runs 1,000 ticks with isolated temporary state and verifies
cash conservation, intermediate balances, goods production/consumption, checkpoint
resume, stalled/stocked alternatives, and invalid-state rejection.

The second starts an isolated HTTP server and tests a single tick, continuous
running, pause stability, a second step after pause, interval validation, invalid
concurrent stepping, checkpoint reload, asset availability, and cross-origin
control rejection. It waits for actual observed ticks with a deadline instead of
assuming a child launches instantly. Test files are created inside a fresh
temporary test directory and cleaned up afterward.

These checks do not establish economic realism, cloud availability, durability
after power loss, or large-scale performance. They establish that the small
mechanism and its local controls behave as intended.

## 16. A useful next change

Add a second household after deciding what the firm does when it can afford
only one wage: choose a fixed ordering, rotate employment, or pick randomly?
That decision introduces a real relationship and allocation rule. Keep the
cash conservation check, update the checkpoint version if its shape changes,
and show the new transfers on the dashboard. This is how the project can grow
without making the initial engine difficult to understand.
