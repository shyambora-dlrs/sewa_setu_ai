import { useState } from "react";
import { ErrorState, Loading } from "../../components/common/States";
import { useAsync } from "../../hooks/useAsync";
import { ApiError } from "../../services/api";
import { adminApi } from "../../services/admin-api";
import { Section } from "./AdminShell";

/** Ingestion logs, extraction failures, index rebuild trigger and release rollback. */
export function AdminIngestion() {
  const logs = useAsync(() => adminApi.logs(), []);
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg(ok); logs.reload(); } catch (e) { setMsg((e as ApiError).message); }
  };

  return (
    <div className="space-y-4">
      <Section title="Rebuild knowledge index">
        <p className="mb-3 text-sm text-ink-soft">Starts the GitHub Actions ingestion workflow (crawl, extract, validate, publish). Review decisions and uploads made here are included.</p>
        <button className="btn-primary" onClick={() => { if (window.confirm("Start a new ingestion run?")) void act(adminApi.rebuild, "Ingestion workflow started. A new release will appear below when it finishes."); }}>Trigger rebuild</button>
        {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      </Section>
      {logs.loading && <Loading />}
      {logs.error && <ErrorState error={logs.error} onRetry={logs.reload} />}
      {logs.data?.releases.map((r) => (
        <Section key={r.release_id} title={`${r.release_id}${r.active ? "  (active)" : ""}`}>
          <p className="text-sm">Generated {r.generated_at ? new Date(r.generated_at).toLocaleString() : "?"} · {r.service_count ?? "?"} services · {r.chunk_count ?? "?"} chunks · validation <strong>{r.validation_status}</strong></p>
          {r.report?.totals && <p className="mt-1 text-xs text-ink-soft">{Object.entries(r.report.totals).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p>}
          {r.report?.unavailable_fields && <p className="mt-1 text-xs text-ink-soft">Unavailable fields: {Object.entries(r.report.unavailable_fields).map(([k, v]) => `${k} (${v})`).join(", ")}</p>}
          {r.report?.failures && r.report.failures.length > 0 && (
            <details className="mt-2 text-sm"><summary className="cursor-pointer font-semibold text-err">{r.report.failures.length} extraction failure(s)</summary>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">{r.report.failures.map((f, i) => <li key={i}><code className="text-xs">{f.stage}</code> {f.url} — {f.error}</li>)}</ul></details>
          )}
          {!r.active && r.validation_status === "passed" && <button className="btn-outline mt-3" onClick={() => { if (window.confirm(`Make ${r.release_id} the active release?`)) void act(() => adminApi.activate(r.release_id), "Release activated."); }}>Activate this release (rollback)</button>}
        </Section>
      ))}
    </div>
  );
}
