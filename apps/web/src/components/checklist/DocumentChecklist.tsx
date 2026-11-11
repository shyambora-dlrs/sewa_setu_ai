import { useEffect, useState } from "react";
import type { ChecklistResponse } from "../../services/api";
import { useI18n } from "../../i18n";

type Doc = ChecklistResponse["mandatory"][number];
const storageKey = (id: string) => `sewasetu.checklist.${id}`;

/** Loads/saves ticked items in localStorage. Wrapped in try/catch: storage may be blocked (private mode). */
function usePersistedChecks(serviceId: string) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setChecked(JSON.parse(localStorage.getItem(storageKey(serviceId)) ?? "{}")); } catch { setChecked({}); }
  }, [serviceId]);
  const toggle = (key: string) =>
    setChecked((c) => {
      const next = { ...c, [key]: !c[key] };
      try { localStorage.setItem(storageKey(serviceId), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  return { checked, toggle };
}

/**
 * Document checklist grouped by how the official page labels each item.
 * Mandatory / conditional / optional are never merged: a conditional item always
 * shows the verbatim condition from the source.
 */
export function DocumentChecklist({ checklist, serviceId }: { checklist: ChecklistResponse; serviceId: string }) {
  const { d, t } = useI18n();
  const { checked, toggle } = usePersistedChecks(serviceId);
  const groups: [string, string, Doc[]][] = [
    ["mandatory", d.service.mandatory, checklist.mandatory],
    ["conditional", d.service.conditional, checklist.conditional],
    ["optional", d.service.optional, checklist.optional],
    ["unspecified", d.service.unspecified, checklist.unspecified],
  ];
  const all = groups.flatMap(([, , items]) => items);
  if (checklist.status === "not_published" || all.length === 0) {
    return (
      <div className="card bg-surface-container">
        <p className="font-semibold">{d.service.notPublished}</p>
        <p className="mt-1 text-sm text-ink-soft">{d.service.notPublishedHelp}</p>
      </div>
    );
  }
  const required = [...checklist.mandatory, ...checklist.unspecified];
  const done = required.filter((x) => checked[x.name]).length;
  return (
    <div>
      <p className="mb-3 text-sm text-ink-soft">{d.service.checklistHint}</p>
      <p className="mb-3 text-sm font-semibold" aria-live="polite">{t(d.service.progress, { a: done, b: required.length })}</p>
      {groups.filter(([, , items]) => items.length > 0).map(([key, label, items]) => (
        <fieldset key={key} className="mb-4">
          <legend className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-soft">{label}</legend>
          <ul className="space-y-2">
            {items.map((doc) => (
              <li key={doc.name}>
                <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line bg-card p-3 hover:bg-surface-container">
                  <input type="checkbox" className="mt-1 size-5 accent-[var(--color-primary)]" checked={!!checked[doc.name]} onChange={() => toggle(doc.name)} />
                  <span>
                    <span className={checked[doc.name] ? "line-through opacity-60" : ""}>{doc.name}</span>
                    {doc.condition && <span className="mt-0.5 block text-xs text-warn">“{doc.condition}”</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      <button type="button" className="btn-outline no-print" onClick={() => window.print()}>{d.service.printList}</button>
    </div>
  );
}
