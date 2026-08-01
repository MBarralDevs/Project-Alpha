# S5 — platform outflow ceiling + money-path observability

*Spec 2026-08-01. The last CRITICAL-class item from the pre-hackathon V2 security audit that is
buildable today (S3/S4 fold into the Tier-0 smart-account migration; S1 closed by #38, S2 interim
by #39). Hermetic — needs neither Turnkey signing nor World sandbox.*

## The two gaps

1. **No aggregate brake.** S1 caps `fund_treasury` per call (25) and per tenant lifetime (100).
   S2 caps each agent's standing float (1.00). But nothing bounds the platform wallet's TOTAL
   outflow per unit time across all paths and all tenants: N tenants × 100 is unbounded by N, and
   gas seeds + the operator CLI move platform funds outside every existing cap. A runaway loop or
   a leaked provision key drains at wire speed until a human notices — and today nothing would
   make a human notice.
2. **No decision trail.** The backend logs nothing per request. This cost us twice in one week,
   measured: the World verify failure was undiagnosable until #58 added `logWorldRejection`, and
   the Turnkey quota exhaustion had no usage history to reconstruct. Every money decision
   (accept AND reject) must leave a line in journald.

## Design

### 1. Aggregate outflow meter (fail-closed brake)

- **Table** `platform_outflows(id, at, path, amount, ref)` — one row per platform-wallet outflow;
  additive migration. Paths: `fund_treasury`, `gas_seed`, `cli_fund`.
- **Recorded at the existing choke points**, not new ones: `runner.fund` (covers REST + MCP),
  the gas-seed sender, and the operator CLI (see 3).
- **Ceiling**: `PLATFORM_OUTFLOW_CEILING_USDC` per rolling `PLATFORM_OUTFLOW_WINDOW_HOURS`
  (defaults **200 USDC / 24 h** — ~17× the busiest real day so far; env-overridable; boot
  invariant: ceiling ≥ MAX_TREASURY_FUND_USDC so a single legal call can never be auto-blocked).
  Exceeding it rejects with `platform-outflow-ceiling` — same reject-don't-clamp discipline as S2.
- **Window query** is `SUM(amount) WHERE at > now - window` — no counters to reset, no cron.

### 2. Structured money-path logging

- Tiny `opsLog(event, fields)` helper: one JSON line to stdout → journald (no new infra; grep is
  the v1 alerting). Same redaction discipline as `env.ts` — amounts/paths/reasons/ids, never keys.
- Emitted on: fund accepted/rejected (with reason + running window total), pay policy denials
  (incl. the new seller-trust reasons), ceiling hits, sweep runs, World rejections (existing
  `logWorldRejection` becomes a caller of this).

### 3. Route the operator CLI through `runner.fund`

The CLI currently calls `arc.fundTreasury` directly — outside S1's caps and outside this meter
(the fast-follow #38 documented). It becomes a `runner.fund` caller like every other surface;
the trusted operator can still raise env caps deliberately, but no path is silently uncapped.

## Out of scope

External alerting/dashboards (journald + grep first; revisit with real traffic) · S3 (pocket
master seed) and S4 (platform key overload) → Tier-0 smart-account migration · per-tenant rate
limits beyond S1's lifetime quota.

## Test plan (TDD + mutation, house method)

Failing-first: window math (in/out of window, boundary), ceiling reject at exactly ceiling+1,
gas-seed and CLI paths metered (call-counted fakes), boot invariant, log lines emitted on
accept AND reject with secrets absent. Mutations: drop the window filter (lifetime sum),
skip the gas-seed recording, log only rejections — each must fail a named test.
