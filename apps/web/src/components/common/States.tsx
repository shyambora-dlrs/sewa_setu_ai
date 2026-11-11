import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { ApiError } from "../../services/api";

/** Accessible loading indicator (role=status so assistive tech announces it politely). */
export function Loading({ label }: { label?: string }) {
  const { d } = useI18n();
  return (
    <div role="status" className="flex items-center gap-3 p-6 text-ink-soft">
      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span>{label ?? d.common.loading}</span>
    </div>
  );
}

/** Error panel with a retry button; maps well-known API codes to friendly localized text. */
export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const { d } = useI18n();
  const text =
    error.code === "knowledge_unavailable" ? d.common.unavailable
    : error.code === "not_found" ? d.common.notFound
    : error.code === "rate_limited" ? d.common.rateLimited
    : error.message || d.common.error;
  return (
    <div role="alert" className="card border-err/40 bg-err-container text-err">
      <p className="font-semibold">{d.common.error}</p>
      <p className="mt-1 text-sm">{text}</p>
      {error.requestId && <p className="mt-1 text-xs opacity-80">Ref: {error.requestId}</p>}
      {onRetry && <button type="button" className="btn-outline mt-3" onClick={onRetry}>{d.common.retry}</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card text-center text-ink-soft">{children}</p>;
}
