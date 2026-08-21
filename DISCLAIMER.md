# Disclaimer

Rivo is **research and educational software**, built for the Somnia × DreamDEX
Event Contracts Hackathon. It is not financial advice, not a product, and not
audited.

**It has not been shown to be profitable.** The opposite, in fact: this
repository's own backtests show that taking liquidity against DreamDEX Event
Contract flow lost money at every threshold tested, and the measurement work
that established this is documented in [`docs/EVIDENCE.md`](docs/EVIDENCE.md)
rather than hidden. The forecasting model is validated; the trading strategy
built on it is not.

Do not run this with money you cannot afford to lose. Dry run is the default,
live trading requires deliberately disabling it, and the code will refuse to
trade with a placeholder key. Those defaults are there for a reason.

**An unattended process holds a hot key, and this venue offers no way to limit
what that key may do.** The on-chain scoping that would — `placeBinaryOrderFor`,
`cancelOrderFor` — is present in the deployed contract and switched off, which
is measured in [`docs/SDK-FEEDBACK.md`](docs/SDK-FEEDBACK.md) §9. So run Rivo
from an agent wallet (`npm run agent -- new`) holding only what you are prepared
to lose, rather than from a wallet holding anything else. Every other limit —
capital ceiling, delta budgets, the drawdown breaker — is enforced by this code
and holds only as long as this code is the only thing holding the key.

Binary event contracts settle to zero or one. A position can lose its entire
premium, and on this venue most windows never trade at all, so an open position
may be impossible to exit before settlement at any price.
