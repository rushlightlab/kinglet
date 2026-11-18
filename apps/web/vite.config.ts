import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the Kinglet API lives during dev. Override when :3000 is taken:
//   KINGLET_PORT=3100 KINGLET_API_URL=http://localhost:3100 pnpm dev
const apiUrl = process.env.KINGLET_API_URL ?? "http://localhost:3000";

export default defineConfig({
  // The router plugin must run before the react plugin.
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    // In dev the UI runs on its own port; /v1 and Better Auth are proxied.
    proxy: {
      "/v1": apiUrl,
      "/api/auth": apiUrl,
    },
  },
});
