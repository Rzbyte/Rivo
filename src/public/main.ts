// Rivo, in the browser.
//
// Four routes over one engine. `/` is the product, `/app` is the portfolio,
// `/explorer` is the pricing surface, `/evidence` is the record. Hash routing,
// because the whole point is that this deploys as static files anywhere — a path
// router would need server rewrites and would break the single-file build.
//
// The cycle is the heart of it: every CYCLE_MS the engine runs a full pass
// against the live venue — settle, discover, price, allocate — and the render is
// a pure function of what came back. There is no incremental DOM state to get
// out of sync with the portfolio, which at this size is worth far more than the
// re-render costs.

import { Indexer } from "../core/indexer.js";
import { collateralName, gasTokenName } from "../core/venue.js";
import { runCycle, emptyPortfolio, type Activity, type PortfolioView, type ShadowPortfolio } from "./engine.js";
import { snapshot, type Snapshot } from "../engine/scan.js";
import { newPolicy, type PortfolioPolicy, type RunMode } from "../portfolio/policy.js";
import { modeIntendsExecution } from "../runtime/permission.js";
import type { ProfileName } from "../portfolio/profiles.js";
import {
  connect, detectProvider, readWallet, silentAccounts, switchNetwork, WalletError,
  type Eip1193Provider, type WalletState,
} from "./wallet.js";
import { autopilotBlocker, discover, type BackendStatus } from "./backend.js";
import * as store from "./store.js";
import { esc, mount, onAction } from "./ui/dom.js";
import { connectGate, configure, dashboard, walletChip, type AppState } from "./ui/portfolio.js";
import { landing } from "./ui/landing.js";
import { explorer } from "./ui/explorer.js";
import { evidence, type EvidenceBundle } from "./ui/evidence.js";

const CYCLE_MS = 30_000;

type Route = "home" | "app" | "explorer" | "evidence";

const state: AppState & {
  route: Route;
  portfolio: ShadowPortfolio | null;
  preview: PortfolioView | null;
  /** Why the last venue read failed, so every route can say so rather than one. */
  venueError: string | null;
  venueErrorAt: number;
} = {
  route: "home",
  wallet: null,
  connecting: false,
  error: null,
  policy: null,
  portfolio: null,
  view: null,
  preview: null,
  backend: null,
  draft: { capital: 50, profile: "balanced", mode: "shadow" },
  busy: false,
  showAdvanced: false,
  equity: [],
  activity: [],
  venueError: null,
  venueErrorAt: 0,
};

const idx = new Indexer();
let provider: Eip1193Provider | null = null;
let explorerSnap: Snapshot | null = null;
let evidenceBundle: EvidenceBundle | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

// ------------------------------------------------------------------- routing

