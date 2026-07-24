import type { Hono } from "hono";
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hexToBytes,
  keccak256,
  zeroAddress,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

// ENS CCIP-Read offchain gateway (EIP-3668 + ENSIP-10) for `*.<parent>` names.
// Answers the OffchainResolver's `resolve(bytes,bytes)` lookups from our SQLite/adapters
// and signs each response with ENS_GATEWAY_SIGNER_KEY (verified on-chain by the resolver).
// Unknown label/record -> 200 with an empty value (never 4xx; a 4xx aborts client resolution).

const RESOLVE_SELECTOR = "0x9061b923"; // resolve(bytes,bytes) — ENSIP-10 IExtendedResolver
const SEL_ADDR = "0x3b3b57de"; // addr(bytes32)
const SEL_ADDR_COIN = "0xf1cb7e06"; // addr(bytes32,uint256)
const SEL_TEXT = "0x59d1d43c"; // text(bytes32,string)
const ARC_COINTYPE = 2152525650n; // ENSIP-11 for Arc testnet (0x80000000 | 5042002)
const ETH_COINTYPE = 60n;
const TTL_SEC = 300n;

export interface EnsGatewayDeps {
  /** Fresh EOA whose key lives only in env; signs response digests, never holds funds. */
  signer: PrivateKeyAccount;
  /** Parent name we own, e.g. "novicorpus.eth". */
  parentName: string;
  /** Base URL for the agent metadata JSON (the `url`/`metadata` records). */
  metadataBaseUrl: string;
  /** Deployed OffchainResolver address (informational; the URL `:sender` is authoritative). */
  resolverAddress?: Address;
}

/** DNS wire format -> ["sub","novicorpus","eth"]. Returns null on malformed input. */
function decodeDnsName(bytes: Uint8Array): string[] | null {
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === undefined) return null;
    if (len === 0) return i === bytes.length - 1 ? labels : null; // junk after terminator
    if (len > 63 || i + 1 + len > bytes.length) return null;
    labels.push(new TextDecoder().decode(bytes.subarray(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  return null; // missing terminator
}

type Target = { kind: "apex" } | { kind: "agent"; label: string } | { kind: "unknown" };

function classify(labels: string[], parentLabels: string[]): Target {
  const eq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, k) => x.toLowerCase() === b[k]?.toLowerCase());
  if (eq(labels, parentLabels)) return { kind: "apex" };
  if (labels.length === parentLabels.length + 1 && eq(labels.slice(1), parentLabels))
    return { kind: "agent", label: (labels[0] ?? "").toLowerCase() };
  return { kind: "unknown" };
}

/** The entity's canonical "pay me" address = its governed treasury (zero if none/unknown/apex). */
function addrFor(deps: ApiDeps, target: Target): Address {
  if (target.kind === "apex") return getAddress(deps.platformManagerAddress) as Address;
  if (target.kind === "agent") {
    const ent = deps.repo.findByPublicId(target.label);
    return (ent?.treasury as Address | null) ?? zeroAddress;
  }
  return zeroAddress;
}

/** Text records (repo-sourced). T4 adds live legal-status (Arc), ENSIP-25, ENSIP-26 agent-context. */
function textFor(deps: ApiDeps, target: Target, key: string): string {
  const ens = deps.ens!;
  if (target.kind === "apex") {
    if (key === "description") return "Novi Corpus — legal bodies for AI agents";
    if (key === "url") return ens.metadataBaseUrl;
    if (key === "agent-endpoint[web]") return deps.webOrigin;
    return "";
  }
  if (target.kind === "agent") {
    const ent = deps.repo.findByPublicId(target.label);
    if (!ent) return "";
    const metaUrl = `${ens.metadataBaseUrl}/metadata/${target.label}`;
    switch (key) {
      case "description":
        return `${ent.name} — Wyoming DAO LLC governed agent`;
      case "url":
      case "metadata":
        return metaUrl;
      case "treasury":
        return ent.treasury ?? "";
      case "operator":
        return ent.operator ?? "";
      case "agent-endpoint[mcp]":
        return deps.mcpPublicUrl;
      case "agent-endpoint[web]":
        return deps.webOrigin;
      default:
        return ""; // T4: legal-status, agent-registration[...], agent-context
    }
  }
  return "";
}

