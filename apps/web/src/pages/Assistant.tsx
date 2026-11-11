import { useSearchParams } from "react-router-dom";
import { ChatPanel } from "../components/chat/ChatPanel";
import { useAsync } from "../hooks/useAsync";
import { useI18n } from "../i18n";
import { api } from "../services/api";

export function Assistant() {
  const { d } = useI18n();
  const [params, setParams] = useSearchParams();
  const serviceId = params.get("service") ?? undefined;
  const svc = useAsync(async (s) => (serviceId ? api.service(serviceId, s) : null), [serviceId]);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-extrabold">{d.chat.title}</h1>
      <ChatPanel
        key={serviceId ?? "all"}
        serviceId={serviceId}
        initialQuestion={params.get("q") ?? undefined}
        serviceName={svc.data?.service.service_name}
        onClearService={() => { const n = new URLSearchParams(params); n.delete("service"); setParams(n); }}
      />
    </div>
  );
}
