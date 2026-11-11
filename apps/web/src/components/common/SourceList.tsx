import type { SourceCitation } from "../../services/api";
import { useI18n } from "../../i18n";
import { VerificationBadge } from "./VerificationBadge";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null);

/** Official references with retrieval / verification dates. External links open safely in a new tab. */
export function SourceList({ sources, showCited = false, id }: { sources: SourceCitation[]; showCited?: boolean; id?: string }) {
  const { d, t } = useI18n();
  if (sources.length === 0) return null;
  return (
    <ul id={id} className="space-y-2">
      {sources.map((s, i) => (
        <li key={`${s.url}-${i}`} id={s.ref ? `src-${s.ref}` : undefined} className="rounded-xl border border-line bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {s.ref && <span className="chip font-mono">{s.ref}</span>}
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline break-words">
              {s.title}<span className="sr-only"> (opens in a new tab)</span> ↗
            </a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <VerificationBadge level={s.verification} />
            {showCited && s.cited && <span className="chip">{d.chat.cited}</span>}
            {s.section && <span>{s.section}</span>}
            <span>{t(d.service.retrieved, { d: fmt(s.retrieved_at) ?? "" })}</span>
            {s.last_verified_at && <span>{t(d.service.verifiedOn, { d: fmt(s.last_verified_at) ?? "" })}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
