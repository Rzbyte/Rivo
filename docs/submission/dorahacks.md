<!-- PASTE VERSION — DO NOT RE-WRAP.

Every paragraph and every bullet is deliberately ONE long line. DoraHacks's
editor treats a single newline as a hard break, so a wrapped source produced two
visible defects when pasted: multi-line bullets split into a bullet plus an
orphan paragraph, and any `**bold**` or `code` span straddling a newline failed
to render and showed its markers raw. One line per block fixes both.

If you edit this, keep the lines long. -->

# Rivo Intelligence

Rivo Intelligence turns DreamDEX Event Contract probabilities into measurable evidence.

DreamDEX can show a market at 67%, but that number alone does not tell traders whether contracts quoted near 67% have historically settled true 67% of the time. Rivo measures this against **2,179 settled Event Contracts** — probability calibration, confidence intervals, market-specific cohorts, and live market intelligence. Measured skill against the base rate: **27.1%**.

Rivo also validates autonomous trading agents before they are trusted with execution. A model can forecast well and still not deserve capital. Rivo's own reference agent is the proof: **AUC 0.816** out of sample, **+2.8% return on stake** walk-forward — and it is **REJECTED**, because t = 0.79 on window-clustered folds is indistinguishable from luck. A positive number that is not significant is not an edge, and Rivo says so about its own model instead of shipping it.

## Check → Understand → Validate → Prove

- **Check** — one live contract: what the book asks, what comparable contracts actually settled, and a verdict in ten seconds. No wallet, no account.
- **Markets** — live DreamDEX Event Contracts: implied probabilities, spreads, liquidity, reference probabilities, historical calibration.
- **Calibration** — quoted probabilities against realized settlement frequencies on settled DreamDEX markets.
- **Agent Validation** — forecast quality and walk-forward economic performance, behind a gate that is allowed to refuse.
- **Live Shadow** — agents run autonomously against live markets without sending transactions.
- **Proof** — execution on DreamDEX testnet with real Somnia transactions, reconciliation, and settlement evidence.
- **Evidence** — every study behind the above, including the two that came back no: liquidity provision, and a cross-tenor arbitrage that was real, violated 719 times, and a median of two shares deep.

Rivo integrates directly with DreamDEX Event Contracts, DreamDEX execution infrastructure, Somnia, historical market data, and settlement outcomes.

## Handed back to the venue

Building this deep surfaced something worth handing back: the on-behalf entrypoints `placeBinaryOrderFor` and `cancelOrderFor` are already deployed on the BinaryPool and gated by `OnlyApprovedContracts()` — an allowlist with nothing on it. **Enabling it is the one change that would let any Event Contract bot on this venue be non-custodial.** Measured with `npm run probe:operator`: one minute, no key, no gas.

That measurement is one of fifteen findings on the SDK, indexer and contracts, each with a reproduction, in `docs/SDK-FEEDBACK.md`. Thirteen survived a full re-check against markets-sdk 0.29.0; two we withdrew as our own measurement error, including one we had ranked highest.

---

The goal is not to promise profitable AI trading. The goal is to make both market probabilities and autonomous agents accountable to real outcomes before deployment.

**Measure probabilities. Validate agents. Prove execution.**