const routeOf = (hash: string): Route => {
  const h = hash.replace(/^#\/?/, "").split("?")[0];
  return h === "app" || h === "portfolio" ? "app" : h === "explorer" ? "explorer" : h === "evidence" ? "evidence" : "home";
};

function nav(): string {
  const links: [Route, string, string][] = [
    ["home", "#/", "Rivo"],
    ["app", "#/app", "Portfolio"],
    ["explorer", "#/explorer", "Explorer"],
    ["evidence", "#/evidence", "Evidence"],
  ];
  return `
    <a class="brand" href="#/"><span class="brand-dot"></span>Rivo</a>
    <div class="nav-links">
      ${links
        .slice(1)
        .map(([r, href, label]) => `<a href="${href}" ${state.route === r ? 'aria-current="page"' : ""}>${label}</a>`)
        .join("")}
      <a href="https://github.com/Rzbyte/Rivo" target="_blank" rel="noopener">GitHub ↗</a>
    </div>
    <div class="nav-right">${walletChip(state)}</div>`;
}

function render(): void {
  const navEl = document.getElementById("nav");
  if (navEl) navEl.innerHTML = nav();

  switch (state.route) {
    case "app":
      if (!state.wallet) return mount(connectGate(state));
      if (!state.policy || state.policy.state === "idle" || state.policy.state === "stopped") return mount(configure(state));
      return mount(dashboard(state));
    case "explorer":
      return mount(explorer(explorerSnap, state.wallet?.network ?? "testnet", state.venueError, state.venueErrorAt));
    case "evidence":
      return mount(evidence(evidenceBundle ?? { calibration: null, backtest: null, coherence: null, maker: null, canary: null }));
    default:
      return mount(
        landing({
          preview: state.preview,
          evidence: evidenceBundle?.calibration
            ? {
                auc: evidenceBundle.calibration.holdout.auc,
                brier: evidenceBundle.calibration.holdout.brier,
                skill: 1 - evidenceBundle.calibration.holdout.brier / evidenceBundle.calibration.holdout.brierCoin,
                n: evidenceBundle.calibration.sample.forecasts,
              }
            : null,
          connected: Boolean(state.wallet),
          error: state.venueError,
          errorAt: state.venueErrorAt,
        }),
      );
  }
}

// -------------------------------------------------------------------- wallet

async function refreshWallet(address: `0x${string}`): Promise<void> {
  if (!provider) return;
  try {
    state.wallet = await readWallet(provider, address);
    state.error = state.wallet.network === null ? "This wallet is not on a Somnia network." : null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
}

async function doConnect(): Promise<void> {
  provider ??= detectProvider();
  if (!provider) {
    state.error = "NO_PROVIDER";
    return render();
  }
  state.connecting = true;
  state.error = null;
  render();
  try {
    const address = await connect(provider);
    // Carry a demo portfolio across, so "connect a wallet later" keeps what the
    // person built instead of silently swapping it for an empty namespace.
    const previous = state.wallet?.address;
    if (previous && store.isDemo(previous)) store.adoptInto(previous, address);
    store.rememberWallet(address);
    await refreshWallet(address);
    adoptWallet(address);
  } catch (e) {
    state.error = e instanceof WalletError ? e.message : String(e);
  } finally {
    state.connecting = false;
    render();
  }
}

/** Load this wallet's saved policy and portfolio, or seed a draft from defaults. */
function adoptWallet(address: string): void {
  const policy = store.loadPolicy(address);
  state.policy = policy;
  if (policy) {
    state.portfolio = store.loadPortfolio(address, policy);
    state.draft = { capital: policy.capital, profile: policy.profile, mode: policy.mode };
    state.activity = store.loadActivity(address);
    rebuildEquity();
  } else {
    state.portfolio = null;
    state.activity = [];
    state.equity = [];
  }
}

// ------------------------------------------------------------------- the loop

/** Equity through time, reconstructed from settled positions — no extra persistence. */
function rebuildEquity(): void {
  const pf = state.portfolio;
  const policy = state.policy;
  if (!pf || !policy) return (state.equity = []), undefined;
  let equity = policy.capital;
  const series = [{ t: pf.startedAt, equity }];
  for (const c of [...pf.closed].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += c.proceeds - c.cost;
    series.push({ t: c.closedAt, equity });
  }
  if (state.view) series.push({ t: state.view.at, equity: state.view.equity });
  state.equity = series;
}

async function tick(): Promise<void> {
  try {
    // One scan per route, never two. The landing page used to take a snapshot
    // for itself AND run a preview cycle that took another, so the hero waited
    // out two full passes over the venue before it could render anything.
    if (state.route === "explorer") explorerSnap = await snapshot(idx);
    if (state.route === "home") await previewCycle();
    if (state.policy && state.portfolio && state.policy.state !== "idle" && state.policy.state !== "stopped") {
      const view = await runCycle(idx, state.policy, state.portfolio);
      state.view = view;
      store.savePortfolio(state.portfolio);
      state.activity = store.appendActivity(state.policy.owner, view.activity as Activity[]);
      rebuildEquity();
    }
    // A pass that got all the way here reached the venue, so any previous
    // failure is over. Clearing it here rather than at the top means a route
    // that reads nothing cannot clear an error it never re-tested.
    state.venueError = null;
  } catch (e) {
    // A failed cycle must not stop the loop: the venue rolls markets constantly
    // and a transient read failure is expected, not exceptional.
    const message = e instanceof Error ? e.message : String(e);
    // The activity feed only appears on the dashboard. The landing page and the
    // explorer showed "reading the live venue…" indefinitely instead, which is
    // indistinguishable from a hung page — and the landing page is the first
    // thing anyone sees.
    state.venueError = message;
    state.venueErrorAt = Math.floor(Date.now() / 1000);
    state.activity = [
      { at: Math.floor(Date.now() / 1000), kind: "info", text: `cycle failed: ${message}` },
      ...state.activity,
    ].slice(0, 300);
  }
  render();
  schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), CYCLE_MS);
}

/**
 * A throwaway balanced portfolio, run once, so the landing page shows a real
 * allocation rather than a description of one. It holds nothing between cycles —
 * the point is the decisions, not the P&L.
 */
async function previewCycle(): Promise<void> {
  const demo: PortfolioPolicy = {
    ...newPolicy("0x0000000000000000000000000000000000000000", 50, "balanced"),
    state: "running",
  };
  const pf = emptyPortfolio(demo);
  state.preview = await runCycle(idx, demo, pf);
}

// ------------------------------------------------------------------ commands

function persistPolicy(next: PortfolioPolicy): void {
  state.policy = next;
  store.savePolicy(next);
}

function startRivo(): void {
  const w = state.wallet;
  if (!w) return;
  const policy = store.configure(w.address, {
    capital: state.draft.capital,
    profile: state.draft.profile,
    mode: state.draft.mode,
  });
  persistPolicy({ ...policy, state: "running" });
  store.savePolicy(state.policy!);
  state.portfolio = store.loadPortfolio(w.address, state.policy!);
  state.busy = true;
  render();
  void tick().finally(() => {
    state.busy = false;
    render();
  });
}

