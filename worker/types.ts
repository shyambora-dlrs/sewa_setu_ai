import type { Application } from "../packages/application/container";
import type { AdminIdentity } from "./middleware/access-auth";
import type { R2AdminStore } from "./adapters/r2-admin-store";
import type { R2ReleaseAdmin } from "./adapters/r2-release-admin";
import type { AppEnv } from "./env";

/** Everything route handlers need, built once per request by `buildServices` (or by tests). */
export interface Services {
  app: Application;
  admin: R2AdminStore;
  releases: R2ReleaseAdmin;
  authenticate(req: Request): Promise<AdminIdentity>;
  dispatchRebuild(): Promise<{ dispatched: true; workflow: string }>;
  staleAfterHours: number;
  now(): Date;
}

export type HonoEnv = {
  Bindings: AppEnv;
  Variables: { services: Services; requestId: string; admin?: AdminIdentity };
};
