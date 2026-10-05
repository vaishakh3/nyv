import type {
  Broadcast,
  ContentMessage,
  OffscreenCommand,
  PopupCommand,
  Settings,
  Status,
} from "../lib/messages.js";
import { IDLE_STATUS } from "../lib/messages.js";

const OFFSCREEN_URL = "/offscreen.html";
let status: Status = { ...IDLE_STATUS };
let activeTabId: number | undefined;

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: PopupCommand | Broadcast, _sender, sendResponse) => {
    if ("target" in msg) {
      if (msg.target !== "background") return false;
      if (msg.type === "status") {
        status = { ...msg.status, ...(activeTabId !== undefined ? { tabId: activeTabId } : {}) };
        if (status.state === "idle") activeTabId = undefined;
        void chrome.storage.session.set({ status });
        forwardToTab({ type: "status", status });
        return false;
      }
      forwardToTab({ type: "caption", caption: msg.caption });
      return false;
    }
    switch (msg.type) {
      case "start":
        start(msg.tabId, msg.settings).then(
          () => sendResponse({ ok: true }),
          (err) =>
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        return true;
      case "stop":
        stop().then(() => sendResponse({ ok: true }));
        return true;
      case "getStatus":
        sendResponse(status);
        return false;
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabId) void stop();
  });
});

async function start(tabId: number, settings: Settings): Promise<void> {
  if (activeTabId !== undefined && activeTabId !== tabId) await stop();
  await ensureOffscreen();
  const streamId = await new Promise<string>((resolve, reject) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id),
    ),
  );
  activeTabId = tabId;
  const res = (await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    streamId,
    settings,
  } satisfies OffscreenCommand)) as { ok: boolean; error?: string } | undefined;
  if (!res?.ok) {
    activeTabId = undefined;
    throw new Error(res?.error ?? "audio engine did not respond");
  }
}

async function stop(): Promise<void> {
  if (await hasOffscreen()) {
    await chrome.runtime
      .sendMessage({ target: "offscreen", type: "stop" } satisfies OffscreenCommand)
      .catch(() => {});
  }
  activeTabId = undefined;
  status = { ...IDLE_STATUS };
  void chrome.storage.session.set({ status });
}

async function hasOffscreen(): Promise<boolean> {
  return chrome.offscreen.hasDocument();
}

let creating: Promise<void> | undefined;
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = createOffscreen().finally(() => {
      creating = undefined;
    });
  }
  await creating;
}

async function createOffscreen(): Promise<void> {
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Capture Meet audio, play translated speech",
  });
}

function forwardToTab(m: ContentMessage): void {
  if (activeTabId === undefined) return;
  chrome.tabs.sendMessage(activeTabId, m).catch(() => {});
}
