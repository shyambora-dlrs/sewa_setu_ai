import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loading } from "../components/common/States";
import { useAsync } from "../hooks/useAsync";
import { useI18n } from "../i18n";
import { api } from "../services/api";

export function Home() {
  const { d } = useI18n();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const cats = useAsync((s) => api.catalog({ page_size: 1 }, s), []);

  return (
    <div className="space-y-10">
      <section className="rounded-[2rem] bg-gradient-to-br from-primary-container to-surface-container px-6 py-10 sm:px-12">
        <h1 className="max-w-3xl text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">{d.home.title}</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-soft">{d.home.subtitle}</p>
        <form role="search" className="mt-6 flex max-w-2xl gap-2" onSubmit={(e) => { e.preventDefault(); nav(`/services?q=${encodeURIComponent(q)}`); }}>
          <label className="sr-only" htmlFor="home-search">{d.browse.search}</label>
          <input id="home-search" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={d.home.searchPlaceholder} maxLength={200} />
          <button className="btn-primary">{d.home.searchButton}</button>
        </form>
      </section>

      <section aria-labelledby="ask-h" className="card flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="ask-h" className="text-xl font-bold">{d.home.askTitle}</h2>
          <p className="text-ink-soft">{d.home.askText}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {d.home.examples.map((ex) => <Link key={ex} to={`/assistant?q=${encodeURIComponent(ex)}`} className="chip min-h-9 hover:bg-surface-high">{ex}</Link>)}
          </div>
        </div>
        <Link to="/assistant" className="btn-primary shrink-0">{d.home.askButton}</Link>
      </section>

      <section aria-labelledby="cat-h">
        <h2 id="cat-h" className="mb-3 text-xl font-bold">{d.home.categories}</h2>
        {cats.loading && <Loading />}
        {cats.data && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cats.data.facets.categories.map((c) => (
              <li key={c.name}>
                <Link to={`/services?category=${encodeURIComponent(c.name)}`} className="card flex min-h-20 flex-col justify-center hover:border-primary">
                  <span className="text-lg font-semibold capitalize">{c.name}</span>
                  <span className="text-sm text-ink-soft">{d.browse.results.replace("{n}", String(c.count))}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {cats.error && <p className="text-ink-soft">{cats.error.code === "knowledge_unavailable" ? d.common.unavailable : d.common.error}</p>}
      </section>

      <section aria-labelledby="how-h">
        <h2 id="how-h" className="mb-3 text-xl font-bold">{d.home.howTitle}</h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {d.home.how.map((h, i) => <li key={i} className="card"><span aria-hidden className="mb-2 grid size-8 place-items-center rounded-full bg-primary-container font-bold text-on-primary-container">{i + 1}</span>{h}</li>)}
        </ul>
      </section>
    </div>
  );
}
