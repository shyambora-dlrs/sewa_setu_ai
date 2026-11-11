import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Loading } from "../components/common/States";
import { Layout } from "../components/layout/Layout";
import { I18nProvider } from "../i18n";
import { Assistant } from "../pages/Assistant";
import { Browse } from "../pages/Browse";
import { Home } from "../pages/Home";
import { NotFound } from "../pages/NotFound";
import { ServiceDetail } from "../pages/ServiceDetail";

// The admin area is code-split so citizens never download it.
const AdminShell = lazy(() => import("../pages/admin/AdminShell").then((m) => ({ default: m.AdminShell })));
const AdminServices = lazy(() => import("../pages/admin/AdminServices").then((m) => ({ default: m.AdminServices })));
const AdminServiceReview = lazy(() => import("../pages/admin/AdminServiceReview").then((m) => ({ default: m.AdminServiceReview })));
const AdminUploads = lazy(() => import("../pages/admin/AdminUploads").then((m) => ({ default: m.AdminUploads })));
const AdminIngestion = lazy(() => import("../pages/admin/AdminIngestion").then((m) => ({ default: m.AdminIngestion })));
const AdminFeedback = lazy(() => import("../pages/admin/AdminFeedback").then((m) => ({ default: m.AdminFeedback })));

export function App() {
  return (
    <I18nProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="services" element={<Browse />} />
              <Route path="services/:id" element={<ServiceDetail />} />
              <Route path="assistant" element={<Assistant />} />
              <Route path="admin" element={<AdminShell />}>
                <Route index element={<AdminServices />} />
                <Route path="services/:id" element={<AdminServiceReview />} />
                <Route path="uploads" element={<AdminUploads />} />
                <Route path="ingestion" element={<AdminIngestion />} />
                <Route path="feedback" element={<AdminFeedback />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </I18nProvider>
  );
}
