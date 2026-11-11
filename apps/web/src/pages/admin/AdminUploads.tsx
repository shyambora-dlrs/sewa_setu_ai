import { useState } from "react";
import { ErrorState, Loading } from "../../components/common/States";
import { useAsync } from "../../hooks/useAsync";
import { ApiError } from "../../services/api";
import { adminApi } from "../../services/admin-api";
import { Section } from "./AdminShell";

/** Upload officially obtained PDFs (used when the portal is unreachable or a guideline is only available offline). */
export function AdminUploads() {
  const list = useAsync(() => adminApi.uploads(), []);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    try {
      await adminApi.upload(new FormData(form));
      setMsg("Uploaded. It will be extracted at the next rebuild.");
      form.reset();
      list.reload();
    } catch (er) { setMsg((er as ApiError).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Section title="Upload a government PDF or guideline">
        <form onSubmit={submit} className="grid gap-3">
          <label className="text-sm font-medium">PDF file (max 20 MB)<input required name="file" type="file" accept="application/pdf" className="input mt-1 py-2" /></label>
          <label className="text-sm font-medium">Title<input required name="title" minLength={3} className="input mt-1" /></label>
          <label className="text-sm font-medium">Where was it officially obtained? (URL or office/reference)<input required name="origin" minLength={3} className="input mt-1" /></label>
          <label className="text-sm font-medium">Department (optional)<input name="department" className="input mt-1" /></label>
          <label className="text-sm font-medium">Attach to service id (optional)<input name="service_id" pattern="[a-z0-9-]+" className="input mt-1" /></label>
          <button className="btn-primary w-fit" disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
          {msg && <p role="status" className="text-sm">{msg}</p>}
        </form>
      </Section>
      <Section title="Uploaded documents">
        {list.loading && <Loading />}
        {list.error && <ErrorState error={list.error} onRetry={list.reload} />}
        <ul className="space-y-2 text-sm">
          {list.data?.uploads.map((u) => <li key={u.sha256} className="rounded-lg border border-line p-3"><strong>{u.title}</strong> · {(u.size / 1024).toFixed(0)} KB · by {u.uploaded_by} on {new Date(u.uploaded_at).toLocaleDateString()}<br /><span className="text-ink-soft">Origin: {u.origin}{u.service_id ? ` · service ${u.service_id}` : ""}</span></li>)}
          {list.data?.uploads.length === 0 && <li className="text-ink-soft">No uploads yet.</li>}
        </ul>
      </Section>
    </div>
  );
}