/** Dispatch the inner resolver call to an ABI-encoded `result` (never throws for unknown records). */
function resolveInner(deps: ApiDeps, innerCall: Hex, target: Target): Hex {
  const sel = innerCall.slice(0, 10).toLowerCase();
  if (sel === SEL_ADDR) {
    return encodeAbiParameters([{ type: "address" }], [addrFor(deps, target)]);
  }
  if (sel === SEL_ADDR_COIN) {
    const [, coinType] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      `0x${innerCall.slice(10)}` as Hex,
    ) as [Hex, bigint];
    const addr = addrFor(deps, target);
    const value: Hex =
      (coinType === ARC_COINTYPE || coinType === ETH_COINTYPE) && addr !== zeroAddress
        ? addr
        : "0x";
    return encodeAbiParameters([{ type: "bytes" }], [value]);
  }
  if (sel === SEL_TEXT) {
    const [, key] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }],
      `0x${innerCall.slice(10)}` as Hex,
    ) as [Hex, string];
    return encodeAbiParameters([{ type: "string" }], [textFor(deps, target, key)]);
  }
  return encodeAbiParameters([{ type: "bytes" }], ["0x"]); // unknown record fn -> empty
}

/** Core CCIP resolver: signed answer for a resolve() calldata. Exported for tests. */
export async function answer(
  deps: ApiDeps,
  senderRaw: string,
  dataHex: string,
): Promise<{ data: Hex }> {
  const ens = deps.ens!;
  if (!/^0x[0-9a-fA-F]{40}$/.test(senderRaw)) throw new ApiError("bad_request", 400, "bad sender");
  if (!/^0x[0-9a-fA-F]+$/.test(dataHex) || dataHex.length < 10)
    throw new ApiError("bad_request", 400, "bad data");
  if (dataHex.slice(0, 10).toLowerCase() !== RESOLVE_SELECTOR)
    throw new ApiError("bad_request", 400, "not a resolve() call");
  const sender = getAddress(senderRaw) as Address;

  let dnsName: Hex;
  let innerCall: Hex;
  try {
    [dnsName, innerCall] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }],
      `0x${dataHex.slice(10)}` as Hex,
    ) as [Hex, Hex];
  } catch {
    throw new ApiError("bad_request", 400, "malformed resolve() args");
  }

  const labels = decodeDnsName(hexToBytes(dnsName));
  const parentLabels = ens.parentName.split(".");
  const target: Target = labels ? classify(labels, parentLabels) : { kind: "unknown" };

  const result = resolveInner(deps, innerCall, target);

  // Sign per SignatureVerifier: keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak(request) ‖ keccak(result)).
  // `request` is the FULL outer resolve() calldata (what the resolver put in extraData). Verified
  // byte-for-byte against the deployed contract's makeSignatureHash() view.
  const expires = BigInt(Math.floor(Date.now() / 1000)) + TTL_SEC;
  const digest = keccak256(
    encodePacked(
      ["bytes2", "address", "uint64", "bytes32", "bytes32"],
      ["0x1900", sender, expires, keccak256(dataHex as Hex), keccak256(result)],
    ),
  );
  const sig = await ens.signer.sign({ hash: digest });
  const data = encodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    [result, expires, sig],
  );
  return { data };
}

/** Public, unauthenticated CCIP-Read gateway. Mounted only when deps.ens is configured. */
export function mountEnsGatewayRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  if (!deps.ens) return;
  // GET .../{sender}/{data}.json — matches the resolver's URL template (clients use GET when {data} present).
  app.get("/ensgateway/:sender/:data", async (c) => {
    const data = c.req.param("data").replace(/\.json$/, "");
    const body = await answer(deps, c.req.param("sender"), data);
    c.header("Cache-Control", "public, max-age=30");
    return c.json(body);
  });
  // POST fallback (EIP-3668 spec; used by the UniversalResolver batch gateway).
  app.post("/ensgateway", async (c) => {
    const { sender, data } = await c.req.json<{ sender: string; data: string }>();
    const body = await answer(deps, sender, data);
    c.header("Cache-Control", "public, max-age=30");
    return c.json(body);
  });
}