onAction((act, el) => {
  switch (act) {
    case "connect":
      return void doConnect();
    case "demo": {
      // A portfolio with no wallet behind it. Everything downstream treats the
      // identity as an address, so nothing needs a special case — only the
      // header, which says plainly that these are not real balances.
      const owner = store.demoIdentity();
      state.wallet = {
        address: owner, chainId: 0, network: "testnet", gas: 0, collateral: 0,
        gasSymbol: gasTokenName("testnet"), collateralSymbol: collateralName("testnet"),
      };
      state.error = null;
      adoptWallet(owner);
      return render();
    }
    case "retry":
      state.venueError = null;
      render();
      return void tick();
    case "disconnect": {
      // Two different actions behind one button, because to the person clicking
      // it they are the same gesture: "get me out of this". For a real wallet it
      // is forgetting — the address still exists and its policy waits for the
      // next visit. For a demo identity it is discarding, because a local
      // portfolio nobody can reconnect to would otherwise be unreachable
      // forever while still occupying storage.
      const owner = state.wallet?.address;
      if (owner && store.isDemo(owner)) store.forgetIdentity(owner);
      store.forgetWallet();
      state.wallet = null;
      state.policy = null;
      state.portfolio = null;
      state.view = null;
      state.activity = [];
      state.equity = [];
      return render();
    }
    case "switch":
      return void (async () => {
        if (!provider) return;
        try {
          await switchNetwork(provider, "testnet");
          const a = await silentAccounts(provider);
          if (a) await refreshWallet(a);
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
        render();
      })();
    case "profile":
      state.draft.profile = el.dataset.v as ProfileName;
      return render();
    case "mode": {
      const mode = el.dataset.v as RunMode;
      const blocker = modeIntendsExecution(mode) ? autopilotBlocker(state.backend) : null;
      if (blocker) {
        state.error = blocker;
        return render();
      }
      state.draft.mode = mode;
      state.error = null;
      return render();
    }
    case "start":
      readDraft();
      return startRivo();
    case "pause":
      if (state.policy) persistPolicy({ ...state.policy, state: "paused" });
      return render();
    case "resume":
      if (state.policy) persistPolicy({ ...state.policy, state: "running" });
      return void tick();
    case "stop":
      if (state.policy) persistPolicy({ ...state.policy, state: "stopped", stoppedReason: "stopped by you" });
      state.view = null;
      return render();
    default:
      return;
  }
});

/** Pull the configuration form into the draft before starting. */
function readDraft(): void {
  const capEl = document.querySelector<HTMLInputElement>('[data-input="capital"]');
  const capital = Number(capEl?.value);
  if (Number.isFinite(capital) && capital > 0) state.draft.capital = capital;
}

// --------------------------------------------------------------------- boot

async function loadEvidence(): Promise<void> {
  const one = async <T>(name: string): Promise<T | null> => {
    try {
      const res = await fetch(`${name}.json`);
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [calibration, backtest, coherence, maker, canary] = await Promise.all([
    one<EvidenceBundle["calibration"]>("calibration"),
    one<EvidenceBundle["backtest"]>("backtest"),
    one<EvidenceBundle["coherence"]>("coherence"),
    one<EvidenceBundle["maker"]>("maker-live"),
    one<EvidenceBundle["canary"]>("live-canary"),
  ]);
  evidenceBundle = { calibration, backtest, coherence, maker, canary } as EvidenceBundle;
}

async function boot(): Promise<void> {
  state.route = routeOf(location.hash);
  render();

  window.addEventListener("hashchange", () => {
    state.route = routeOf(location.hash);
    render();
    void tick();
  });

  provider = detectProvider();
  if (provider) {
    // Restore a prior session without prompting. A page that opens a wallet
    // popup on load is a page people close.
    const remembered = store.lastWallet();
    const account = await silentAccounts(provider);
    if (account && (!remembered || remembered === account)) {
      await refreshWallet(account);
      adoptWallet(account);
    }
    provider.on?.("accountsChanged", (...args) => {
      const next = (args[0] as string[] | undefined)?.[0]?.toLowerCase();
      if (!next) {
        state.wallet = null;
        state.policy = null;
        state.portfolio = null;
      } else {
        store.rememberWallet(next);
        void refreshWallet(next as `0x${string}`).then(() => adoptWallet(next));
      }
      render();
    });
    provider.on?.("chainChanged", () => {
      if (state.wallet) void refreshWallet(state.wallet.address).then(render);
    });
  }

  render();

  // Start the venue scan IMMEDIATELY, and let the evidence files and the backend
  // probe resolve alongside it. Awaiting them first cost the landing page
  // several seconds before its first request even went out — the backend probe
  // in particular walks localhost candidates that are absent for every visitor
  // who is not running Rivo locally, and none of it is needed to render the hero.
  const scanning = tick();
  void loadEvidence().then(render);
  void discover().then((b) => {
    state.backend = b;
    render();
  });
  await scanning;
}

void boot().catch((e) => {
  mount(`<div class="wrap"><p class="note warn">Rivo failed to start: ${esc(e instanceof Error ? e.message : String(e))}</p></div>`);
});
