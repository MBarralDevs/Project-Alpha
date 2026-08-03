# Tier-0: Circle wallet migration — Phase-0 research findings & design

*2026-08-03. Deep-research phase of the smart-account migration: three parallel investigations
(Circle DevC/Gas Station capabilities on Arc · signature-compatibility of every off-chain verifier
· exhaustive codebase EOA-surface map), load-bearing claims re-verified first-hand against
Circle's docs, the SDKs in our node_modules, and our contracts. Vivienne (Circle) confirmed in
writing: smart accounts + Gas Station live on Arc testnet today, Arc mainnet day-1 with DevC;
Circle's policy engine is still in customer discovery (NOT built).*

## The decisive findings (each verified, not just reported)

1. **The pocket CANNOT become a smart account. Blocked by Circle's own Gateway design.**
   Gateway verifies signatures statically off-chain: *"only EOA signatures are accepted"* (their
   technical guide, verbatim; re-fetched). The x402 batched `TransferWithAuthorization` struct has
   no signer/delegate field (verified in `@circle-fin/x402-batching` dist), so the signature must
   recover to the depositor. ERC-1271 is explicitly ruled out. The `addDelegate` escape applies
   to burn intents only, not the x402 scheme.
2. **The operator CAN become a smart account, today.** Every operator surface is an on-chain
   transaction (`msg.sender`); AgentTreasury/LegalManager/Factory contain zero `ecrecover`, zero
   `tx.origin` — pure `msg.sender` roles (verified by grep). The single signature-shaped surface
   is the one-time ERC-8004 `setAgentWallet` bind: our mock mirrors a live ERC-1271 fallback but
   it is UNPROVEN against the live registry → either prove with one fork test or sidestep (bind
   before rotating).
3. **Circle DevC on Arc is real and priced per-wallet, not per-signature.** `ARC-TESTNET` enum
   with EOA ✅ / SCA ✅ / MSCA ✅ (docs table, re-fetched); SCA = ERC-6900 v0.7 / 4337 v0.6,
   UUPS-upgradeable, on-chain ERC-1271 (`SingleOwnerMSCA`). Pricing (re-fetched from
   circle.com/wallets): first **1,000 monthly-active wallets free**, then cents/wallet;
   **no per-signature fees anywhere**; Gas Station = sponsored gas at cost + 5%. This
   categorically ends the Turnkey 25-signatures/month problem for whatever migrates.
