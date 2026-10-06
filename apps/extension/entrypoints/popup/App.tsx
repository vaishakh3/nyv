import { LANGUAGES, type LanguageCode } from "@fyv/protocol";
import { useEffect, useState } from "preact/hooks";
import { type AccessInfo, checkAccess, describeAccess } from "../../lib/access.js";
import {
  type Caption,
  DEFAULT_SETTINGS,
  IDLE_STATUS,
  type PopupCommand,
  type Settings,
  type Status,
} from "../../lib/messages.js";

const send = <T,>(m: PopupCommand) => chrome.runtime.sendMessage(m) as Promise<T>;

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<Status>(IDLE_STATUS);
  const [caption, setCaption] = useState<Caption | undefined>();
  const [tab, setTab] = useState<chrome.tabs.Tab | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [access, setAccess] = useState<{ text: string; ok: boolean } | undefined>();

  useEffect(() => {
    chrome.storage.sync
      .get("settings")
      .then((r) => r.settings && setSettings({ ...DEFAULT_SETTINGS, ...(r.settings as Settings) }));
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t));
    send<Status>({ type: "getStatus" }).then((s) => s && setStatus(s));
    const onMsg = (m: { target?: string; type: string; status?: Status; caption?: Caption }) => {
      if (m.target !== "background") return;
      if (m.type === "status" && m.status) {
        setStatus(m.status);
        // A new session starts with the previous language's last caption otherwise.
        if (m.status.state === "connecting") setCaption(undefined);
      }
      if (m.type === "caption" && m.caption) setCaption(m.caption);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void chrome.storage.sync.set({ settings: next });
  };

  // Validate the access code (debounced) whenever it or the relay changes, so the user sees
  // "42 of 90 min left today" or "not recognised" before pressing Translate.
  useEffect(() => {
    if (!settings.relayToken) {
      setAccess(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      checkAccess(settings.relayUrl, settings.relayToken).then(
        (a: AccessInfo | undefined) =>
          live && setAccess({ text: describeAccess(a), ok: (a?.remainingMinutes ?? 1) > 0 }),
        (e: unknown) =>
          live && setAccess({ text: e instanceof Error ? e.message : String(e), ok: false }),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [settings.relayToken, settings.relayUrl]);

  const onMeet = !!tab?.url?.startsWith("https://meet.google.com/");
  const capturable = !!tab?.url && /^https?:/.test(tab.url);
  const running =
    status.state === "active" || status.state === "connecting" || status.state === "reconnecting";

  const toggle = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (running) await send({ type: "stop" });
      else {
        if (!tab?.id) throw new Error("No active tab");
        const res = await send<{ ok: boolean; error?: string }>({
          type: "start",
          tabId: tab.id,
          settings,
        });
        if (!res.ok) throw new Error(res.error ?? "failed to start");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="app">
      <header>
        <h1>
          <span class="logo" /> fyv
        </h1>
        <span class={`pill ${status.state}`}>
          <span class="dot" />
          {status.state === "active" ? "live" : status.state}
        </span>
      </header>

      <div class="langs">
        <label>
          They speak
          <select
            value={settings.sourceLang}
            disabled={running}
            onChange={(e) =>
              update({ sourceLang: (e.currentTarget as HTMLSelectElement).value as LanguageCode })
            }
          >
            {Object.entries(LANGUAGES).map(([code, l]) => (
              <option key={code} value={code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          class="swap"
          title="Swap"
          disabled={running}
          onClick={() =>
            update({ sourceLang: settings.targetLang, targetLang: settings.sourceLang })
          }
        >
          ⇄
        </button>
        <label>
          I hear
          <select
            value={settings.targetLang}
            disabled={running}
            onChange={(e) =>
              update({ targetLang: (e.currentTarget as HTMLSelectElement).value as LanguageCode })
            }
          >
            {Object.entries(LANGUAGES).map(([code, l]) => (
              <option key={code} value={code}>
                {l.native}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!running && (
        <label>
          Access code
          <input
            value={settings.relayToken}
            placeholder="from your fyv invite"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => update({ relayToken: (e.currentTarget as HTMLInputElement).value })}
          />
          {access && <span class={`access ${access.ok ? "ok" : "bad"}`}>{access.text}</span>}
        </label>
      )}

      <button
        type="button"
        class={`primary ${running ? "stop" : ""}`}
        disabled={
          busy ||
          (!running && (!capturable || !settings.relayToken)) ||
          settings.sourceLang === settings.targetLang
        }
        onClick={toggle}
      >
        {running ? "Stop translating" : onMeet ? "Translate this call" : "Translate this tab"}
      </button>
      {!capturable && !running && (
        <div class="hint">
          Open a Google Meet call (or any tab playing speech), then click Translate.
        </div>
      )}
      {capturable && !onMeet && !running && (
        <div class="hint">Works on any tab with audio; in-call captions overlay is Meet-only.</div>
      )}
      {(error || status.error) && <div class="error">{error ?? status.error}</div>}

      {running && (
        <>
          <div class="stats">
            <div class="stat">
              <b>{status.latency ? `${(status.latency.p50 / 1000).toFixed(1)}s` : "–"}</b>
              <span>latency p50</span>
            </div>
            <div class="stat">
              <b>{`${(status.backlogMs / 1000).toFixed(1)}s`}</b>
              <span>backlog</span>
            </div>
            <div class="stat">
              <b>
                {status.rate > 1.02
                  ? `${status.rate.toFixed(2)}×`
                  : status.ducking
                    ? "ducked"
                    : "1.00×"}
              </b>
              <span>playback</span>
            </div>
          </div>
          <div class="caption">
            <div class="t">{caption?.target || <span class="hint">Waiting for speech…</span>}</div>
            {caption?.source && <div class="s">{caption.source}</div>}
          </div>
          {status.providers && (
            <div class="hint">{`${status.providers.asr} · ${status.providers.mt} · ${status.providers.tts}`}</div>
          )}
        </>
      )}

      <details>
        <summary>Advanced</summary>
        <div>
          <label>
            Relay URL
            <input
              value={settings.relayUrl}
              disabled={running}
              onChange={(e) => update({ relayUrl: (e.currentTarget as HTMLInputElement).value })}
            />
          </label>
          <div class="hint">Self-hosting? Point this at your own relay (see the README).</div>
        </div>
      </details>
    </div>
  );
}
