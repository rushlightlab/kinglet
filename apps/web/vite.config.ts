import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In dev the UI runs on its own port; /v1 is proxied to the Kinglet API.
    proxy: {
      "/v1": "http://localhost:3000",
    },
  },
});
