# Nora — Live Voice Email-Strategy Consultant

A real-time voice agent you can *talk to*. Nora is a senior email-marketing
strategist: bring her a subject line, an email, or a full campaign, and she
critiques it out loud — deliverability risks, weak CTAs, segmentation, the works.

Built on the **Inworld** voice stack: speech-to-text, the LLM Router (200+ models),
and **expressive TTS-2**, which renders inline direction like `[warm]` and `[thoughtful]`
as real prosody. Bilingual (English / Russian).

![status](https://img.shields.io/badge/build-passing-5fd0c4) ![stack](https://img.shields.io/badge/Inworld-STT%20%C2%B7%20Router%20%C2%B7%20TTS--2-5fd0c4)

---

## How it works

```
Browser (mic)                       Next.js server (/api/turn)                 Inworld
  press to talk ── audio (base64) ──►  1. STT   /stt/v1/transcribe      ──────►  transcript
                                       2. LLM   /v1/chat/completions     ──────►  Nora's reply
                                          (Nora persona + conversation)
                                       3. TTS   /tts/v1/voice            ──────►  spoken audio
  play reply  ◄── transcript + audio ──
```

The Inworld API key lives **only** on the server, in an environment variable. The
browser never sees it. One HTTP round trip per turn; the running conversation is kept
in React state and replayed to the model each turn so Nora remembers context.

## Project layout

```
app/
  page.tsx          # the "Signal Room" UI + mic capture (client)
  api/turn/route.ts # the STT -> LLM -> TTS pipeline (server)
  globals.css       # design system
lib/
  persona.ts        # Nora's system prompt (the "brain")
  inworld.ts        # thin wrappers around the 3 Inworld endpoints
```

## Run it locally

Requirements: Node 18+.

```bash
npm install
cp .env.example .env.local     # then fill in your Inworld key + voice
npm run dev                     # http://localhost:3000
```

Fill `.env.local`:

| Variable             | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `INWORLD_API_KEY`    | Your Inworld key (already base64 — paste as-is).                  |
| `INWORLD_VOICE_ID`   | Voice name from the Inworld Voice Playground (e.g. `Sarah`).      |
| `INWORLD_TTS_MODEL`  | `inworld-tts-2` (expressive) or `inworld-tts-1.5-max` (fallback). |
| `INWORLD_LLM_MODEL`  | Any Router model, e.g. `openai/gpt-5.5`.                          |

Get the key at https://platform.inworld.ai → API keys.

## Deploy (Vercel — the easy path)

1. Push this folder to a new GitHub repo.
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Under **Environment Variables**, add the four variables above.
4. **Deploy.** You get a public `https://…vercel.app` URL for your portfolio.

> Voice capture needs HTTPS. Vercel gives you HTTPS automatically. (Locally,
> `localhost` is treated as secure, so the mic works there too.)

## A note on cost

Your `$50` of Inworld credit is plenty for a demo. TTS is billed per character and
Nora's replies are short; a full spoken conversation costs cents. STT and the LLM are
metered separately at provider rates. You will not burn the balance testing this.

## Design

The interface is a dark "Signal Room" voice console. The signature element is the
central signal ring: it breathes at rest, reacts to your voice while listening, and
pulses while Nora speaks. Teal is the healthy-signal accent; amber is reserved for the
"deliverability warning" register — the same visual language Nora speaks in.

## Roadmap (v2)

This v1 is a robust push-to-talk pipeline (three REST calls). The natural upgrade is
Inworld's **Realtime API** — a single WebSocket that streams STT + Router + TTS-2 with
sub-200ms latency, native barge-in (interrupt Nora mid-sentence), and turn-taking
handled server-side. The persona and design carry over unchanged; only the transport
swaps. Documented here as the intended next step.

---

Built by directing the design and domain logic; voice infrastructure by Inworld.
