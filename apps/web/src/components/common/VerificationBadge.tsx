import { useI18n } from "../../i18n";

type Level = "verified" | "unverified" | "confirmed" | "unavailable";

/**
 * Shows whether information was reviewed. Colour is never the only signal:
 * each state also has an icon glyph and a text label (WCAG 1.4.1).
 */
export function VerificationBadge({ level }: { level: Level }) {
  const { d } = useI18n();
  const ok = level === "verified" || level === "confirmed";
  const none = level === "unavailable";
  const cls = ok ? "bg-ok-container text-ok" : none ? "bg-surface-container text-ink-soft" : "bg-warn-container text-warn";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${cls}`}>
      <span aria-hidden>{ok ? "✓" : none ? "–" : "!"}</span>
      {d.verification[level]}
    </span>
  );
}
