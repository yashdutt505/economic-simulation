I'm starting a new project: an economic simulation built in C++.

The long-term idea is a world of interacting entities, processes, and external events that can run continuously in the cloud. But I'm starting with the smallest version I can understand and inspect:

• One household
• One firm
• One good
• A simple cycle: work → earn → produce → buy → consume

The first version includes a C++ simulation engine, saved state for resuming a run, and a local dashboard where I can run, pause, or inspect a single tick. There's also a Docker setup for a future cloud deployment.

An interesting detail: the wage and the price are both 10, so the balances return to the same values after every tick. The dashboard shows the exchange within the tick, making that behavior visible.

My plan is to build it step by step: add a behavior, observe what changes, and understand the result before adding more complexity.

Next up: more entities and different relationships between them.

The code is public: https://github.com/yashdutt505/economic-simulation

I'll share progress as the project develops.

What would you add first: another household, variable prices, or an external event?

#BuildInPublic #CPP #EconomicSimulation #SoftwareDevelopment
