import { ErrorState, Loading } from "../../components/common/States";
import { useAsync } from "../../hooks/useAsync";
import { adminApi } from "../../services/admin-api";

export function AdminFeedback() {
  const res = useAsync(() => adminApi.feedback(), []);
  if (res.loading) return <Loading />;
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <ul className="space-y-2">
      {res.data!.items.map((f) => <li key={f.id} className="card text-sm"><strong>{f.type}</strong> · {f.service_id ?? "general"} · {new Date(f.created_at).toLocaleString()}{f.message && <p className="mt-1">{f.message}</p>}</li>)}
      {res.data!.items.length === 0 && <li className="text-ink-soft">No feedback yet.</li>}
    </ul>
  );
}
