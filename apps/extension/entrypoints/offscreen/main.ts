import { Engine } from "../../lib/engine.js";
import type { Broadcast, OffscreenCommand } from "../../lib/messages.js";

const send = (m: Broadcast) => chrome.runtime.sendMessage(m).catch(() => {});

const engine = new Engine({
  onStatus: (status) => send({ target: "background", type: "status", status }),
  onCaption: (caption) => send({ target: "background", type: "caption", caption }),
});

chrome.runtime.onMessage.addListener((msg: OffscreenCommand, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;
  const run = msg.type === "start" ? engine.start(msg.streamId, msg.settings) : engine.stop();
  run
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});
