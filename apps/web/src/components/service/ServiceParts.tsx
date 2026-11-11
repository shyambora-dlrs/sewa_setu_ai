import type { ReactNode } from "react";
import type { Service } from "../../../../../packages/shared/schemas";
import { useI18n } from "../../i18n";

/** Card used for every service facet; renders an explicit "not published" state instead of an empty box. */
export function FactCard({ title, published, children }: { title: string; published: boolean; children?: ReactNode }) {
  const { d } = useI18n();
  return (
    <section className="card" aria-label={title}>
      <h3 className="text-base font-bold">{title}</h3>
      {published ? <div className="mt-3">{children}</div> : (
        <div className="mt-3 rounded-xl bg-surface-container p-3">
          <p className="font-medium">{d.service.notPublished}</p>
          <p className="mt-1 text-sm text-ink-soft">{d.service.notPublishedHelp}</p>
        </div>
      )}
    </section>
  );
}

export function FeesBody({ fees }: { fees: Service["fees"] }) {
  return (
    <ul className="divide-y divide-line">
      {fees.items.map((f, i) => (
        <li key={i} className="flex items-start justify-between gap-4 py-2 text-sm">
          <span>
            {f.label}
            {f.condition && <span className="block text-xs text-warn">“{f.condition}”</span>}
          </span>
          <span className="shrink-0 font-semibold">
            {f.amount !== null ? `₹${f.amount.toLocaleString("en-IN")}${f.unit ? ` ${f.unit}` : ""}` : f.raw_text === f.label ? "" : f.raw_text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TimelineBody({ time }: { time: Service["processing_time"] }) {
  return (
    <p className="text-lg font-semibold">
      {time.value !== null && time.unit ? `${time.value} ${time.unit.replace("_", " ")}` : time.text}
      {time.value !== null && time.text && <span className="mt-1 block text-sm font-normal text-ink-soft">{time.text}</span>}
    </p>
  );
}

export function Steps({ steps }: { steps: Service["application_steps"] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s) => (
        <li key={s.step} className="flex gap-3">
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-container text-sm font-bold text-on-primary-container">{s.step}</span>
          <span><span className="sr-only">Step {s.step}: </span>{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function Statements({ items }: { items: Service["eligibility"] }) {
  return <ul className="list-disc space-y-2 pl-5">{items.map((s, i) => <li key={i}>{s.text}</li>)}</ul>;
}
