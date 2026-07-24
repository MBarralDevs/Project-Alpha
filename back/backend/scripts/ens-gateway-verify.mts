/**
 * ENS gateway end-to-end verification (T3). Feeds a mock entity to the real
 * `answer()` gateway function, then verifies the signed response against the
 * DEPLOYED OffchainResolver's `resolveWithProof()` on-chain. If that call
 * returns (does not revert "Invalid sigature"), the signing digest + ABI
 * encoding are provably correct against the real contract.
 *
 *   cd back/backend && npx tsx --env-file=.env scripts/ens-gateway-verify.mts
 */
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  namehash,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { answer } from "../src/api/routes/ensGateway";

const RESOLVER = process.env.ENS_RESOLVER_ADDRESS as Address;
const signer = privateKeyToAccount(process.env.ENS_GATEWAY_SIGNER_KEY as Hex);
const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });

// Mock entity: publicId "testagent", a real-looking treasury address.
const TREASURY = "0x8ffA18f05056458dbFB2f7A122F185878B2d6e2f" as Address;
const deps = {
  ens: {
    signer,
    parentName: "novicorpus.eth",
    metadataBaseUrl: "https://project-alpha-pi.vercel.app/backend",
  },
  repo: {
    findByPublicId: (id: string) =>
      id === "testagent"
        ? { name: "TestAgent MB1", treasury: TREASURY, operator: TREASURY, publicId: "testagent" }
        : undefined,
  },
  platformManagerAddress: "0x8ffA18f05056458dbFB2f7A122F185878B2d6e2f",
  mcpPublicUrl: "https://project-alpha-pi.vercel.app/backend/mcp",
  webOrigin: "https://project-alpha-pi.vercel.app",
  // biome-ignore lint/suspicious/noExplicitAny: partial mock of ApiDeps for isolated gateway test.
} as any;

const textAbi = [
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "string" }],
    outputs: [{ type: "string" }],
  },
] as const;
const addrAbi = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;
const resolveAbi = [
  {
    type: "function",
    name: "resolve",
    stateMutability: "view",
    inputs: [{ type: "bytes" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;
const proofAbi = [
  {
    type: "function",
    name: "resolveWithProof",
    stateMutability: "view",
    inputs: [{ type: "bytes" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

async function check(name: string, inner: Hex, decode: (result: Hex) => string) {
  const dnsName = toHex(packetToBytes(name));
  const outer = encodeFunctionData({
    abi: resolveAbi,
    functionName: "resolve",
    args: [dnsName, inner],
  });
  const { data } = await answer(deps, RESOLVER, outer);
  const extraData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "address" }],
    [outer, RESOLVER],
  );
  // On-chain: verifies the signature and returns `result` (reverts if the sig is bad/expired).
  const result = (await client.readContract({
    address: RESOLVER,
    abi: proofAbi,
    functionName: "resolveWithProof",
    args: [data, extraData],
  })) as Hex;
  console.log(`  ✓ ${name} -> ${decode(result)}`);
}

async function main() {
  console.log(`Verifying gateway answers against deployed resolver ${RESOLVER}\n`);
  const node = namehash("testagent.novicorpus.eth");

  await check(
    "testagent.novicorpus.eth",
    encodeFunctionData({ abi: textAbi, functionName: "text", args: [node, "url"] }),
    (r) => decodeAbiParameters([{ type: "string" }], r)[0] as string,
  );
  await check(
    "testagent.novicorpus.eth",
    encodeFunctionData({ abi: textAbi, functionName: "text", args: [node, "description"] }),
    (r) => decodeAbiParameters([{ type: "string" }], r)[0] as string,
  );
  await check(
    "testagent.novicorpus.eth",
    encodeFunctionData({ abi: addrAbi, functionName: "addr", args: [node] }),
    (r) => `addr ${decodeAbiParameters([{ type: "address" }], r)[0]}`,
  );
  // Apex + unknown-label paths.
  await check(
    "novicorpus.eth",
    encodeFunctionData({
      abi: textAbi,
      functionName: "text",
      args: [namehash("novicorpus.eth"), "description"],
    }),
    (r) => `apex: ${decodeAbiParameters([{ type: "string" }], r)[0]}`,
  );
  await check(
    "nope.novicorpus.eth",
    encodeFunctionData({
      abi: textAbi,
      functionName: "text",
      args: [namehash("nope.novicorpus.eth"), "url"],
    }),
    (r) =>
      `unknown-label url = "${decodeAbiParameters([{ type: "string" }], r)[0]}" (expected empty)`,
  );

  console.log(
    "\n✓ All answers verified on-chain via resolveWithProof — signing + encoding correct.",
  );
}

main().catch((e) => {
  console.error("\n✗ verification failed:", e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
