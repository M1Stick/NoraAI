import { NextRequest, NextResponse } from "next/server";
import { transcribe, complete, synthesize, type ChatMessage } from "@/lib/inworld";
import { NORA_SYSTEM_PROMPT } from "@/lib/persona";

// Node runtime: we hold the Inworld key and make outbound REST calls here.
export const runtime = "nodejs";
export const maxDuration = 60;

type TurnBody = {
  audioBase64?: string;
  userText?: string;
  language: "en" | "ru";
  history: { role: "user" | "assistant"; content: string }[];
};

// --- Rate limiting (in-memory, free, no external service) ---------------------
// Best-effort protection against someone hammering this endpoint and burning your
// Inworld credits. It lives in the server instance's memory, so it resets on cold
// starts and isn't shared across parallel instances — but it hard-caps burst abuse,
// which is the real risk for a public demo URL. For a bulletproof, persistent limit
// later, the free tier of Upstash Redis is the usual next step (needs an account).
type Bucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, Bucket>();
const globalBucket: Bucket = { count: 0, resetAt: 0 };

const PER_IP_MAX = 10; // requests per IP...
const PER_IP_WINDOW_MS = 60_000; // ...per 60 seconds
const GLOBAL_MAX = 60; // total requests on this instance...
const GLOBAL_WINDOW_MS = 60_000; // ...per 60 seconds

function checkRateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();

  // Occasionally prune expired IP buckets so the map can't grow unbounded.
  if (ipBuckets.size > 5000) {
    for (const [k, v] of ipBuckets) if (v.resetAt < now) ipBuckets.delete(k);
  }

  // Global backstop first.
  if (globalBucket.resetAt < now) {
    globalBucket.count = 0;
    globalBucket.resetAt = now + GLOBAL_WINDOW_MS;
  }
  globalBucket.count++;
  if (globalBucket.count > GLOBAL_MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((globalBucket.resetAt - now) / 1000)) };
  }

  // Per-IP window.
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + PER_IP_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  bucket.count++;
  if (bucket.count > PER_IP_MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  try {
    const { audioBase64, userText: directText, language, history }: TurnBody = await req.json();

    // Throttle before spending anything on Inworld calls.
    const { ok, retryAfter } = checkRateLimit(clientIp(req));
    if (!ok) {
      return NextResponse.json(
        {
          error:
            language === "ru"
              ? `Слишком много запросов. Подожди ${retryAfter} сек. и попробуй снова.`
              : `Too many requests. Give it ${retryAfter}s and try again.`,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    // 1) Get the user's message: either pasted/attached text, or transcribed speech.
    let userText = (directText ?? "").trim().slice(0, 9000);
    if (!userText) {
      if (!audioBase64) {
        return NextResponse.json({ error: "No audio or text received." }, { status: 400 });
      }
      userText = await transcribe(audioBase64, language);
    }
    if (!userText) {
      return NextResponse.json({
        userText: "",
        agentText:
          language === "ru"
            ? "Я не расслышала. Скажи ещё раз?"
            : "I didn't catch that. Say it again?",
        audioBase64: null,
      });
    }

    // 2) Ask Nora (LLM Router) with the full running conversation.
    // The UI language toggle wins over the language of any pasted content:
    // an English email critiqued by a Russian-speaking user gets a Russian reply.
    const langDirective =
      language === "ru"
        ? "IMPORTANT: The user's interface language is Russian. Reply ONLY in Russian, even if the email or text they shared is written in English or any other language. You may quote short fragments (like a subject line) in their original language."
        : "IMPORTANT: The user's interface language is English. Reply ONLY in English, even if the email or text they shared is written in another language. You may quote short fragments (like a subject line) in their original language.";

    const messages: ChatMessage[] = [
      { role: "system", content: NORA_SYSTEM_PROMPT },
      { role: "system", content: langDirective },
      ...history.map((m) => ({ role: m.role, content: m.content } as ChatMessage)),
      { role: "user", content: userText },
    ];
    const agentText = await complete(messages);
    if (!agentText) {
      return NextResponse.json({
        userText,
        agentText:
          language === "ru"
            ? "Я задумалась и потеряла мысль. Отправь ещё раз, пожалуйста."
            : "I lost my train of thought there. Send that again, please.",
        audioBase64: null,
      });
    }

    // 3) Voice the reply. If TTS fails, the text reply still reaches the user —
    // losing the voice is a hiccup; losing the whole answer is a bug.
    let replyAudio: string | null = null;
    let audioMime = "audio/mpeg";
    try {
      const r = await synthesize(agentText);
      replyAudio = r.audioBase64;
      audioMime = r.mime;
    } catch (err: any) {
      console.error("[/api/turn] TTS:", err?.message || err);
    }

    return NextResponse.json({ userText, agentText, audioBase64: replyAudio, audioMime });
  } catch (err: any) {
    console.error("[/api/turn]", err?.message || err);
    return NextResponse.json(
      { error: "Something broke in the pipeline. Check the server logs and your Inworld key." },
      { status: 500 }
    );
  }
}
