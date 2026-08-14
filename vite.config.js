import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "assets",

  build: {
    target: "es2022"
  },

  optimizeDeps: {
    exclude: ["@xmtp/browser-sdk"]
  }
});
