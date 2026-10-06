import { LANGUAGES, type LanguageCode } from "@fyv/protocol";
import { useEffect, useState } from "preact/hooks";
import { type AccessInfo, checkAccess, describeAccess } from "../../lib/access.js";
import {
  type Caption,
  DEFAULT_SETTINGS,
  type EngineState,
  IDLE_STATUS,
  type PopupCommand,
  type Settings,
  type Status,
} from "../../lib/messages.js";

/** Background round-trip with a deadline so a wedged worker can't leave the button spinning forever. */
const send = <T,>(m: PopupCommand, timeoutMs = 10_000) =>
  Promise.race([
    chrome.runtime.sendMessage(m) as Promise<T>,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("fyv didn't respond — try again")), timeoutMs),
    ),
  ]);

const STATE_LABEL: Record<EngineState, string> = {
  idle: "Ready",
  connecting: "Connecting",
  active: "Live",
  reconnecting: "Reconnecting",
  error: "Error",
};

const Icon = {
  chevron: () => (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  ),
  swap: () => (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5.5h11M10.5 2.5l3 3-3 3M13.5 10.5h-11M5.5 7.5l-3 3 3 3" />
    </svg>
  ),
  arrow: () => (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  check: () => (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ),
  alert: () => (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11h.01" />
    </svg>
  ),
};

const VENDORS: Record<string, string> = {
  deepgram: "Deepgram",
  groq: "Groq",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  mock: "Mock",
};

/** "deepgram-flux|deepgram" / "groq:openai/gpt-oss-20b→openai:gpt-4o-mini" → "Deepgram" / "Groq". */
/** Engine errors are terse and technical; the popup shows what happened and what to do next. */
const humanizeError = (e?: string): string | undefined => {
  if (!e) return undefined;
  if (e.startsWith("relay disconnected"))
    return "Lost the connection to the relay. Press Translate to resume.";
  if (e.startsWith("relay: ")) return e.slice(7);
  return e;
};

const vendor = (provider: string) => {
  const key =
    provider
      .split(/[|:→/-]/)[0]
      ?.trim()
      .toLowerCase() ?? "";
  return VENDORS[key] ?? key;
};

/** Mic level (dBFS, −90 = silence) → 0..1 for the live level bars. */
const levelFraction = (dbfs: number) => Math.max(0, Math.min(1, (dbfs + 54) / 48));

const LEVEL_BARS = [0.35, 0.7, 1, 0.8, 0.5];

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
  const samePair = settings.sourceLang === settings.targetLang;
  const target = LANGUAGES[settings.targetLang as LanguageCode];
  const source = LANGUAGES[settings.sourceLang as LanguageCode];
  const reconnecting = status.state === "reconnecting";
  const shownError = error ?? (reconnecting ? undefined : humanizeError(status.error));
  const pillState: EngineState = shownError && status.state === "idle" ? "error" : status.state;
  const level = levelFraction(status.level);
  const tabTitle = tab?.title?.replace(/^Meet\s[-–]\s/, "").trim();

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

  const langSelect = (key: "sourceLang" | "targetLang", native: boolean) => (
    <span class="select">
      <select
        value={settings[key]}
        disabled={running}
        aria-label={key === "sourceLang" ? "They speak" : "I hear"}
        onChange={(e) =>
          update({ [key]: (e.currentTarget as HTMLSelectElement).value as LanguageCode })
        }
      >
        {Object.entries(LANGUAGES).map(([code, l]) => (
          <option key={code} value={code}>
            {native ? l.native : l.name}
          </option>
        ))}
      </select>
      <Icon.chevron />
    </span>
  );

  return (
    <div class={`app ${running ? "is-running" : ""}`}>
      <header class="top">
        <div class="brand">
          <span class="mark" aria-hidden="true" />
          <span class="word">fyv</span>
        </div>
        <span class={`state ${pillState}`}>
          <i class="dot" />
          {STATE_LABEL[pillState]}
        </span>
      </header>

      <section class="pair" aria-label="Language pair">
        <div class="field">
          <span class="k">They speak</span>
          {langSelect("sourceLang", false)}
        </div>
        <button
          type="button"
          class="swap"
          title="Swap languages"
          aria-label="Swap languages"
          disabled={running}
          onClick={() =>
            update({ sourceLang: settings.targetLang, targetLang: settings.sourceLang })
          }
        >
          <Icon.swap />
        </button>
        <div class="field">
          <span class="k">I hear</span>
          {langSelect("targetLang", true)}
        </div>
      </section>

      {running ? (
        <section class="live" aria-live="polite">
          <div class="live-bar">
            <span class={`live-tag ${status.state}`}>
              <i class="dot" />
              {status.state === "active"
                ? `${source.name} → ${target.name}`
                : STATE_LABEL[status.state]}
            </span>
            <span class="live-tab" title={tabTitle}>
              {onMeet ? "Google Meet" : tabTitle || "this tab"}
            </span>
          </div>
          <div class="cap">
            {caption?.target ? (
              <>
                <p
                  class={`t ${caption.final ? "" : "pending"} ${caption.held ? "held" : ""}`}
                  lang={settings.targetLang}
                >
                  {caption.target}
                </p>
                {caption.source && (
                  <p class={`s ${caption.held ? "incoming" : ""}`} lang={settings.sourceLang}>
                    {caption.source}
                    {caption.held && <i class="caret" />}
                  </p>
                )}
              </>
            ) : (
              <p class="waiting">
                {status.state === "active" ? "Listening for speech" : "Connecting to the relay"}
                <i class="caret" />
              </p>
            )}
          </div>
          <div class="meter">
            <div class="m">
              <span class="k">latency</span>
              <b class={status.latency && status.latency.p50 > 1500 ? "slow" : ""}>
                {status.latency ? `${(status.latency.p50 / 1000).toFixed(1)}s` : "—"}
              </b>
            </div>
            <div class="m">
              <span class="k">behind</span>
              <b>{`${(status.backlogMs / 1000).toFixed(1)}s`}</b>
            </div>
            <div class="m">
              <span class="k">speed</span>
              <b>{status.rate > 1.02 ? `${status.rate.toFixed(2)}×` : "1.00×"}</b>
            </div>
            <div
              class={`level ${status.ducking ? "ducking" : ""}`}
              title={status.ducking ? "Original voice ducked" : "Original voice level"}
            >
              {LEVEL_BARS.map((h) => (
                <i key={h} style={{ height: `${Math.max(0.12, level * h) * 100}%` }} />
              ))}
            </div>
          </div>
        </section>
      ) : (
        <div class="field code">
          <span class="k">Access code</span>
          <span class={`input ${access ? (access.ok ? "ok" : "bad") : ""}`}>
            <input
              value={settings.relayToken}
              placeholder="from your fyv invite"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => update({ relayToken: (e.currentTarget as HTMLInputElement).value })}
            />
            {access && (access.ok ? <Icon.check /> : <Icon.alert />)}
          </span>
          {access && <span class={`note ${access.ok ? "ok" : "bad"}`}>{access.text}</span>}
        </div>
      )}

      <button
        type="button"
        class={`cta ${running ? "stop" : ""}`}
        disabled={busy || (!running && (!capturable || !settings.relayToken)) || samePair}
        onClick={toggle}
      >
        {running ? (
          "Stop translating"
        ) : (
          <>
            {onMeet ? "Translate this call" : "Translate this tab"}
            <Icon.arrow />
          </>
        )}
      </button>

      {shownError && (
        <p class="alert">
          <Icon.alert />
          {shownError}
        </p>
      )}
      {reconnecting && !shownError && (
        <p class="hint warn">Connection dropped — reconnecting, audio keeps playing.</p>
      )}
      {!running && !shownError && (
        <p class="hint">
          {samePair
            ? "Pick two different languages."
            : !capturable
              ? "Open a Google Meet call, or any tab playing speech, then come back here."
              : onMeet
                ? `You'll hear ${target.name} over the call, with captions on the Meet page.`
                : `You'll hear ${target.name} over this tab's audio. In-call captions are Meet-only.`}
        </p>
      )}
      {running && status.providers && (
        <p class="hint providers" title={Object.values(status.providers).join(" · ")}>
          {[status.providers.asr, status.providers.mt, status.providers.tts]
            .map(vendor)
            .join(" · ")}
        </p>
      )}

      <details class="advanced">
        <summary>
          Advanced
          <Icon.chevron />
        </summary>
        <div class="field">
          <span class="k">Relay URL</span>
          <span class="input">
            <input
              value={settings.relayUrl}
              disabled={running}
              spellcheck={false}
              onChange={(e) => update({ relayUrl: (e.currentTarget as HTMLInputElement).value })}
            />
          </span>
          <span class="note">Self-hosting? Point this at your own relay (see the README).</span>
        </div>
      </details>
    </div>
  );
}
