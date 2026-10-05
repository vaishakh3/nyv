import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  outDir: "dist",
  manifest: {
    name: "Parley – Live Call Translation",
    description: "Hear Google Meet participants in your language, in real time.",
    permissions: ["tabCapture", "offscreen", "storage", "activeTab"],
    host_permissions: ["https://meet.google.com/*"],
    action: { default_title: "Parley" },
    minimum_chrome_version: "116",
  },
  vite: () => ({ plugins: [preact()] }),
});
