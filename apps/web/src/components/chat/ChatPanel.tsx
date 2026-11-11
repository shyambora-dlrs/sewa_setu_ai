import { Fragment, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useChat, type ChatMessage } from "../../hooks/useChat";
import { useI18n } from "../../i18n";
import { SourceList } from "../common/SourceList";
import { VerificationBadge } from "../common/VerificationBadge";

/**
 * Renders model text safely. React escapes everything, so no HTML can be injected;
 * we only recognise: `**bold**`, "- " / "* " / "1." list lines and [S#] citation markers,
 * which become links that jump to the matching source card.
 */
function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const isItem = /^\s*([-*•]|\d+[.)])\s+/.test(line);
    const last = blocks.at(-1);
    if (last && last.list === isItem) last.lines.push(line);
    else blocks.push({ list: isItem, lines: [line] });
  }
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|\[S\d+\])/g).map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
      const m = /^\[(S\d+)\]$/.exec(part);
      if (m) return <a key={i} href={`#src-${m[1]}`} className="mx-0.5 rounded bg-primary-container px-1 text-xs font-bold text-on-primary-container no-underline" aria-label={`Source ${m[1]}`}>{m[1]}</a>;
      return <Fragment key={i}>{part}</Fragment>;
    });
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => b.list
        ? <ul key={i} className="list-disc space-y-1 pl-5">{b.lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>)}</ul>
        : <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>)}
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const { d } = useI18n();
  if (m.role === "user") return <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-on-primary">{m.text}</div>;
  if (m.error) return <div role="alert" className="max-w-[90%] rounded-2xl bg-err-container px-4 py-3 text-err">{m.error}</div>;
  const a = m.answer!;
  return (
    <div className="max-w-[95%] space-y-3 rounded-2xl rounded-bl-md border border-line bg-card px-4 py-3">
      <VerificationBadge level={a.verification} />
      {a.degraded && <p className="rounded-lg bg-warn-container p-2 text-sm text-warn">{d.chat.degraded}</p>}
      <RichText text={a.answer} />
      {a.sources.length > 0 && (
        <details open className="text-sm">
          <summary className="cursor-pointer font-semibold">{d.chat.sources} ({a.sources.length})</summary>
          <div className="mt-2"><SourceList sources={a.sources} showCited /></div>
        </details>
      )}
      {a.related_services.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-soft">{d.chat.related}:</span>
          {a.related_services.map((s) => <Link key={s.service_id} className="chip hover:bg-surface-high" to={`/services/${s.service_id}`}>{s.service_name}</Link>)}
        </div>
      )}
      <p className="text-xs text-ink-soft">{a.disclaimer}</p>
    </div>
  );
}

/** Conversation UI: live region announces new answers to screen readers; Enter sends, Shift+Enter adds a line. */
export function ChatPanel({ serviceId, serviceName, onClearService, initialQuestion }: { serviceId?: string; serviceName?: string; onClearService?: () => void; initialQuestion?: string }) {
  const { d, t } = useI18n();
  const { messages, pending, send, clear } = useChat(serviceId);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" }); }, [messages, pending]);
  // A question passed in the URL (?q=) is asked once on arrival, e.g. from the home-page examples.
  const asked = useRef(false);
  useEffect(() => {
    if (initialQuestion && !asked.current) { asked.current = true; void send(initialQuestion); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    void send(text);
    setText("");
  };

  return (
    <section aria-label={d.chat.title} className="flex min-h-[60vh] flex-col rounded-[var(--radius-card)] border border-line bg-surface-container">
      {serviceId && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-sm">
          <span>{t(d.chat.aboutService, { s: serviceName ?? serviceId })}</span>
          {onClearService && <button type="button" className="underline" onClick={onClearService}>{d.chat.stopAbout}</button>}
        </div>
      )}
      <div className="flex-1 space-y-3 overflow-y-auto p-4" role="log" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 && (
          <div className="rounded-2xl bg-card p-4 text-sm text-ink-soft">
            <p>{d.chat.welcome}</p>
            <p className="mt-2 font-medium">{d.home.popular}:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {d.home.examples.map((ex) => <button key={ex} type="button" className="chip min-h-9 hover:bg-surface-high" onClick={() => void send(ex)}>{ex}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => <Bubble key={m.id} m={m} />)}
        {pending && <div role="status" className="flex items-center gap-2 text-sm text-ink-soft"><span aria-hidden className="size-4 animate-spin rounded-full border-2 border-line border-t-primary" />{d.chat.thinking}</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="border-t border-line bg-card p-3">
        <p className="mb-2 text-xs text-ink-soft">{d.chat.privacy}</p>
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="chat-input">{d.chat.placeholder}</label>
          <textarea
            id="chat-input" rows={1} maxLength={1000} value={text} placeholder={d.chat.placeholder}
            className="input min-h-11 resize-none py-2.5"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          />
          <button className="btn-primary" disabled={pending || !text.trim()}>{d.chat.send}</button>
        </div>
        {messages.length > 0 && <button type="button" className="mt-2 text-xs underline" onClick={clear}>{d.chat.clear}</button>}
      </form>
    </section>
  );
}
