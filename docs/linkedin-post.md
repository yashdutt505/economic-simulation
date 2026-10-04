An update on my C++ economic simulation: it now has a third entity—a market.

The household and firm still exchange one type of good. The market observes what the household requests, what it can afford, available inventory, and actual sales. Every five ticks, those signals inform the firm's next price.

The first policy is deliberately small: lower the quote when affordability or unsold goods are a problem, raise it when supply is scarce, and change it by at most one unit within defined bounds.

The most useful lesson so far: wanting a good and being able to afford it are different signals. Lowering prices also cannot fix a household with zero income. Labor and wage timing are the next relationship I want to improve.

The local dashboard now shows demand, sales, price decisions, and both the transaction price and next quote. Saved runs retain partial market observations, so restarting preserves the pricing trajectory. Integration tests cover accounting, price bounds, and restart behavior.

I'm building this step by step to understand each mechanism before adding complexity.

Code: https://github.com/yashdutt505/economic-simulation

#CPP #EconomicSimulation #LearningInPublic #SoftwareDevelopment
