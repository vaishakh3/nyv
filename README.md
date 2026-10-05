# nyv

Real-time speech-to-speech translation for video calls. One participant speaks English; the other hears
Hindi (or Spanish, French, German, Japanese, Portuguese) about a second and a half later, with bilingual captions.

**Status: v0 — working end-to-end against mock providers; vendor adapters written, pending API keys.**

## How it works

```
Meet tab audio ─► capture worklet (16 kHz, VAD) ─► WebSocket ─► relay ─► streaming ASR
                                                                   │
speakers ◄─ playback worklet (jitter buffer, catch-up) ◄─ PCM ◄── streaming TTS ◄─ LLM translation
                                                                   (speculative, segment-pipelined)
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
| `packages/providers` | `mock`, Deepgram (ASR), OpenAI-compatible (MT), ElevenLabs (TTS) adapters |
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
ASR_PROVIDER=deepgram   DEEPGRAM_API_KEY=...
MT_PROVIDER=openai      OPENAI_API_KEY=...   # OPENAI_BASE_URL works for any OpenAI-compatible endpoint
TTS_PROVIDER=elevenlabs ELEVENLABS_API_KEY=...
```

Then `pnpm --filter @nyv/relay dev`, and benchmark with a real recording: `pnpm bench --wav sample-16k.wav`.

## Benchmark & gate

`pnpm bench --runs 3 --baseline tools/bench/baseline.json --tolerance 0.10` prints per-hop percentiles and
fails if perceived latency regresses by more than the tolerance. Update the baseline deliberately
(`pnpm bench --out tools/bench/baseline.json`) when a change is meant to shift it.

## Roadmap

1. **Now** — EN→HI inbound mode in Meet, mock + Deepgram/OpenAI/ElevenLabs adapters, bench gate.
2. Provider bake-off with real keys; tune segmenter thresholds against measured p50/p95.
3. Outbound mode (speak your language, they hear theirs) and the remaining launch languages.
4. Tauri desktop app with virtual mic/speaker (works in Zoom, Teams, Discord), voice cloning.

## Privacy

Audio is streamed, never stored. The relay keeps no transcripts beyond the rolling 8-segment translation context
of a live session, which is discarded when the session ends.
