import { useState } from "react";
import { api, ApiError } from "../../services/api";
import { useI18n } from "../../i18n";

/** Lets citizens flag incorrect/outdated information. Sends only type + short message (no personal data). */
export function FeedbackForm({ serviceId, onDone }: { serviceId: string; onDone(): void }) {
  const { d } = useI18n();
  const [type, setType] = useState("incorrect");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      await api.feedback({ service_id: serviceId, type, message: message.trim() || undefined });
      setState("done");
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : d.common.error);
      setState("error");
    }
  }
  if (state === "done") return <p role="status" className="card bg-ok-container text-ok">{d.feedback.thanks} <button type="button" className="underline" onClick={onDone}>{d.common.close}</button></p>;
  return (
    <form onSubmit={submit} className="card space-y-3" aria-label={d.feedback.title}>
      <h3 className="font-bold">{d.feedback.title}</h3>
      <label className="block text-sm font-medium">{d.feedback.type}
        <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(d.feedback.types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium">{d.feedback.message}
        <textarea className="input mt-1 min-h-24 py-2" maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <p className="text-xs text-ink-soft">{d.feedback.warning}</p>
      {state === "error" && <p role="alert" className="text-sm text-err">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={state === "sending"}>{d.feedback.submit}</button>
        <button type="button" className="btn-outline" onClick={onDone}>{d.common.close}</button>
      </div>
    </form>
  );
}
