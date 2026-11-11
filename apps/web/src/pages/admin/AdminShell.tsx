import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ErrorState, Loading } from "../../components/common/States";
import { useI18n } from "../../i18n";
import { ApiError } from "../../services/api";
import { adminApi, adminToken } from "../../services/admin-api";

/**
 * Admin gate. It asks the server who we are (`/admin/me`); the UI never decides access itself -
 * hiding links protects nothing, the Worker enforces authentication on every admin route.
 */
export function AdminShell() {
  const { d } = useI18n();
  const [state, setState] = useState<"loading" | "login" | "ok" | "error">("loading");
  const [identity, setIdentity] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<ApiError | null>(null);

  const check = async () => {
    setState("loading");
    try { setIdentity((await adminApi.me()).identity); setState("ok"); }
    catch (e) {
      const err = e as ApiError;
      if (err.status === 401) { setState("login"); setError(adminToken.get() ? err : null); }
      else { setError(err); setState("error"); }
    }
  };
  useEffect(() => { void check(); }, []);

  if (state === "loading") return <Loading />;
  if (state === "error") return <ErrorState error={error!} onRetry={check} />;
  if (state === "login") {
    return (
      <form className="card mx-auto max-w-md space-y-3" onSubmit={(e) => { e.preventDefault(); adminToken.set(token); void check(); }}>
        <h1 className="text-2xl font-bold">{d.admin.login}</h1>
        <label className="block text-sm font-medium">{d.admin.token}
          <input className="input mt-1" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-err">{error.message}</p>}
        <button className="btn-primary">{d.admin.signIn}</button>
      </form>
    );
  }
  const link = ({ isActive }: { isActive: boolean }) => `rounded-full px-4 py-2 text-sm font-medium ${isActive ? "bg-primary-container text-on-primary-container" : "text-ink-soft hover:bg-surface-container"}`;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold">{d.admin.title}</h1>
        <span className="text-sm text-ink-soft">{identity} · <button className="underline" onClick={() => { adminToken.set(""); void check(); }}>{d.admin.signOut}</button></span>
      </div>
      <nav aria-label="Admin" className="flex gap-1 overflow-x-auto">
        <NavLink end to="/admin" className={link}>{d.admin.services}</NavLink>
        <NavLink to="/admin/uploads" className={link}>{d.admin.uploads}</NavLink>
        <NavLink to="/admin/ingestion" className={link}>{d.admin.ingestion}</NavLink>
        <NavLink to="/admin/feedback" className={link}>{d.admin.feedback}</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card"><h2 className="mb-3 text-lg font-bold">{title}</h2>{children}</section>;
}