4. **AgentKit (World) proofs are SCA-friendly** — seller-side verification is viem
   `publicClient.verifyMessage` (ERC-6492/1271-aware; the SDK's own error text names ERC-1271).
   AgentBook is address-keyed, no EOA assumption on lookup.
5. **Weak spots in Circle's offer today:** DevC's REST API is single-call (no first-class batch
   UserOps — that's the separate Modular Wallets SDK); Gas Station policies are coarse
   (network-level USD caps, no contract allowlists, no per-wallet limits); SCA wallets have a
   documented 1-in-flight-tx queue on listed chains (Arc unlisted); the policy engine is unbuilt.

## The design

### Target architecture (per agent)

| role | today | target | why |
|---|---|---|---|
| operator | Turnkey sub-org EOA (passkey-rooted, metered sigs) | **Circle DevC SCA** (`ARC-TESTNET`, Gas Station) | all surfaces msg.sender; gasless kills operator gas-seeding; no per-sig cost |
| pocket | EOA derived from ONE master seed (S3!) | **Circle DevC EOA** (per-agent, MPC-held) | Gateway demands EOA signatures; a DevC EOA signs plain ECDSA via Circle's `sign/typedData` API → Gateway-compatible, and the master seed dies |
| treasury / LegalManager | our Foundry contracts | **unchanged** | they are the policy layer — Circle's policy engine doesn't exist yet |
| platform/manager | one key, many hats (S4) | phase-split: `JOB_CLIENT`/`CUSTOMER` stop defaulting to the platform key now; manager/factory-owner EOA unchanged this tier (beacon/multisig later) | cheap, immediate risk reduction |

### The new funding flow — and everything it deletes

Target bridge: `treasury.fundOperator` → **operator SCA (gasless)** → `GatewayWallet.depositFor(usdc, pocketEOA, amount)`.

`depositFor` (verified in the Gateway ABI) lets anyone credit any depositor — so the **pocket EOA
never holds on-chain funds and never sends a transaction at all**. It only signs off-chain: x402
payment authorizations and burn intents. Consequences, each currently a real subsystem:

- **gas seeder dies** (operator is gasless via Gas Station; pocket never transacts)
- **pocket sweeps die** (nothing ever rests on the pocket EOA)
- **standing exposure simplifies** to Gateway balance + SCA balance
- **the `USDC_TRANSFER_GAS` estimate-gas footgun class dies** for migrated legs (UserOps, not EOA sends)
- **`POCKET_MASTER_SEED` dies** → S3 closed
- **Turnkey signing (and its per-signature bill) exits the hot path** → the meter we just built
  becomes the tool that proves spend went to zero
- the bridge's 2 Turnkey signatures become API calls with no marginal cost

Note the SDK reality: `GatewayClient`/`BatchEvmScheme` are constructed from a raw private key, so
the pocket's Circle-EOA integration replaces them with our own thin client: deposits happen via
the operator SCA (`depositFor`), x402/burn-intent typed data is signed through Circle's
`sign/typedData` endpoint behind our existing `signX402`/signer seam (which is already
injectable — verified).

### What this migration honestly does NOT do

- **S2 stays interim.** With Circle's policy engine unbuilt and Gas Station policies coarse, the
  smart account does not yet enforce our allowlist/caps on-chain. Policy remains: treasury
  contract (hard) + backend gates (S1/S5/software). Full S2 closure returns when Circle ships
  policy controls (we are offered as design partner) or if custom ERC-6900 modules become
  installable on their accounts (not documented today). *This corrects an earlier optimistic
  framing — the migration's security wins are S3 + S4 + blast-radius, not S2-full.*
- **Custody story shifts for the hot layer**: Turnkey's guardian-passkey-rooted sub-orgs give way
  to platform-controlled Circle wallets (entity secret). Guardian sovereignty remains anchored
  on-chain (guardian role, `setOperator`, clawback) + `root_passkey_id` (#67) + World personhood
  — but the design must state the shift plainly. Self-sovereign hot wallets = Model B (Circle
  user-controlled), later.

### Migration mechanics for existing agents (the contracts already have the hook)

`AgentTreasury.setOperator(newOperator)` is `onlyGuardian` (verified) — operator rotation is a
first-class on-chain action. Per agent: (1) provision Circle SCA+EOA; (2) drain old float
(`cli:sweep`, proven live); (3) guardian signs `setOperator(newSCA)`; (4) re-bind ERC-8004 wallet
(sign `AgentWalletSet` with the OLD Turnkey EOA before rotation — sidesteps the unproven 1271
path — or prove 1271 first); (5) flip the entity's `walletProvider` column. New pocket address
means AgentBook re-registration for human-backing — cheap today (none of our agents' pockets are
registered; only the standalone proof-demo key is).

## Phased plan

- **P1 — build (hermetic, 0 sigs, 0 spend):** `adapters/circle/` (DevC client, wallet-set/create,
  `signTypedData`/`signMessage`/`contractExecution` wrappers satisfying our existing signer +
  wallet seams); `entities.wallet_provider` column (`turnkey` | `circle`, default `turnkey` — the
  flag that makes every later step reversible); parallel composition path. TDD + mutation, house
  method; spec audit before code.
- **P2 — one testnet experiment** (resolves the cheap unknowns in one sitting): create 1 SCA + 1
  EOA on `ARC-TESTNET`; read `scaCore`; Gas Station sponsorship on Arc's USDC-native gas; 1271
  `isValidSignature` (incl. counterfactual); signature FORMAT from `sign/typedData` on the EOA
  (plain ECDSA? → Gateway `/v1/x402/verify` accepts?); SCA queue behavior; `depositFor` leg;
  live-registry `setAgentWallet` 1271 fork test.
- **P3 — first migrated agent end-to-end** on the flag (a fresh test agent, then one existing via
  the rotation runbook). Compare: bridge legs, signature spend (meter says 0 Turnkey), gas cost.
- **P4 — default flip for new onboarding; migrate the fleet; retire** gasSeeder/pocketFloat/
  master-seed surfaces + Turnkey adapters (keep-or-kill decision on Turnkey per the guardian
  custody story). S4 split (`JOB_CLIENT`/`CUSTOMER` keys) can ship independently and early — small PR.

## Open questions (owners assigned)

**For Vivienne:** (1) EntryPoint/bundler specifics on Arc + current default `scaCore` there;
(2) Gas Station on a USDC-native-gas chain — the paymaster simply pays USDC, 5% on that?
(3) can `contractExecution.callData` target the SCA's own `executeBatch` (atomic multicall)?
(4) SCA in-flight queue limit on Arc; (5) policy-engine design-partner follow-up (already
offered); (6) mainnet "ARC" activation timing. **For the P2 experiment:** counterfactual 1271,
sign/typedData signature format vs Gateway verify, live-registry 1271 fallback. **Design
decision pending:** EIP-7702 on Arc (would give the pocket EOA smart-account powers without
breaking Gateway — their docs explicitly bless 7702-upgraded EOAs) — ask both Vivienne and Arc.

## Sources

Gateway technical guide (EOA-only, delegates, 7702 note) · circle.com/wallets pricing ·
developers.circle.com: supported-blockchains, gas-station, policy-management, wallet-upgrades,
account-types, transaction-limits, api-rate-limits, DevC OpenAPI · circlefin/buidl-wallet-contracts
(`SingleOwnerMSCA`) · docs.arc.io AA providers · our node_modules (`@circle-fin/x402-batching`,
`@worldcoin/agentkit-core`) · our contracts (`AgentTreasury.sol`, `LegalManagerFactory.sol`) ·
full EOA-surface map (agent C report, reproduced as the P1 checklist in the PR that builds it).
