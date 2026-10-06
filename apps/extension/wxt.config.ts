import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  outDir: "dist",
  manifest: {
    name: "nyv – Live Call Translation",
    description: "Hear Google Meet participants in your language, in real time.",
    permissions: ["tabCapture", "offscreen", "storage", "activeTab"],
    host_permissions: ["https://meet.google.com/*"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    action: {
      default_title: "nyv",
      default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
    },
    minimum_chrome_version: "116",
  },
  vite: () => ({ plugins: [preact()] }),
});
