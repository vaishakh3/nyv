import type { Caption, ContentMessage, Status } from "../lib/messages.js";

/** Bilingual caption overlay on meet.google.com, isolated in a shadow root so Meet's CSS cannot touch it. */
export default defineContentScript({
  matches: ["https://meet.google.com/*"],
  runAt: "document_idle",
  main() {
    const host = document.createElement("div");
    host.id = "fyv-captions-host";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 2147483646;
          max-width: min(860px, 80vw); pointer-events: none; display: flex; flex-direction: column; gap: 6px; align-items: center;
          font-family: Inter, "Google Sans", Roboto, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
          transition: opacity .25s, transform .25s; opacity: 0; }
        .wrap.show { opacity: 1; }
        .line { background: rgba(28,29,27,.88); color: #f6f7f4; border-radius: 14px; padding: 10px 18px; line-height: 1.35;
          box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 10px 30px rgba(0,0,0,.35); backdrop-filter: blur(8px); text-align: center; }
        .target { font-size: 22px; font-weight: 500; letter-spacing: -0.005em; }
        .target .pending { color: rgba(246,247,244,.45); }
        .source { font-size: 13.5px; color: rgba(246,247,244,.62); padding: 7px 14px; border-radius: 10px; }
        .badge { position: fixed; top: 12px; right: 12px; z-index: 2147483646; font: 500 12px/1 Inter, "Google Sans", Roboto, system-ui, sans-serif;
          color: #f6f7f4; background: rgba(28,29,27,.88); border-radius: 999px; padding: 7px 12px 7px 10px; display: flex; gap: 8px; align-items: center;
          pointer-events: none; opacity: 0; transition: opacity .25s; backdrop-filter: blur(8px); font-variant-numeric: tabular-nums; }
        .badge.show { opacity: 1; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #4fae74; box-shadow: 0 0 0 0 rgba(79,174,116,.6); animation: pulse 1.8s ease-out infinite; }
        .dot.err { background: #e2552b; animation: none; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(79,174,116,.5);} 100% { box-shadow: 0 0 0 7px rgba(79,174,116,0);} }
      </style>
      <div class="badge"><span class="dot"></span><span class="label">fyv</span></div>
      <div class="wrap"><div class="line target"></div><div class="line source"></div></div>`;
    document.documentElement.appendChild(host);

    const wrap = root.querySelector<HTMLElement>(".wrap") as HTMLElement;
    const target = root.querySelector<HTMLElement>(".target") as HTMLElement;
    const source = root.querySelector<HTMLElement>(".source") as HTMLElement;
    const badge = root.querySelector<HTMLElement>(".badge") as HTMLElement;
    const dot = root.querySelector<HTMLElement>(".dot") as HTMLElement;
    const label = root.querySelector<HTMLElement>(".label") as HTMLElement;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const render = (c: Caption) => {
      target.innerHTML = c.final
        ? escapeHtml(c.target)
        : `${escapeHtml(c.target)}<span class="pending">…</span>`;
      source.textContent = c.source;
      source.style.display = c.source ? "" : "none";
      wrap.classList.add("show");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => wrap.classList.remove("show"), c.final ? 4500 : 8000);
    };
    const renderStatus = (s: Status) => {
      badge.classList.toggle("show", s.state !== "idle");
      dot.classList.toggle("err", s.state === "error");
      label.textContent =
        s.state === "active"
          ? `fyv · ${s.latency ? `${(s.latency.p50 / 1000).toFixed(1)}s` : "listening"}${s.rate > 1.02 ? ` · ${s.rate.toFixed(2)}×` : ""}`
          : s.state === "error"
            ? `fyv · ${s.error ?? "error"}`
            : s.state === "reconnecting"
              ? "fyv · reconnecting…"
              : "fyv · connecting";
      if (s.state === "idle" || s.state === "connecting") {
        wrap.classList.remove("show");
        target.textContent = "";
        source.textContent = "";
      }
    };

    chrome.runtime.onMessage.addListener((m: ContentMessage) => {
      if (m.type === "caption") render(m.caption);
      else renderStatus(m.status);
    });
    chrome.runtime
      .sendMessage({ type: "getStatus" })
      .then((s: Status | undefined) => s && renderStatus(s))
      .catch(() => {});
  },
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
