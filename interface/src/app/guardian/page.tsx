"use client";

import * as React from "react";
import QRCode from "qrcode";
import { worldIdMe, worldIdRequest, worldIdStatus } from "@/lib/api/client";
import type { WorldIdMe, WorldIdStatusView } from "@/lib/api/types";
import { AgentShell } from "@/components/agents/AgentShell";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Callout, Card, Spinner, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

export default function GuardianPage() {
  return (
    <RequireAuth>
      <GuardianVerification />
    </RequireAuth>
  );
}

type Phase = "loading" | "idle" | "awaiting" | "verified" | "failed";

function GuardianVerification() {
  const { ensureSession, address } = useAuth();
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [me, setMe] = React.useState<WorldIdMe | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<WorldIdStatusView | null>(null);

  // Current verification state for this wallet.
  const refresh = React.useCallback(async () => {
    try {
      const s = await ensureSession();
      const state = await worldIdMe(s.token);
      setMe(state);
      setPhase(state.verified ? "verified" : "idle");
    } catch (e) {
      setDetail((e as Error).message);
      setPhase("failed");
    }
  }, [ensureSession]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open a request, render the QR, then poll until World App responds.
  const start = React.useCallback(async () => {
    setDetail(null);
    setResult(null);
    setPhase("awaiting");
    try {
      const s = await ensureSession();
      const req = await worldIdRequest(s.token);
      setLink(req.connectorURI);
      setQr(
        await QRCode.toDataURL(req.connectorURI, {
          width: 320,
          margin: 1,
          color: { dark: "#f2f0ea", light: "#0000" },
        }),
      );

      // The backend holds the bridge connection; poll it until it settles.
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        if (Date.now() > deadline) {
          setDetail("Verification timed out. Start again when you're ready.");
          setPhase("failed");
          return;
        }
        const st = await worldIdStatus(s.token, req.requestId);
        if (st.status === "pending") continue;
        setResult(st);
        if (st.status === "verified") {
          await refresh();
          setPhase("verified");
        } else {
          setDetail(st.detail ?? "Verification was not completed.");
          setPhase("failed");
        }
        return;
      }
    } catch (e) {
      setDetail((e as Error).message);
      setPhase("failed");
    }
  }, [ensureSession, refresh]);

  return (
    <AgentShell
      title="Guardian"
      subtitle="The legally accountable human behind your agents."
    >
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg text-[var(--ink)]">Proof of personhood</h2>
                <p className="max-w-[62ch] text-sm text-[var(--muted)]">
                  A Wyoming DAO LLC must have a real natural person behind it — that&apos;s the
                  law, not a product choice. World ID proves a unique human is here, without
                  revealing who they are.
                </p>
              </div>
              <StatusPill phase={phase} verified={me?.verified ?? false} />
            </div>

            {address ? (
              <p className="text-xs text-[var(--muted-2)]">
                Guardian wallet {shortAddress(address)}
              </p>
            ) : null}
          </div>
        </Card>

        {phase === "loading" ? <LoadingState /> : null}

        {phase === "idle" ? (
          <Card>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-base text-[var(--ink)]">Not yet verified</h3>
                <p className="max-w-[62ch] text-sm text-[var(--muted)]">
                  Until a human is verified, this account can&apos;t form a legal entity. One
                  person may back a limited number of companies — the same human cannot quietly
                  control many accounts.
                </p>
              </div>
              <div>
                <Button onClick={() => void start()}>Verify with World ID</Button>
              </div>
            </div>
          </Card>
        ) : null}

        {phase === "awaiting" ? (
          <Card>
            <div className="flex flex-col items-center gap-5 py-2 text-center">
              <div className="flex flex-col gap-1">
                <h3 className="text-base text-[var(--ink)]">Scan with World App</h3>
                <p className="text-sm text-[var(--muted)]">
                  Your wallet address is bound into the proof, so it can&apos;t be reused elsewhere.
                </p>
              </div>
              {qr ? (
                <img
                  src={qr}
                  alt="World ID verification QR code"
                  width={280}
                  height={280}
                  className="rounded-xl border border-[var(--line)] bg-[var(--paper-2)] p-3"
                />
              ) : (
                <Spinner />
              )}
              {link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-[var(--ink)] underline underline-offset-4 hover:text-[var(--ink-hover)]"
                >
                  Or open World App on this device
                </a>
              ) : null}
              <p className="flex items-center gap-2 text-xs text-[var(--muted-2)]">
                <Spinner className="h-3 w-3" /> waiting for you to approve…
              </p>
            </div>
          </Card>
        ) : null}

        {phase === "verified" && me ? (
          <Card>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-base text-[var(--ink)]">A unique human is accountable</h3>
                <p className="max-w-[62ch] text-sm text-[var(--muted)]">
                  Every agent under this account inherits a named controller who can pause it,
                  claw back its funds, and dissolve the company.
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Credential" value={me.credential ?? result?.credential ?? "verified"} />
                <Stat
                  label="Legal entities"
                  value={
                    me.maxEntities != null
                      ? `${me.entitiesUsed ?? 0} / ${me.maxEntities}`
                      : String(me.entitiesUsed ?? 0)
                  }
                />
                <Stat
                  label="Verified"
                  value={
                    me.verifiedAt ? new Date(me.verifiedAt).toLocaleDateString() : "just now"
                  }
                />
              </dl>
              <p className="text-xs text-[var(--muted-2)]">
                We store only a nullifier — a value unique to you within this app and meaningless
                anywhere else. It never identifies you.
              </p>
              <div>
                <Button variant="ghost" onClick={() => void start()}>
                  Verify again
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {phase === "failed" ? (
          <Card>
            <div className="flex flex-col gap-4">
              <Callout tone="warn" title="Not verified">
                {detail ?? "Verification did not complete."}
              </Callout>
              {detail?.toLowerCase().includes("already") ? (
                <p className="max-w-[62ch] text-sm text-[var(--muted)]">
                  That human is already the guardian of another account. This is the sybil gate
                  working as intended — one person cannot quietly back two separate accounts.
                </p>
              ) : null}
              <div>
                <Button onClick={() => void start()}>Try again</Button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </AgentShell>
  );
}

function StatusPill({ phase, verified }: { phase: Phase; verified: boolean }) {
  const ok = verified || phase === "verified";
  return (
    <span
      className={cx(
        "shrink-0 rounded-full border px-3 py-1 text-xs",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-[var(--line-strong)] bg-[var(--paper-3)] text-[var(--muted)]",
      )}
    >
      {ok ? "Verified human" : "Unverified"}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-2)] p-3">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--muted-2)]">{label}</dt>
      <dd className="text-sm text-[var(--ink)]">{value}</dd>
    </div>
  );
}
