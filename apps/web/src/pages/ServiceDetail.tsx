import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DocumentChecklist } from "../components/checklist/DocumentChecklist";
import { SourceList } from "../components/common/SourceList";
import { ErrorState, Loading } from "../components/common/States";
import { VerificationBadge } from "../components/common/VerificationBadge";
import { FeedbackForm } from "../components/service/FeedbackDialog";
import { FactCard, FeesBody, Statements, Steps, TimelineBody } from "../components/service/ServiceParts";
import { useAsync } from "../hooks/useAsync";
import { useI18n } from "../i18n";
import { api } from "../services/api";

/** Service detail: every section shows either published data or an explicit "not published" state. */
export function ServiceDetail() {
  const { id = "" } = useParams();
  const { d } = useI18n();
  const [showFeedback, setShowFeedback] = useState(false);
  const detail = useAsync((s) => api.service(id, s), [id]);
  const checklist = useAsync((s) => api.checklist(id, s), [id]);

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  const { service, verification } = detail.data!;
  const sources = checklist.data?.sources ?? service.sources.map((s) => ({
    source_id: s.source_id, title: s.title, url: s.source_url, section: s.page_or_section, retrieved_at: s.retrieved_at,
    last_verified_at: service.last_verified_at, verification,
  }));

  return (
    <article className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm"><Link to="/services" className="text-primary underline">← {d.browse.title}</Link></nav>
      <header className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip capitalize">{service.category}</span>
          <VerificationBadge level={verification} />
        </div>
        <h1 className="text-3xl font-extrabold">{service.service_name}</h1>
        {service.department && <p className="text-ink-soft">{d.service.department}: <strong>{service.department.name}</strong></p>}
        <div className="no-print flex flex-wrap gap-2 pt-1">
          {service.application_url && <a className="btn-primary" href={service.application_url} target="_blank" rel="noopener noreferrer">{d.service.apply} ↗</a>}
          {service.official_page_url && <a className="btn-outline" href={service.official_page_url} target="_blank" rel="noopener noreferrer">{d.service.officialPage} ↗</a>}
          <Link className="btn-tonal" to={`/assistant?service=${service.service_id}`}>{d.service.ask}</Link>
        </div>
      </header>

      <FactCard title={d.service.eligibility} published={service.eligibility.length > 0}><Statements items={service.eligibility} /></FactCard>

      <section className="card" aria-label={d.service.documents}>
        <h2 className="mb-3 text-xl font-bold">{d.service.documents}</h2>
        {checklist.loading && <Loading />}
        {checklist.error && <ErrorState error={checklist.error} onRetry={checklist.reload} />}
        {checklist.data && <DocumentChecklist checklist={checklist.data} serviceId={service.service_id} />}
      </section>

      <FactCard title={d.service.steps} published={service.application_steps.length > 0}><Steps steps={service.application_steps} /></FactCard>

      <div className="grid gap-4 md:grid-cols-2">
        <FactCard title={d.service.fees} published={service.fees.status === "published"}><FeesBody fees={service.fees} /></FactCard>
        <FactCard title={d.service.timeline} published={service.processing_time.status === "published"}><TimelineBody time={service.processing_time} /></FactCard>
      </div>

      <FactCard title={d.service.appeal} published={service.appeal_procedure.length + service.grievance_procedure.length > 0}>
        <Statements items={[...service.appeal_procedure, ...service.grievance_procedure]} />
      </FactCard>

      <section aria-label={d.service.sources}>
        <h2 className="mb-3 text-xl font-bold">{d.service.sources}</h2>
        <SourceList sources={sources} />
        <p className="mt-3 text-xs text-ink-soft">{d.contentEnglish}</p>
      </section>

      <div className="no-print">
        {showFeedback ? <FeedbackForm serviceId={service.service_id} onDone={() => setShowFeedback(false)} />
          : <button type="button" className="btn-outline" onClick={() => setShowFeedback(true)}>{d.service.feedback}</button>}
      </div>
    </article>
  );
}
