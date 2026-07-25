"use client";

import * as React from "react";
import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import { worldIdContext, worldIdMe, worldIdVerify } from "@/lib/api/client";
import type { WorldIdContext, WorldIdMe } from "@/lib/api/types";
import { AgentShell } from "@/components/agents/AgentShell";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Callout, Card, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

export default function GuardianPage() {
  return (
    <RequireAuth>
      <GuardianVerification />
    </RequireAuth>
  );
}

function GuardianVerification() {
  const { ensureSession, address } = useAuth();
  const [me, setMe] = React.useState<WorldIdMe | null>(null);
  const [ctx, setCtx] = React.useState<WorldIdContext | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const s = await ensureSession();
      setMe(await worldIdMe(s.token));
    } catch (e) {
      setError((e as Error).message || "Could not load your guardian status.");
    }
  }, [ensureSession]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch the signed request context, then open World's widget.
  const begin = React.useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const s = await ensureSession();
      setCtx(await worldIdContext(s.token));
      setOpen(true);
    } catch (e) {
      setError((e as Error).message || "Could not start verification.");
    } finally {
      setBusy(false);
    }
  }, [ensureSession]);

  // The widget hands us the proof; our backend verifies it and applies the sybil gate.
  const handleVerify = React.useCallback(
    async (proof: unknown) => {
      const s = await ensureSession();
      await worldIdVerify(s.token, proof); // throwing here makes the widget show the failure
    },
    [ensureSession],
  );

  const verified = me?.verified ?? false;

  return (
    <AgentShell title="Guardian" subtitle="The legally accountable human behind your agents.">
      <div className="flex flex-col gap-4">
        {/* Header: what this is + current standing */}
        <Card>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <h2 className="text-lg text-ink">Proof of personhood</h2>
                <span
                  className={cx(
                    "rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-wider",
                    verified
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-line-strong bg-paper-3 text-muted",
                  )}
                >
                  {verified ? "Verified human" : "Unverified"}
                </span>
              </div>
              <p className="max-w-[58ch] text-sm leading-relaxed text-muted">
                A Wyoming DAO LLC must have a real natural person behind it — that&apos;s the law,
                not a product choice. World ID proves a unique human is here, without revealing
                who they are.
              </p>
              {address ? (
                <p className="text-xs text-muted-2">Guardian wallet {shortAddress(address)}</p>
              ) : null}
            </div>

            <div className="shrink-0">
              {verified ? (
                <Button variant="ghost" onClick={() => void begin()} disabled={busy}>
                  Verify again
                </Button>
              ) : (
                <Button onClick={() => void begin()} disabled={busy}>
                  {busy ? "Preparing…" : "Verify with World ID"}
                </Button>
              )}
            </div>
          </div>
        </Card>

        {error ? (
          <Callout tone="warn" title="Not verified">
            {error}
            {error.toLowerCase().includes("already") ? (
              <span className="mt-1 block text-muted">
                That human is already the guardian of another account — the sybil gate working as
                intended. One person cannot quietly back two separate accounts.
              </span>
            ) : null}
          </Callout>
        ) : null}

        {me === null ? <LoadingState label="Checking your guardian status…" /> : null}

        {/* Standing */}
        {me ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              label="Status"
              value={verified ? "Accountable human" : "None yet"}
              tone={verified ? "good" : "idle"}
            />
            <Metric
              label="Credential"
              value={verified ? (me.credential ?? "verified") : "—"}
              tone={verified ? "good" : "idle"}
            />
            <Metric
              label="Legal entities"
              value={
                me.maxEntities != null ? `${me.entitiesUsed ?? 0} / ${me.maxEntities}` : "—"
              }
              tone="idle"
              hint="one human, a capped number of companies"
            />
          </div>
        ) : null}

        {/* What it means */}
        <Card>
          <div className="flex flex-col gap-3">
            <h3 className="text-base text-ink">
              {verified ? "What this guarantees" : "What verifying does"}
            </h3>
            <ul className="flex flex-col gap-2 text-sm text-muted">
              <Point>
                Every agent under this account inherits a named controller who can pause it, claw
                back its funds, and dissolve the company.
              </Point>
              <Point>
                The same human cannot quietly control many accounts — one person, a limited number
                of legal entities.
              </Point>
              <Point>
                We store only a nullifier: a value unique to you inside this app and meaningless
                anywhere else. It never identifies you.
              </Point>
            </ul>
          </div>
        </Card>
      </div>

      {/* World's own widget handles the QR, deep links and device handoff. */}
      {ctx ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={ctx.appId as `app_${string}`}
          action={ctx.action}
          // biome-ignore lint/suspicious/noExplicitAny: rp_context shape is defined by the API response.
          rp_context={ctx.rpContext as any}
          allow_legacy_proofs
          environment={ctx.environment}
          preset={proofOfHuman({ signal: ctx.signal })}
          handleVerify={handleVerify}
          onSuccess={() => {
            setOpen(false);
            void refresh();
          }}
        />
      ) : null}
    </AgentShell>
  );
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "good" | "idle";
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-paper-2 p-4">
      <span className="text-[11px] uppercase tracking-wider text-muted-2">{label}</span>
      <span className={cx("text-sm", tone === "good" ? "text-emerald-300" : "text-ink")}>
        {value}
      </span>
      {hint ? <span className="text-[11px] text-muted-2">{hint}</span> : null}
    </div>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 leading-relaxed">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
  );
}
