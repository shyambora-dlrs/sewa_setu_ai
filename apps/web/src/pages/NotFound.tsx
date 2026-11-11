import { Link } from "react-router-dom";
import { useI18n } from "../i18n";

export function NotFound() {
  const { d } = useI18n();
  return (
    <div className="card text-center">
      <h1 className="text-2xl font-bold">{d.common.notFound}</h1>
      <Link to="/" className="btn-primary mt-4">{d.nav.home}</Link>
    </div>
  );
}
