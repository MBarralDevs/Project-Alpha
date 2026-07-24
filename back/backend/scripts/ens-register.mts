/**
 * ENS name registration (Sepolia) — hackathon build 1 (ENS), task T1.
 *
 * Registers `novicorpus.eth` (or ENS_PARENT_NAME) on Sepolia via the current
 * 2025 unwrapped ETHRegistrarController, using ensjs 4.3.1.
 *
 * Reads from env (put these in back/backend/.env — it is git-ignored):
 *   ENS_OWNER_KEY    0x-prefixed private key of the funded Sepolia manager EOA
 *                    (the same key must later deploy the resolver + setResolver)
 *   SEPOLIA_RPC_URL  Sepolia RPC (e.g. https://ethereum-sepolia-rpc.publicnode.com)
 *   ENS_PARENT_NAME  optional, defaults to "novicorpus.eth"
 *
 * Run:  cd back/backend && npx tsx scripts/ens-register.mts
 *
 * NOTE: commit is only valid 60s–24h. This script commits, waits 75s, then
 * registers in one sitting. If it fails after committing, just re-run it
 * (a fresh commit/secret is generated each run).
 */
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { addEnsContracts } from "@ensdomains/ensjs";
import { getPrice, getOwner } from "@ensdomains/ensjs/public";
import { randomSecret } from "@ensdomains/ensjs/utils";
import { commitName, registerName } from "@ensdomains/ensjs/wallet";

const RPC = process.env.SEPOLIA_RPC_URL;
const KEY = process.env.ENS_OWNER_KEY as `0x${string}` | undefined;
const NAME = process.env.ENS_PARENT_NAME ?? "novicorpus.eth";
const DURATION = 31_536_000; // 1 year (min is 28 days)

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!RPC) fail("SEPOLIA_RPC_URL not set (add it to back/backend/.env)");
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY))
  fail("ENS_OWNER_KEY missing or malformed (expect 0x + 64 hex chars, in back/backend/.env)");

const chain = addEnsContracts(sepolia);
const account = privateKeyToAccount(KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

async function main() {
  console.log(`\nENS registration — ${NAME} on Sepolia`);
  console.log(`Manager address: ${account.address}`);

  // Preflight: balance + availability.
  const balance = await client.getBalance({ address: account.address });
  console.log(`Balance:         ${formatEther(balance)} SepoliaETH`);
  if (balance === 0n)
    fail(`This address has no Sepolia ETH. Fund ${account.address} via a Sepolia faucet first.`);

  const existingOwner = await getOwner(client, { name: NAME }).catch(() => null);
  if (existingOwner?.owner && existingOwner.owner !== "0x0000000000000000000000000000000000000000") {
    if (existingOwner.owner.toLowerCase() === account.address.toLowerCase()) {
      console.log(`\n✓ ${NAME} is ALREADY owned by this address — nothing to do.`);
      console.log(`  ownershipLevel: ${existingOwner.ownershipLevel}`);
      return;
    }
    fail(`${NAME} is already registered to ${existingOwner.owner} (not us). Pick another parent name.`);
  }

  const secret = randomSecret();
  const params = { name: NAME, owner: account.address, duration: DURATION, secret } as const;

  const { base, premium } = await getPrice(client, { nameOrNames: NAME, duration: DURATION });
  const value = ((base + premium) * 110n) / 100n; // +10% buffer; controller refunds excess
  console.log(`Price (1yr):     ${formatEther(base + premium)} ETH  (sending ${formatEther(value)} w/ buffer)`);
  if (balance < value) fail(`Insufficient balance for registration (need ~${formatEther(value)} ETH).`);

  console.log(`\nSECRET (auto, only needed if this run is interrupted): ${secret}`);

  console.log("\n[1/2] Committing...");
  const commitTx = await commitName(wallet, params);
  console.log(`  commit tx: ${commitTx}`);
  await client.waitForTransactionReceipt({ hash: commitTx });
  console.log("  committed. Waiting 75s (min commitment age 60s)...");
  await new Promise((r) => setTimeout(r, 75_000));

  console.log("[2/2] Registering...");
  const registerTx = await registerName(wallet, { ...params, value });
  console.log(`  register tx: ${registerTx}`);
  await client.waitForTransactionReceipt({ hash: registerTx });

  console.log(`\n✓ Registered ${NAME}`);
  console.log(`  View: https://sepolia.app.ens.domains/${NAME}`);
  console.log(`  Next (T2): deploy the resolver, then run the set-resolver step.`);
}

main().catch((e) => fail(e?.shortMessage ?? e?.message ?? String(e)));
