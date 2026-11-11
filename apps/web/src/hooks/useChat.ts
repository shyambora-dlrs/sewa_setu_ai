import { useCallback, useRef, useState } from "react";
import { api, ApiError, type ChatAnswer, type ChatTurn } from "../services/api";
import { useI18n } from "../i18n";
import type { Language } from "../../../../packages/shared/constants";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  answer?: ChatAnswer;
  error?: string;
}

/**
 * Chat state machine. Conversation history lives only in memory (never persisted).
 * Only the last few turns are sent to the Worker (server-side limits also apply).
 */
export function useChat(serviceId?: string) {
  const { lang, d } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);

  const send = useCallback(async (question: string, language: Language = lang) => {
    const q = question.trim();
    if (!q || pending) return;
    const history: ChatTurn[] = messages.filter((m) => !m.error).slice(-6).map((m) => ({ role: m.role, content: m.text.slice(0, 1200) }));
    const userMsg: ChatMessage = { id: ++idRef.current, role: "user", text: q };
    setMessages((m) => [...m, userMsg]);
    setPending(true);
    abortRef.current = new AbortController();
    try {
      const answer = await api.chat({ question: q, language, service_id: serviceId, conversation: history }, abortRef.current.signal);
      setMessages((m) => [...m, { id: ++idRef.current, role: "assistant", text: answer.answer, answer }]);
    } catch (err) {
      if (abortRef.current?.signal.aborted) return;
      const msg = err instanceof ApiError
        ? err.code === "rate_limited" ? d.common.rateLimited : err.code === "knowledge_unavailable" ? d.common.unavailable : err.message
        : d.common.error;
      setMessages((m) => [...m, { id: ++idRef.current, role: "assistant", text: msg, error: msg }]);
    } finally {
      setPending(false);
    }
  }, [lang, messages, pending, serviceId, d]);

  const clear = useCallback(() => { abortRef.current?.abort(); setMessages([]); setPending(false); }, []);
  return { messages, pending, send, clear };
}
