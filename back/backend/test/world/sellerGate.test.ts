import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { buildPaywall } from "../../src/payments/seller";
import type { AgentkitSellerConfig } from "../../src/payments/worldVerifier";
import { mintAgentkitExtension, verifyAgentkitRequest } from "../../src/payments/worldVerifier";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Address } from "../../src/types";

const RESOURCE_URL = "https://example.com/x402-demo/quote";
const HUMAN = "0x051dbcb350abbe853a25ef35c88c7a582281f88d1d8e26ed014bad0e34a7d234";

let store: SqliteWorldStore;
beforeEach(() => {
  const db = new Database(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});

function cfg(over: Partial<AgentkitSellerConfig> = {}): AgentkitSellerConfig {
  return {
    domain: "example.com",
    resourceUrl: RESOURCE_URL,
    network: "eip155:5042002",
    store,
    allowancePerHuman: 2,
    agentBook: { lookupHuman: async () => HUMAN },
    ...over,
  };
}

describe("mintAgentkitExtension", () => {
  test("hand-mints nonce/issuedAt/expirationTime (SDK omits them; client rejects without)", () => {
    const ext = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: Record<string, unknown>; supportedChains: unknown[] } };
    expect(ext.agentkit.info.nonce).toBeTruthy();
    expect(ext.agentkit.info.issuedAt).toBeTruthy();
    expect(ext.agentkit.info.expirationTime).toBeTruthy();
    expect(ext.agentkit.info.domain).toBe("example.com");
    expect(ext.agentkit.supportedChains.length).toBeGreaterThan(0);
  });

  test("REGRESSION: nonce is alphanumeric (SIWE rejects hyphens -> silent skip)", () => {
    // randomUUID() is the obvious choice and is what World's own example shows, but its hyphens
    // make the client's createHeader throw a SiweError, which it swallows as `agentkit_skipped`:
    // the agent is never authorized and nothing surfaces the reason. Keep this alphanumeric.
    for (let i = 0; i < 20; i++) {
      const ext = mintAgentkitExtension({
        domain: "example.com",
        resourceUrl: RESOURCE_URL,
        network: "eip155:5042002",
        allowancePerHuman: 3,
      }) as { agentkit: { info: { nonce: string } } };
      expect(ext.agentkit.info.nonce).toMatch(/^[a-zA-Z0-9]{8,}$/);
    }
  });

  test("each mint carries a fresh nonce (no cross-response replay)", () => {
    const a = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: { nonce: string } } };
    const b = mintAgentkitExtension({
      domain: "example.com",
      resourceUrl: RESOURCE_URL,
      network: "eip155:5042002",
      allowancePerHuman: 3,
    }) as { agentkit: { info: { nonce: string } } };
    expect(a.agentkit.info.nonce).not.toBe(b.agentkit.info.nonce);
  });
});

describe("verifyAgentkitRequest — fail-closed", () => {
  test("malformed header -> refused (falls through to payment)", async () => {
    const r = await verifyAgentkitRequest("not-base64-json", cfg());
    expect(r.authorized).toBe(false);
  });

  test("garbage base64 payload -> refused", async () => {
    const bad = Buffer.from(JSON.stringify({ nope: 1 })).toString("base64");
    const r = await verifyAgentkitRequest(bad, cfg());
    expect(r.authorized).toBe(false);
  });

  test("AgentBook RPC failure is refused, never granted", async () => {
    const r = await verifyAgentkitRequest(
      Buffer.from(JSON.stringify({ nope: 1 })).toString("base64"),
      cfg({
        agentBook: {
          lookupHuman: async () => {
            throw new Error("world chain down");
          },
        },
      }),
    );
    expect(r.authorized).toBe(false);
  });
});

describe("paywall integration — World gate before payment", () => {
  function app(agentkit?: AgentkitSellerConfig) {
    const a = new Hono();
    a.route(
      "/",
      buildPaywall({
        price: 10_000n,
        payTo: "0x0000000000000000000000000000000000000001" as Address,
        asset: "0x3600000000000000000000000000000000000000" as Address,
        network: "eip155:5042002",
        resource: "/x402-demo/quote",
        resourceUrl: RESOURCE_URL,
        agentkit,
        serve: () => ({ quote: "demo" }),
      }),
    );
    return a;
  }

  test("no agentkit header -> normal 402 challenge, now carrying the extension", async () => {
    const res = await app(cfg()).request("/x402-demo/quote");
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: unknown[];
      extensions?: { agentkit?: { info?: { nonce?: string } } };
    };
    expect(body.accepts.length).toBe(1); // Arc payment requirements unchanged
    expect(body.extensions?.agentkit?.info?.nonce).toBeTruthy();
  });

  test("invalid agentkit header -> still 402 (fail-closed), with a reason header", async () => {
    const res = await app(cfg()).request("/x402-demo/quote", {
      headers: { agentkit: "garbage" },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("X-AGENTKIT-REASON")).toBeTruthy();
  });

  test("World gate absent -> paywall behaves exactly as before (no extensions key)", async () => {
    const res = await app(undefined).request("/x402-demo/quote");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { extensions?: unknown };
    expect(body.extensions).toBeUndefined();
  });
});

describe("authorization allowance (NOT a discount — an execution limit)", () => {
  test("allowance is consumed per human, then refuses -> settlement required", () => {
    const r = () => store.tryIncrementUsage(HUMAN, RESOURCE_URL, 2, Date.now());
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(false); // beyond allowance: agent must pay through its treasury
  });

  test("allowance is per-human, not per-agent-address (one human, many agents)", () => {
    // Two agent wallets backed by the SAME human share one allowance.
    store.cacheHuman("0xAGENT1", HUMAN, Date.now());
    store.cacheHuman("0xAGENT2", HUMAN, Date.now());
    expect(store.getCachedHuman("0xagent1", Date.now(), 60_000)).toBe(HUMAN);
    expect(store.getCachedHuman("0xagent2", Date.now(), 60_000)).toBe(HUMAN);
    const r = () => store.tryIncrementUsage(HUMAN, RESOURCE_URL, 1, Date.now());
    expect(r().allowed).toBe(true);
    expect(r().allowed).toBe(false); // second agent, same human -> same budget
  });
});
