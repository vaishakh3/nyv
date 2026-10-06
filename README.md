# nyv

Real-time speech-to-speech translation for video calls. One participant speaks English; the other hears
Hindi (or Spanish, French, German, Japanese, Portuguese) about a second and a half later, with bilingual captions.

**Status: v0.3 — runs end-to-end on real vendors (Deepgram Flux → Groq → ElevenLabs) at ~0.9 s p50 phrase-end → translated audio, and survives vendor/relay socket drops mid-call.**

## How it works

```
Meet tab audio ─► capture worklet (16 kHz, VAD) ─► WebSocket ─► relay ─► streaming ASR
                                                                   │
speakers ◄─ playback worklet (jitter buffer, catch-up) ◄─ PCM ◄── streaming TTS ◄─ LLM translation
                                                                   (segment-pipelined, pre-warmed)
```

The latency edge is in the pipeline, not the models:

- **Segmenter + LocalAgreement** (`packages/core`): translates on ASR partials, commits words once consecutive
  hypotheses agree, cuts segments at punctuation / pauses / a max duration — never waits for a full sentence.
- **Pipelining**: segment N+1 is translated while N is still being synthesized; `AudioSequencer` keeps playback in order.
- **Streaming everywhere**: ASR partials → token-streamed MT → stream-input TTS → binary PCM frames (no base64).
- **Catch-up playback** (`packages/audio`): pitch-preserving time stretch kicks in smoothly when the backlog grows
  (Hindi runs ~15–20 % longer than English), so the listener never drifts seconds behind.
- **Ducking, not muting**: the original voice stays audible at −18 dB for prosody and turn-taking.
- **Per-hop tracing**: every segment carries `speechEnd → asrFinal → mtFirstToken → ttsFirstByte → playbackStart`,
  and `tools/bench` gates CI on the perceived-latency p50/p95.

## Layout

| Path | What |
| --- | --- |
| `packages/protocol` | Wire format: zod control messages + 16-byte binary PCM frame header |
| `packages/core` | Provider interfaces, segmenter, LocalAgreement, `TranslationSession`, tracer |
| `packages/providers` | `mock`, Deepgram (ASR), OpenAI-compatible incl. Groq (MT), ElevenLabs (TTS) adapters |
| `packages/audio` | Resampler, VAD, ring buffer, time stretch, ducking policy, AudioWorklets |
| `apps/relay` | WebSocket session server (`ws://host/v1/session`), `/healthz` |
| `apps/extension` | Chrome MV3 extension (WXT + Preact): tabCapture → offscreen engine → captions overlay |
| `tools/bench` | Replay harness: per-hop p50/p95 + regression gate |

## Quick start (no API keys)

```sh
corepack enable && pnpm install
pnpm check                       # lint + typecheck + tests
pnpm bench                       # end-to-end latency table against mock providers
pnpm --filter @nyv/relay dev  # relay on :8787 with mock providers
pnpm --filter @nyv/extension build
```

Load `apps/extension/dist/chrome-mv3` via `chrome://extensions` → *Load unpacked*, open a Google Meet
(or any tab playing speech), click the nyv icon → **Translate this call**. With mock providers you will hear
tones and see a scripted transcript — the point is to exercise the full audio path and measure latency.

## Real providers

Copy `.env.example` to `.env` and set:

```
ASR_PROVIDER=deepgram   DEEPGRAM_API_KEY=...   # English → Flux (turn-aware), other languages → Nova-3. DEEPGRAM_FLUX=0 forces Nova-3
MT_PROVIDER=groq        GROQ_API_KEY=...       # GROQ_MODEL (default openai/gpt-oss-20b)
MT_FALLBACK_PROVIDER=openai OPENAI_API_KEY=... # takes over a segment when Groq 429s/stalls before its first token
#   or: MT_PROVIDER=openai                     # OPENAI_MODEL, OPENAI_BASE_URL for any OpenAI-compatible endpoint
TTS_PROVIDER=elevenlabs ELEVENLABS_API_KEY=... # ELEVENLABS_VOICE_ID (free tier: premade voices only)
```

Then `pnpm --filter @nyv/relay dev`, and benchmark with a real recording: `pnpm bench --wav sample-16k.wav`.

### Measured (real vendors, 32 s continuous EN monologue, 11 sentences, few pauses)

| stack | perceived p50 | p95 | ASR final | MT first token | TTS first byte |
|---|---|---|---|---|---|
| **Deepgram Flux** → Groq gpt-oss-20b → ElevenLabs Flash v2.5 | **0.86–0.89 s** | **1.4–1.8 s** | 350 ms | 140–240 ms | 220 ms |
| Deepgram Nova-3 → Groq gpt-oss-20b → ElevenLabs Flash v2.5 | 1.04–1.10 s | 2.1–2.2 s | 620 ms | 160–200 ms | 220 ms |
| Deepgram Nova-3 → OpenAI gpt-4o-mini → ElevenLabs Flash v2.5 (3-sentence clip) | 1.47–1.78 s | — | 585 ms | 500–750 ms | 330–360 ms |

