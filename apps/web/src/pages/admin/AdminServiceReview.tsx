import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorState, Loading } from "../../components/common/States";
import { SourceList } from "../../components/common/SourceList";
import { useAsync } from "../../hooks/useAsync";
import { ApiError } from "../../services/api";
import { adminApi } from "../../services/admin-api";
import { Section } from "./AdminShell";

/** Review screen: shows the extracted record next to its official sources so the reviewer can compare, then approve/reject. */
export function AdminServiceReview() {
  const { id = "" } = useParams();
  const res = useAsync(() => adminApi.service(id), [id]);
  const [notes, setNotes] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [patch, setPatch] = useState({ designated_authority: "", processing_time_text: "", eligibility: "", appeal_procedure: "" });
  const [msg, setMsg] = useState("");

  if (res.loading) return <Loading />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const { service: s, review, pending_override } = res.data!;
  const stale = review?.decision === "approved" && review.content_hash !== s.content_hash;

  async function decide(decision: "approve" | "reject" | "reset") {
    try { await adminApi.review(id, decision, notes || undefined); setMsg(`Saved: ${decision}`); res.reload(); }
    catch (e) { setMsg((e as ApiError).message); }
  }
  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
    const p: Record<string, unknown> = {};
    if (patch.designated_authority.trim()) p.designated_authority = patch.designated_authority.trim();
    if (patch.processing_time_text.trim()) p.processing_time_text = patch.processing_time_text.trim();
    if (lines(patch.eligibility).length) p.eligibility = lines(patch.eligibility);
    if (lines(patch.appeal_procedure).length) p.appeal_procedure = lines(patch.appeal_procedure);
    try { await adminApi.saveMetadata(id, { evidence: { source_url: evidenceUrl, note: evidenceNote }, patch: p }); setMsg("Correction saved. Trigger a rebuild to apply it."); res.reload(); }
    catch (er) { setMsg((er as ApiError).message); }
  }

  return (
    <div className="space-y-4">
      <Link to="/admin" className="text-sm text-primary underline">← All services</Link>
      <h2 className="text-2xl font-bold">{s.service_name}</h2>
      <p className="text-sm text-ink-soft">Status: <strong>{s.publication_status}</strong> · extracted {new Date(s.extracted_at).toLocaleString()} · hash <code>{s.content_hash.slice(0, 12)}</code></p>
      {stale && <p role="alert" className="card bg-warn-container text-warn">The approval was given for older content (the official page changed). Review again.</p>}
      {s.extraction_warnings.length > 0 && <Section title="Extraction warnings"><ul className="list-disc pl-5 text-sm">{s.extraction_warnings.map((w) => <li key={w}>{w}</li>)}</ul></Section>}

      <Section title="Review decision">
        <p className="mb-2 text-sm text-ink-soft">Extraction is never auto-verified. Compare the record below with the official page, then decide. Approval is bound to this exact content.</p>
        {review && <p className="mb-2 text-sm">Current decision: <strong>{review.decision}</strong> by {review.reviewer} on {new Date(review.reviewed_at).toLocaleString()}{review.notes ? ` — “${review.notes}”` : ""}</p>}
        <label className="block text-sm font-medium">Notes<input className="input mt-1" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => void decide("approve")}>Approve (verified)</button>
          <button className="btn-outline" onClick={() => void decide("reject")}>Reject</button>
          <button className="btn-outline" onClick={() => void decide("reset")}>Reset to draft</button>
          {s.official_page_url && <a className="btn-tonal" href={s.official_page_url} target="_blank" rel="noopener noreferrer">Open official page ↗</a>}
        </div>
        {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      </Section>

      <Section title="Extracted documents">
        <ul className="space-y-1 text-sm">{[...s.required_documents, ...s.conditional_documents].map((d, i) => <li key={i}><strong>{d.name}</strong> — {d.requirement}{d.condition ? ` (${d.condition})` : ""} <code className="text-xs text-ink-soft">“{d.source_text}”</code></li>)}{!s.required_documents.length && !s.conditional_documents.length && <li className="text-ink-soft">None extracted.</li>}</ul>
      </Section>
      <Section title="Steps"><ol className="list-decimal space-y-1 pl-5 text-sm">{s.application_steps.map((st) => <li key={st.step}>{st.text}</li>)}{!s.application_steps.length && <li className="list-none text-ink-soft">None extracted.</li>}</ol></Section>
      <Section title="Fees"><ul className="space-y-1 text-sm">{s.fees.items.map((f, i) => <li key={i}>{f.raw_text} → <strong>{f.amount !== null ? `₹${f.amount}` : "no amount parsed"}</strong></li>)}{!s.fees.items.length && <li className="text-ink-soft">Not published.</li>}</ul></Section>
      <Section title="Processing time / eligibility / appeal"><p className="text-sm">Time: {s.processing_time.text ?? "not published"} · Eligibility items: {s.eligibility.length} · Appeal items: {s.appeal_procedure.length}</p></Section>
      <Section title="Official sources (inspect original)"><SourceList sources={s.sources.map((x) => ({ source_id: x.source_id, title: x.title, url: x.source_url, section: x.page_or_section, retrieved_at: x.retrieved_at, last_verified_at: s.last_verified_at, verification: s.publication_status === "verified" ? "verified" : "unverified" }))} /></Section>

      <Section title="Add or correct metadata (requires evidence)">
        {pending_override && <p className="mb-2 rounded-lg bg-warn-container p-2 text-sm text-warn">A correction is pending the next rebuild (saved by {pending_override.updated_by}).</p>}
        <form onSubmit={saveMeta} className="grid gap-3">
          <label className="text-sm font-medium">Evidence URL (official document)<input required type="url" className="input mt-1" value={evidenceUrl} onChange={(e) => setEvidenceUrl(e.target.value)} placeholder="https://…" /></label>
          <label className="text-sm font-medium">Evidence note (section/page)<input required minLength={3} className="input mt-1" value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} /></label>
          <label className="text-sm font-medium">Designated authority<input className="input mt-1" value={patch.designated_authority} onChange={(e) => setPatch({ ...patch, designated_authority: e.target.value })} /></label>
          <label className="text-sm font-medium">Processing time (as written in the source)<input className="input mt-1" value={patch.processing_time_text} onChange={(e) => setPatch({ ...patch, processing_time_text: e.target.value })} /></label>
          <label className="text-sm font-medium">Eligibility (one per line)<textarea className="input mt-1 min-h-20 py-2" value={patch.eligibility} onChange={(e) => setPatch({ ...patch, eligibility: e.target.value })} /></label>
          <label className="text-sm font-medium">Appeal procedure (one per line)<textarea className="input mt-1 min-h-20 py-2" value={patch.appeal_procedure} onChange={(e) => setPatch({ ...patch, appeal_procedure: e.target.value })} /></label>
          <button className="btn-primary w-fit">Save correction</button>
        </form>
      </Section>
    </div>
  );
}
