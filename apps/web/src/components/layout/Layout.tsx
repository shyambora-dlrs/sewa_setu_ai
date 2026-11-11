import { Link, NavLink, Outlet } from "react-router-dom";
import { LANGUAGE_LABELS, useI18n } from "../../i18n";
import { SUPPORTED_LANGUAGES } from "../../../../../packages/shared/constants";

/** Segmented language selector (radio semantics via aria-pressed buttons; large touch targets). */
function LanguageSwitch() {
  const { lang, setLang, d } = useI18n();
  return (
    <div role="group" aria-label={d.language} className="flex rounded-full bg-surface-container p-1">
      {SUPPORTED_LANGUAGES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`min-h-9 rounded-full px-3 text-sm font-medium transition-colors ${lang === l ? "bg-card text-primary shadow-sm" : "text-ink-soft hover:text-ink"}`}
        >
          {LANGUAGE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-4 py-2 text-sm font-medium ${isActive ? "bg-primary-container text-on-primary-container" : "text-ink-soft hover:bg-surface-container"}`;

/** App shell: skip link, translucent sticky header (Apple-style), main landmark and the always-visible disclaimer footer. */
export function Layout() {
  const { d } = useI18n();
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:shadow-lg">
        {d.skip}
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-ink">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-primary text-on-primary">স</span>
            {d.appName}
          </Link>
          <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            <NavLink to="/" end className={linkCls}>{d.nav.home}</NavLink>
            <NavLink to="/services" className={linkCls}>{d.nav.browse}</NavLink>
            <NavLink to="/assistant" className={linkCls}>{d.nav.assistant}</NavLink>
          </nav>
          <LanguageSwitch />
        </div>
        <p className="bg-warn-container px-4 py-1 text-center text-xs font-medium text-warn">{d.independent}</p>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto min-h-[70vh] max-w-6xl px-4 py-6 outline-none">
        <Outlet />
      </main>
      <footer className="mt-10 border-t border-line bg-surface-container">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-ink-soft">
          <p>{d.disclaimer}</p>
          <p>{d.contentEnglish}</p>
          <p><Link to="/admin" className="underline">{d.nav.admin}</Link></p>
        </div>
      </footer>
    </>
  );
}
