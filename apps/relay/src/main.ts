import { createServer } from "node:http";
import { providersFromEnv } from "@parley/providers";
import { RelayServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const relay = new RelayServer({
  providers: () => providersFromEnv(process.env),
  log: (msg, data) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data })),
  maxSessions: Number(process.env.MAX_SESSIONS ?? 50),
});

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: relay.sessionCount }));
    return;
  }
  res.writeHead(404).end();
});
http.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/v1/session")) relay.handleUpgrade(req, socket, head);
  else socket.destroy();
});
http.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "relay.listening",
      port,
      providers: {
        asr: process.env.ASR_PROVIDER ?? "mock",
        mt: process.env.MT_PROVIDER ?? "mock",
        tts: process.env.TTS_PROVIDER ?? "mock",
      },
    }),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await relay.close();
    http.close(() => process.exit(0));
  });
}
