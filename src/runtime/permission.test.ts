// The execution gate, exercised exhaustively.
//
// This is the file that has to be paranoid. Everything else in the repository
// can be wrong and cost a bad trade; this can be wrong and cost somebody's
// balance to a strategy that the same repository's evidence says loses money.
//
// So the tests below are written as a truth table rather than as scenarios, and
// the default assertion is DENIAL. A permission that appears where the table
// does not predict one is the bug this file exists to catch.

import { describe, expect, it } from "vitest";
import {
  EXECUTION_MODES,
  executionPermission,
  isExecutionMode,
  MODE_LABEL,
  type ExecutionMode,
  type PermissionInput,
  type StrategyIdentity,
} from "./permission.js";
import { PRODUCTION_STRATEGY, type StrategyState } from "../research/gating.js";

const strategy = (state: StrategyState): StrategyIdentity => ({ id: "s", label: "S", state });

/** Everything an execution needs, so each test can remove exactly one thing. */
const ok = (over: Partial<PermissionInput> = {}): PermissionInput => ({
  mode: "validated_autopilot",
  strategy: strategy("VALIDATED"),
  network: "testnet",
  signerAvailable: true,
  delegated: true,
  privyWalletId: "wallet-1",
  ...over,
});

describe("the happy path exists at all", () => {
  it("permits a validated strategy under Autopilot with a signer", () => {
    const p = executionPermission(ok());
    expect(p.reasons).toEqual([]);
    expect(p.mayMoveCapital).toBe(true);
  });

  it("permits a rejected strategy under Experimental Testnet on a testnet", () => {
    // The hackathon path, and the ONLY way a non-validated strategy trades.
    const p = executionPermission(ok({ mode: "experimental_testnet", strategy: strategy("REJECTED") }));
    expect(p.reasons).toEqual([]);
    expect(p.mayMoveCapital).toBe(true);
    expect(p.summary).toMatch(/testnet/i);
  });
});

describe("strategy state under Autopilot", () => {
  const cases: [StrategyState, string][] = [
    ["REJECTED", "STRATEGY_REJECTED"],
    ["UNVALIDATED", "STRATEGY_UNVALIDATED"],
    ["SHADOW_ONLY", "SHADOW_ONLY"],
  ];
  for (const [state, reason] of cases) {
    it(`${state} cannot move capital under validated_autopilot`, () => {
      const p = executionPermission(ok({ strategy: strategy(state) }));
      expect(p.mayMoveCapital).toBe(false);
      expect(p.reasons).toContain(reason);
    });
  }

  it("VALIDATED is the only state Autopilot accepts", () => {
    const permitted = (["UNVALIDATED", "SHADOW_ONLY", "VALIDATED", "REJECTED"] as StrategyState[]).filter(
      (s) => executionPermission(ok({ strategy: strategy(s) })).mayMoveCapital,
    );
    expect(permitted).toEqual(["VALIDATED"]);
  });
});

describe("shadow", () => {
  it("blocks in shadow mode whatever the strategy says", () => {
    for (const s of ["UNVALIDATED", "SHADOW_ONLY", "VALIDATED", "REJECTED"] as StrategyState[]) {
      const p = executionPermission(ok({ mode: "shadow", strategy: strategy(s) }));
      expect(p.mayMoveCapital, `shadow + ${s}`).toBe(false);
      expect(p.reasons).toContain("MODE_IS_SHADOW");
    }
  });

  it("a SHADOW_ONLY strategy cannot spend in any mode or network", () => {
    for (const mode of EXECUTION_MODES) {
      for (const network of ["testnet", "mainnet", "somethingelse"]) {
        const p = executionPermission(ok({ mode, network, strategy: strategy("SHADOW_ONLY") }));
        expect(p.mayMoveCapital, `${mode} on ${network}`).toBe(false);
      }
    }
  });
});

describe("experimental testnet is bounded by network", () => {
  it("cannot activate on mainnet", () => {
    const p = executionPermission(ok({ mode: "experimental_testnet", network: "mainnet", strategy: strategy("REJECTED") }));
    expect(p.mayMoveCapital).toBe(false);
    expect(p.reasons).toContain("NETWORK_NOT_APPROVED_FOR_EXPERIMENTAL");
  });

  it("cannot activate on an unknown network", () => {
    // Membership in a list, not a negation of "mainnet" — a typo must fail the
    // test rather than pass a `!== "mainnet"` check.
    for (const network of ["", "  ", "devnet", "Testnet", "TESTNET", "localhost", null, undefined, 5031, {}]) {
      const p = executionPermission(ok({ mode: "experimental_testnet", network, strategy: strategy("REJECTED") }));
      expect(p.mayMoveCapital, `network ${JSON.stringify(network)}`).toBe(false);
    }
  });

  it("an UNVALIDATED strategy needs an explicit opt-in as well", () => {
    const base = { mode: "experimental_testnet" as const, strategy: strategy("UNVALIDATED") };
    expect(executionPermission(ok(base)).mayMoveCapital).toBe(false);
    expect(executionPermission(ok(base)).reasons).toContain("EXPERIMENTAL_NOT_CONFIGURED");
    expect(executionPermission(ok({ ...base, allowUnvalidatedExperimental: true })).mayMoveCapital).toBe(true);
    // Only `true`. A truthy string must not be enough.
    for (const v of ["true", 1, {}, [] as unknown]) {
      expect(executionPermission(ok({ ...base, allowUnvalidatedExperimental: v as boolean })).mayMoveCapital).toBe(false);
    }
  });

  it("does not need an opt-in for a strategy that was actually evaluated", () => {
    expect(executionPermission(ok({ mode: "experimental_testnet", strategy: strategy("REJECTED") })).mayMoveCapital).toBe(true);
  });
});

