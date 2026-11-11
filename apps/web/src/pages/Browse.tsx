import { Link, useSearchParams } from "react-router-dom";
import { Empty, ErrorState, Loading } from "../components/common/States";
import { VerificationBadge } from "../components/common/VerificationBadge";
import { useAsync } from "../hooks/useAsync";
import { useI18n } from "../i18n";
import { api } from "../services/api";

/** Service browser: text search + category/department filters, URL-driven so results are shareable and Back works. */
export function Browse() {
  const { d, t } = useI18n();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const department = params.get("department") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;

  const res = useAsync((s) => api.catalog({ q, category, department, page, page_size: 20 }, s), [q, category, department, page]);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: "1", ...patch })) v ? next.set(k, v) : next.delete(k);
    setParams(next);
  };

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-extrabold">{d.browse.title}</h1>
      <form role="search" className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]" onSubmit={(e) => e.preventDefault()}>
        <label className="text-sm font-medium">{d.browse.search}
          <input className="input mt-1" type="search" defaultValue={q} key={q} maxLength={200}
            onKeyDown={(e) => { if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value }); }}
            onBlur={(e) => { if (e.target.value !== q) set({ q: e.target.value }); }} />
        </label>
        <label className="text-sm font-medium">{d.browse.category}
          <select className="input mt-1 capitalize" value={category} onChange={(e) => set({ category: e.target.value })}>
            <option value="">{d.browse.all}</option>
            {res.data?.facets.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">{d.browse.department}
          <select className="input mt-1" value={department} onChange={(e) => set({ department: e.target.value })}>
            <option value="">{d.browse.all}</option>
            {res.data?.facets.departments.map((x) => <option key={x.department_id} value={x.department_id}>{x.name} ({x.count})</option>)}
          </select>
        </label>
      </form>

      {res.loading && <Loading />}
      {res.error && <ErrorState error={res.error} onRetry={res.reload} />}
      {res.data && (
        <>
          <p className="text-sm text-ink-soft" aria-live="polite">{t(d.browse.results, { n: res.data.total })}</p>
          {res.data.items.length === 0 ? <Empty>{d.browse.none}</Empty> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {res.data.items.map((s) => (
                <li key={s.service_id}>
                  <Link to={`/services/${s.service_id}`} className="card block h-full hover:border-primary">
                    <span className="text-lg font-semibold">{s.service_name}</span>
                    <span className="mt-1 block text-sm text-ink-soft">{s.department_name ?? "—"}</span>
                    <span className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="chip capitalize">{s.category}</span>
                      <VerificationBadge level={s.publication_status === "verified" ? "verified" : "unverified"} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {res.data.total_pages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-between">
              <button className="btn-outline" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>{d.browse.prev}</button>
              <span className="text-sm">{t(d.browse.page, { p: page, t: res.data.total_pages })}</span>
              <button className="btn-outline" disabled={page >= res.data.total_pages} onClick={() => set({ page: String(page + 1) })}>{d.browse.next}</button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
