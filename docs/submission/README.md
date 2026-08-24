# Submission

Everything a judge, an operator or a future maintainer needs at the point this was frozen.

| | |
|---|---|
| [demo-script.md](demo-script.md) | the three-minute recording, scene by scene, with the exact numbers to read off the screen |
| [submission-copy.md](submission-copy.md) | final text for the submission form — title, tagline, descriptions, integration, innovation, ecosystem |
| [judge-faq.md](judge-faq.md) | thirteen questions answered against the repository, not against the pitch |
| [../evidence/final-release.json](../evidence/final-release.json) | commit, test counts, build state, and what production answered when asked |
| [../evidence/final-proof.json](../evidence/final-proof.json) | one order walked end to end, from the same run `/proof` publishes |

**Live:** https://rivo-autopilot.vercel.app

## Regenerating the evidence

```bash
npm test                                  # exact counts
npm run final-proof -- --portfolio <id>   # one order, from a deployment run
npm run release                           # commit, counts, and a live production probe
```

`npm run release` re-reads production rather than asserting it, so a stale claim in
`final-release.json` shows up as a changed number rather than as a document nobody checked.

## Before recording

1. `npm run release` — confirm pages and APIs answer 200 and a worker is live.
2. Re-read the calibration and shadow numbers off the screen. The worker keeps computing; the values
   in the script were true when it was written and will have moved.
3. Confirm `/proof` is not showing an empty state. If it is, `RIVO_DEMO_PORTFOLIO_ID` is unset on the
   deployment — see the blocker note in the release artefact.
