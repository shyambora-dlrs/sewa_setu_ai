import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * One Vite project builds the React SPA (static assets) and the Worker together via
 * the Cloudflare Vite plugin. `root` is the SPA folder; the plugin reads the
 * Worker config (bindings, vars, assets) from the repo-level wrangler.jsonc, so
 * `vite dev` runs the Worker in the local workerd runtime with local R2 emulation.
 */
export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss(), cloudflare({ configPath: "../../wrangler.jsonc", persistState: { path: "../../.wrangler/state" } })],
});
