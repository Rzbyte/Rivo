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

Binary event contracts settle to zero or one. A position can lose its entire
premium, and on this venue most windows never trade at all, so an open position
may be impossible to exit before settlement at any price.