What moved the number, in order: (1) **Flux** emits word-timed hypotheses every ~250 ms instead of Nova's
~1 s interims, so LocalAgreement commits words — and the segmenter cuts on punctuation — while the speaker is
still talking; the ASR hop halves and, more importantly, the p95 no longer waits 1.5 s for a vendor `is_final`
in pause-less speech. (2) The MT hop: Groq's time-to-first-token is 3–5× lower than OpenAI's for the same
quality of Hindi. (3) One ElevenLabs stream-input socket pre-opened per session so the first byte is never
behind a WS + TLS handshake (`ELEVENLABS_PREWARM=0` to disable), and one warm HTTP connection to the MT vendor.

Flux trade-offs we accepted: it is English-only (other source languages route to Nova-3 automatically), has no
`smart_format` ("12%" is spoken as "twelve percent" — the translation is identical), and we observed one
misheard name on the clip ("Priya" → "Pre"), which Nova-3 got right.

**Backlog control** has two layers. When the listener's queued Hindi exceeds ~1.2 s the relay asks the voice
to speak faster (linearly up to 1.15× at 4 s behind — a brisk speaker, still natural); the client's
pitch-preserving time-stretch (up to 1.35×) handles the rest. Both relax as soon as the backlog drains.

**Resilience.** The ASR vendor socket is re-opened with backoff when it drops mid-call: audio arriving in the
gap is buffered (≤ 15 s) and replayed, and word times are re-based onto the session timeline so segments stay
ordered. An MT request that fails or stalls before its first token is retried once and then handed to
`MT_FALLBACK_PROVIDER`; once tokens have reached the listener we never switch voices mid-sentence. The
extension re-opens the relay link (300 ms → 5 s backoff, ~9 s budget) while capture and playback keep running.

**Speculative MT** (`TranslationSession({ speculative: true })`, `pnpm bench --speculation`) translates
stable partials before the segment closes and adopts the result when the final transcript matches. It is
off by default: with Nova-3's ~1 s interims the hypothesis never matched (0 % hit rate); with Flux it adopts
~40 % of segments (−100 ms on those), but doubles MT requests, which on Groq's free tier trips the 30 RPM
limit. Worth enabling on a paid MT tier.

## Running the relay in production

The relay is a single stateless Node process (one WebSocket per call); scale horizontally behind any
TLS-terminating proxy. `apps/relay/Dockerfile` builds a ~150 MB image, `apps/relay/fly.toml` deploys it
(`fly deploy -c apps/relay/fly.toml` from the repo root, after `fly secrets set` for the vendor keys).

| env | default | purpose |
|---|---|---|
| `RELAY_TOKENS` | _(open)_ | comma-separated bearer tokens; clients send `?token=` (the extension's **Relay token** field) |
| `ALLOWED_ORIGINS` | _(any)_ | comma-separated `Origin` allow-list, e.g. `chrome-extension://<id>` |
| `MAX_SESSIONS` / `MAX_SESSIONS_PER_IP` | 50 / 3 | concurrency caps (vendor quotas, abuse) |
| `MAX_SESSION_MINUTES` / `IDLE_MINUTES` | 180 / 5 | hard session lifetime; stop when no audio arrives |
| `TRUST_PROXY` | off | take the client IP from `X-Forwarded-For` |

Endpoints: `GET /healthz`, `GET /metrics` (Prometheus text: sessions, segments, rejections, perceived-latency
p50/p95/p99 over the last 2000 segments; bearer-protected when `RELAY_TOKENS` is set), `WS /v1/session`.
Logs are one JSON object per line; each `session.stop` carries the session's segment count and p50.

## Landing page (`apps/web`)

Static Vite site for [nyv.si](https://nyv.si): `pnpm --filter @nyv/web dev` / `build` (output `apps/web/dist`).
Deployed by connecting the repo to Vercel with **Root Directory = `apps/web`** (framework preset: Vite;
`apps/web/vercel.json` adds security + cache headers). No build step runs at the repo root.

## Benchmark & gate

`pnpm bench --runs 3 --baseline tools/bench/baseline.json --tolerance 0.10` prints per-hop percentiles and
fails if perceived latency regresses by more than the tolerance. Update the baseline deliberately
(`pnpm bench --out tools/bench/baseline.json`) when a change is meant to shift it.

## Roadmap

1. ~~EN→HI inbound mode in Meet, mock + Deepgram/OpenAI/ElevenLabs adapters, bench gate.~~
2. ~~Provider bake-off with real keys~~ → Groq MT, TTS pre-warm (~1.0 s p50); ~~ASR bake-off~~ → Deepgram
   Flux (~0.9 s p50, p95 under 2 s); production relay (auth, limits, metrics); reconnects at every hop.
3. Outbound mode (speak your language, they hear theirs) and the remaining launch languages.
4. Tauri desktop app with virtual mic/speaker (works in Zoom, Teams, Discord), voice cloning.

## Privacy

Audio is streamed, never stored. The relay keeps no transcripts beyond the rolling 8-segment translation context
of a live session, which is discarded when the session ends.