describe("fail closed", () => {
  it("denies when the mode is unrecognised", () => {
    for (const mode of ["autopilot", "live", "", null, undefined, 1, {}]) {
      const p = executionPermission(ok({ mode }));
      expect(p.mayMoveCapital, `mode ${JSON.stringify(mode)}`).toBe(false);
      expect(p.reasons).toContain("MODE_UNKNOWN");
    }
    // `autopilot` in particular: the pre-migration value must NOT be honoured
    // as live execution by a build that no longer knows what it meant.
    expect(executionPermission(ok({ mode: "autopilot" })).mayMoveCapital).toBe(false);
  });

  it("denies when there is no strategy identity or verdict", () => {
    for (const s of [null, undefined, { id: "", label: "x", state: "VALIDATED" } as StrategyIdentity]) {
      const p = executionPermission(ok({ strategy: s }));
      expect(p.mayMoveCapital).toBe(false);
      expect(p.reasons).toContain("STRATEGY_UNKNOWN");
    }
  });

  it("denies when the network cannot be established", () => {
    for (const n of [null, undefined, "", "   ", 50312]) {
      const p = executionPermission(ok({ network: n }));
      expect(p.mayMoveCapital, `network ${JSON.stringify(n)}`).toBe(false);
      expect(p.reasons).toContain("NETWORK_UNKNOWN");
    }
  });

  it("denies without a signer, and without a delegation", () => {
    expect(executionPermission(ok({ signerAvailable: false })).reasons).toContain("SIGNER_UNAVAILABLE");
    expect(executionPermission(ok({ delegated: false })).reasons).toContain("DELEGATION_MISSING");
    expect(executionPermission(ok({ privyWalletId: null })).reasons).toContain("DELEGATION_MISSING");
    expect(executionPermission(ok({ privyWalletId: "" })).reasons).toContain("DELEGATION_MISSING");
  });

  it("reports every missing thing, not just the first", () => {
    const p = executionPermission({
      mode: "nonsense", strategy: null, network: null,
      signerAvailable: false, delegated: false, privyWalletId: null,
    });
    expect(p.mayMoveCapital).toBe(false);
    for (const r of ["MODE_UNKNOWN", "STRATEGY_UNKNOWN", "NETWORK_UNKNOWN", "SIGNER_UNAVAILABLE", "DELEGATION_MISSING"]) {
      expect(p.reasons).toContain(r);
    }
  });

  it("an empty input denies", () => {
    const p = executionPermission({} as PermissionInput);
    expect(p.mayMoveCapital).toBe(false);
    expect(p.reasons.length).toBeGreaterThan(0);
  });
});

describe("the whole truth table", () => {
  it("permits exactly the combinations the design allows", () => {
    const states: StrategyState[] = ["UNVALIDATED", "SHADOW_ONLY", "VALIDATED", "REJECTED"];
    const networks = ["testnet", "mainnet"];
    const permitted: string[] = [];
    for (const mode of EXECUTION_MODES) {
      for (const state of states) {
        for (const network of networks) {
          if (executionPermission(ok({ mode, strategy: strategy(state), network })).mayMoveCapital) {
            permitted.push(`${mode}/${state}/${network}`);
          }
        }
      }
    }
    expect(permitted.sort()).toEqual([
      "experimental_testnet/REJECTED/testnet",
      "experimental_testnet/VALIDATED/testnet",
      "validated_autopilot/VALIDATED/mainnet",
      "validated_autopilot/VALIDATED/testnet",
    ]);
  });

  it("nothing at all is permitted on mainnet except a validated strategy", () => {
    const onMainnet = EXECUTION_MODES.flatMap((mode) =>
      (["UNVALIDATED", "SHADOW_ONLY", "VALIDATED", "REJECTED"] as StrategyState[])
        .filter((state) => executionPermission(ok({ mode, strategy: strategy(state), network: "mainnet" })).mayMoveCapital)
        .map((state) => `${mode}/${state}`),
    );
    expect(onMainnet).toEqual(["validated_autopilot/VALIDATED"]);
  });
});

describe("the production strategy", () => {
  it("is REJECTED, and the gate refuses it real capital", () => {
    expect(PRODUCTION_STRATEGY.state).toBe("REJECTED");
    const p = executionPermission(ok({ strategy: PRODUCTION_STRATEGY, mode: "validated_autopilot" }));
    expect(p.mayMoveCapital).toBe(false);
    expect(p.reasons).toContain("STRATEGY_REJECTED");
  });

  it("may still run on testnet, explicitly", () => {
    expect(executionPermission(ok({ strategy: PRODUCTION_STRATEGY, mode: "experimental_testnet" })).mayMoveCapital).toBe(true);
  });

  it("quotes numbers that exist in the repository's own evidence", () => {
    // The brief that asked for this gate quoted an AUC of 0.8305. The measured
    // value in docs/evidence/calibration.json is 0.8158, and the artefact wins.
    expect(PRODUCTION_STRATEGY.auc).toBeCloseTo(0.8158, 4);
    expect(PRODUCTION_STRATEGY.returnOnStake).toBeLessThan(0);
  });

  it("says plainly that accuracy is not permission", () => {
    expect(PRODUCTION_STRATEGY.note).toMatch(/not sufficient for live-capital/i);
  });
});

describe("labels", () => {
  it("names every mode", () => {
    for (const m of EXECUTION_MODES) expect(MODE_LABEL[m as ExecutionMode]).toBeTruthy();
  });
  it("recognises exactly the three modes", () => {
    expect(EXECUTION_MODES.filter(isExecutionMode)).toEqual([...EXECUTION_MODES]);
    for (const v of ["autopilot", "live", "", null, 3]) expect(isExecutionMode(v)).toBe(false);
  });
});
