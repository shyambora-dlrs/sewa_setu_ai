import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Empty, ErrorState, Loading } from "../../components/common/States";
import { useAsync } from "../../hooks/useAsync";
import { adminApi } from "../../services/admin-api";

const badge = (s: string) => s === "verified" ? "bg-ok-container text-ok" : s === "rejected" ? "bg-err-container text-err" : "bg-warn-container text-warn";

/** Admin catalogue: filter by status/category/warnings, search, and bulk approve/reject the visible page. */
export function AdminServices() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const warnings = params.get("has_warnings") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const res = useAsync(() => adminApi.services({ status, q, category, has_warnings: warnings, page, page_size: 25 }), [status, q, category, warnings, page]);
  const set = (patch: Record<string, string>) => { const n = new URLSearchParams(params); for (const [k, v] of Object.entries({ page: "1", ...patch })) v ? n.set(k, v) : n.delete(k); setParams(n); setSelected(new Set()); };

  async function bulk(decision: "approve" | "reject" | "reset") {
    if (selected.size === 0) return;
    if (decision === "approve" && !window.confirm(`Approve ${selected.size} service(s)? Only do this after checking them against the official portal.`)) return;
    const r = await adminApi.bulk([...selected], decision);
    setMsg(`${r.updated} updated${r.missing.length ? `, ${r.missing.length} not found` : ""}.`);
    setSelected(new Set());
    res.reload();
  }

  return (
    <div className="space-y-4">
      {res.data && (
        <p className="flex flex-wrap gap-2 text-sm" aria-label="Status counts">
          {(["draft", "verified", "rejected"] as const).map((s) => <button key={s} className={`rounded-full px-3 py-1 font-semibold ${badge(s)}`} onClick={() => set({ status: status === s ? "" : s })} aria-pressed={status === s}>{s}: {res.data!.status_counts[s]}</button>)}
        </p>
      )}
      <form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm font-medium md:col-span-2">Search
          <input className="input mt-1" type="search" defaultValue={q} onKeyDown={(e) => { if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value }); }} />
        </label>
        <label className="text-sm font-medium">Category
          <select className="input mt-1" value={category} onChange={(e) => set({ category: e.target.value })}><option value="">All</option>{res.data?.facets.categories.map((c) => <option key={c.name}>{c.name}</option>)}</select>
        </label>
        <label className="text-sm font-medium">Extraction warnings
          <select className="input mt-1" value={warnings} onChange={(e) => set({ has_warnings: e.target.value })}><option value="">All</option><option value="true">With warnings</option><option value="false">Clean</option></select>
        </label>
      </form>
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Bulk actions">
        <button className="btn-tonal" disabled={!selected.size} onClick={() => void bulk("approve")}>Approve selected ({selected.size})</button>
        <button className="btn-outline" disabled={!selected.size} onClick={() => void bulk("reject")}>Reject selected</button>
        <button className="btn-outline" disabled={!selected.size} onClick={() => void bulk("reset")}>Reset to draft</button>
        {msg && <span role="status" className="self-center text-sm">{msg}</span>}
      </div>
      {res.loading && <Loading />}
      {res.error && <ErrorState error={res.error} onRetry={res.reload} />}
      {res.data && (res.data.items.length === 0 ? <Empty>No services.</Empty> : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-surface-container"><tr>
              <th className="p-3"><input type="checkbox" aria-label="Select all on page" checked={res.data.items.every((i) => selected.has(i.service_id))} onChange={(e) => setSelected(e.target.checked ? new Set(res.data!.items.map((i) => i.service_id)) : new Set())} /></th>
              <th className="p-3">Service</th><th className="p-3">Department</th><th className="p-3">Status</th><th className="p-3">Gaps</th><th className="p-3">Last verified</th>
            </tr></thead>
            <tbody>{res.data.items.map((s) => (
              <tr key={s.service_id} className="border-t border-line">
                <td className="p-3"><input type="checkbox" aria-label={`Select ${s.service_name}`} checked={selected.has(s.service_id)} onChange={() => setSelected((c) => { const n = new Set(c); n.has(s.service_id) ? n.delete(s.service_id) : n.add(s.service_id); return n; })} /></td>
                <td className="p-3"><Link className="font-medium text-primary underline" to={`/admin/services/${s.service_id}`}>{s.service_name}</Link></td>
                <td className="p-3">{s.department_name ?? "—"}</td>
                <td className="p-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge(s.publication_status)}`}>{s.publication_status}</span></td>
                <td className="p-3 text-xs">{[!s.has_documents && "docs", !s.has_steps && "steps", !s.has_fees && "fees"].filter(Boolean).join(", ") || "—"}{s.warning_count ? ` · ${s.warning_count}⚠` : ""}</td>
                <td className="p-3">{s.last_verified_at ? new Date(s.last_verified_at).toLocaleDateString() : "—"}</td>
              </tr>))}</tbody>
          </table>
        </div>
      ))}
      {res.data && res.data.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <button className="btn-outline" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
          <span className="text-sm">Page {page} of {res.data.total_pages} ({res.data.total})</span>
          <button className="btn-outline" disabled={page >= res.data.total_pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
        </div>
      )}
    </div>
  );
}
