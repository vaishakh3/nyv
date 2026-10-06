import { createServer, type IncomingMessage } from "node:http";
import { providersFromEnv } from "@fyv/providers";
import { Quota } from "./quota.js";
import { clientIp, RelayServer } from "./server.js";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const trustProxy = env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true";
/** Comma-separated bearer tokens clients must present (`?token=` or `Authorization: Bearer`). Empty = open relay. */
const tokens = new Set(
  (env.RELAY_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
);
/** Comma-separated allowed `Origin` values, e.g. `chrome-extension://<id>`. Empty = any origin. */
const origins = new Set(
  (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);
/** Hosted mode: translation minutes each token may use per UTC day (0 = unlimited). */
const quota = new Quota(Number(env.TOKEN_DAILY_MINUTES ?? 0) * 60_000);
const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return new URL(req.url ?? "/", "http://relay").searchParams.get("token") ?? undefined;
}

function authorize(req: IncomingMessage): boolean {
  if (origins.size > 0) {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return false;
  }
  if (tokens.size === 0) return true;
  const t = presentedToken(req);
  return t !== undefined && tokens.has(t);
}

const relay = new RelayServer({
  providers: () => providersFromEnv(env),
  log,
  maxSessions: Number(env.MAX_SESSIONS ?? 50),
  maxSessionsPerIp: Number(env.MAX_SESSIONS_PER_IP ?? 3),
  maxSessionMs: Number(env.MAX_SESSION_MINUTES ?? 180) * 60_000,
  idleMs: Number(env.IDLE_MINUTES ?? 5) * 60_000,
  authorize,
  trustProxy,
  identify: presentedToken,
  quota,
});

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization",
};

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: relay.sessionCount }));
    return;
  }
  if (req.url?.startsWith("/v1/quota")) {
    // Lets the extension validate an access code and show remaining minutes before capturing a tab.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const token = presentedToken(req);
    if (tokens.size > 0 && (token === undefined || !tokens.has(token))) {
      res.writeHead(401, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: "invalid_token" }));
      return;
    }
    const remainingMs = token !== undefined ? quota.remainingMs(token) : Number.POSITIVE_INFINITY;
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(
      JSON.stringify({
        ok: true,
        dailyMinutes: quota.enabled ? quota.dailyMs / 60_000 : null,
        remainingMinutes: Number.isFinite(remainingMs) ? Math.floor(remainingMs / 60_000) : null,
        resetsInMinutes: quota.enabled ? Math.ceil(quota.resetsInMs() / 60_000) : null,
      }),
    );
    return;
  }
  if (req.url === "/metrics") {
    if (tokens.size > 0 && !authorize(req)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(relay.metrics.render());
    return;
  }
  res.writeHead(404).end();
});
http.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/v1/session")) relay.handleUpgrade(req, socket, head);
  else {
    log("ws.bad_path", { path: req.url, ip: clientIp(req, trustProxy) });
    socket.destroy();
  }
});
http.listen(port, () => {
  log("relay.listening", {
    port,
    auth: tokens.size > 0 ? "token" : "open",
    dailyMinutes: quota.enabled ? quota.dailyMs / 60_000 : "unlimited",
    origins: origins.size,
    providers: {
      asr: env.ASR_PROVIDER ?? "mock",
      mt: env.MT_PROVIDER ?? "mock",
      tts: env.TTS_PROVIDER ?? "mock",
    },
  });
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("relay.shutdown", { signal: sig, sessions: relay.sessionCount });
    await relay.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
