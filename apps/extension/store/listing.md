# Chrome Web Store listing kit

Everything needed to submit `dist/fyv-<version>-chrome.zip` (built with `pnpm --filter @fyv/extension zip`).
Screenshots in `assets/` are rendered from `scenes/*.html` (a Meet-like stage + the real popup stylesheet)
— regenerate after any popup UI change. Nothing in this folder ships inside the extension.

## Store listing

| Field | Value |
| --- | --- |
| Name | fyv – Live Call Translation |
| Summary (≤132) | Hear Google Meet participants in your language, in real time. Speech-to-speech translation in under a second. |
| Category | Communication |
| Language | English |
| Homepage | https://fyv.si |
| Support | https://github.com/vaishakh3/fyv/issues |
| Privacy policy | https://fyv.si/privacy |
| Icon | `public/icons/icon-128.png` |
| Screenshots (1280×800) | `assets/captions.png`, `assets/popup.png`, `assets/idle.png` |
| Small promo tile (440×280) | `assets/tile.png` |

### Description

fyv lets you hear the other people in a Google Meet call in your own language — as speech, not just captions — about a second behind the speaker.

Only the listener installs it. Nobody else in the call needs to do anything.

How it works
• Press "Translate this call" on a Meet tab. fyv listens to the call audio, recognises the speech, translates it, and speaks the translation to you with a natural voice.
• The original speaker is ducked (quieter) under the translation, so you keep the rhythm and tone of the call.
• Live bilingual captions appear inside Meet so you can glance at the original sentence.
• A latency readout shows exactly how far behind the speaker you are (typically 0.7–1.0 s).

Languages
English → Hindi and English → Malayalam at launch. More pairs are being added — see fyv.si for the current list.

Access
fyv is in beta. You need an access code from fyv.si to start; each code has a daily minute budget. Self-hosting is also supported: the relay is open source (MIT) and the advanced settings let you point the extension at your own server with your own vendor keys.

Privacy
Audio is translated, never recorded: it streams through the fyv relay to speech vendors and is discarded as soon as the translated audio has been sent back. No accounts, no ads, no analytics. Full policy: https://fyv.si/privacy

## Privacy practices tab

**Single purpose**: Translate the speech of a Google Meet call into the listener's language in real time (translated speech plus bilingual captions).

**Permission justifications**

- `tabCapture` — Captures the audio of the Google Meet tab the user is in so it can be translated, and is the output path for the translated speech. Capture starts only when the user presses "Translate this call" and stops when they press Stop or the tab closes.
- `offscreen` — The audio pipeline (resampling, voice-activity detection, playback and ducking) runs in AudioWorklets, which need a document; MV3 service workers cannot host them. The offscreen document exists only while a translation session is running.
- `storage` — Persists the user's language pair, access code and (advanced) relay URL via `chrome.storage.sync`.
- `activeTab` — Lets the popup identify the current tab so it can tell whether it is a Meet call and start capture on it.
- Host permission `https://meet.google.com/*` — Injects the caption overlay (a closed shadow root) into Meet so translated/original sentences show on top of the call. The content script does not read or modify the Meet page.

**Remote code**: No. All code ships in the package; the extension only exchanges audio and JSON over a WebSocket with the fyv relay.

**Data usage disclosures**
- Collected: *Personal communications* (call audio, sent to the relay for translation; not stored) and *Authentication information* (the access code, stored locally in `chrome.storage.sync` and sent to the relay to authorise a session).
- Not collected: PII, health, financial, location, web history, user activity, website content.
- Certifications: data is not sold; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

## Submission checklist

1. Register the developer account (one-time fee) with the Google account that should own the listing.
2. `pnpm --filter @fyv/extension zip` → upload `dist/fyv-<version>-chrome.zip`.
3. Paste the listing fields above; upload icon, 3 screenshots, promo tile.
4. Fill the Privacy practices tab from the section above; set the privacy policy URL.
5. Distribution: public (or unlisted while in beta — the link still works for invitees).
6. After approval, set `STORE_URL` in `apps/web/src/main.ts` to the listing URL so every "Get the extension" button on fyv.si points at the store.

Review notes to expect: `tabCapture` extensions get a manual review. The reviewer can test without an access code only as far as the "Access code not recognised" message; include a test code in the review notes field.
