// Thin server-side wrappers around the three Inworld REST endpoints we use:
//   STT  -> POST /stt/v1/transcribe
//   LLM  -> POST /v1/chat/completions   (OpenAI-compatible Router, 200+ models)
//   TTS  -> POST /tts/v1/voice          (returns base64 audio; TTS-2 is expressive)
//
// Auth for every call is:  Authorization: Basic <INWORLD_API_KEY>
// The Inworld API key is ALREADY base64-encoded ("Basic" key), so we pass it as-is.

const API_BASE = "https://api.inworld.ai";

function authHeaders(): Record<string, string> {
  const key = process.env.INWORLD_API_KEY;
  if (!key) throw new Error("INWORLD_API_KEY is not set");
  return {
    Authorization: `Basic ${key}`,
    "Content-Type": "application/json",
  };
}

const LANG_MAP: Record<string, string> = { en: "en-US", ru: "ru-RU" };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// 1) Speech -> text. audioBase64 is the raw base64 of the recorded clip (webm/opus, etc.).
export async function transcribe(audioBase64: string, language: string): Promise<string> {
  const res = await fetch(`${API_BASE}/stt/v1/transcribe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      transcribeConfig: {
        modelId: "inworld/inworld-stt-1",
        audioEncoding: "AUTO_DETECT",
        language: LANG_MAP[language] ?? "en-US",
      },
      audioData: { content: audioBase64 },
    }),
  });
  if (!res.ok) throw new Error(`STT failed (${res.status}): ${await safeText(res)}`);
  const data = await res.json();
  return (data?.transcription?.transcript ?? "").trim();
}

// 2) Text -> reply, via the LLM Router. Model is configurable; persona is passed in.
// Note: reasoning models (gpt-5.5 etc.) spend tokens on internal thinking BEFORE
// answering, and that thinking counts against max_tokens. Too small a cap means the
// model burns the whole budget reasoning and returns empty content — so the cap is
// generous; Nora's persona keeps the actual spoken reply short.
export async function complete(messages: ChatMessage[]): Promise<string> {
  const model = process.env.INWORLD_LLM_MODEL || "openai/gpt-5.5";
  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model, messages, max_tokens: 2048 }),
  });
  if (!res.ok) throw new Error(`LLM failed (${res.status}): ${await safeText(res)}`);
  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) {
    console.error(
      `[llm] empty content; finish_reason=${data?.choices?.[0]?.finish_reason}; usage=${JSON.stringify(data?.usage ?? {})}`
    );
  }
  return text;
}

// 3) Text -> speech. TTS-2 renders inline [tags]; other models would read them aloud,
//    so we strip bracketed tags unless the expressive model is selected.
//    Inworld TTS caps each request at ~2000 characters, so long replies are split
//    at sentence boundaries and the MP3 chunks are concatenated server-side.
const TTS_CHUNK_LIMIT = 1500;

export async function synthesize(text: string): Promise<{ audioBase64: string; mime: string }> {
  const voiceId = process.env.INWORLD_VOICE_ID || "Sarah";
  const modelId = process.env.INWORLD_TTS_MODEL || "inworld-tts-2";
  const spoken = modelId === "inworld-tts-2" ? text : stripTags(text);

  const pieces = chunkBySentence(spoken, TTS_CHUNK_LIMIT);
  const buffers: Buffer[] = [];

  for (const piece of pieces) {
    const res = await fetch(`${API_BASE}/tts/v1/voice`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: piece, voiceId, modelId }),
    });
    if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await safeText(res)}`);
    const data = await res.json();
    const b64 = data?.audioContent ?? "";
    if (!b64) {
      throw new Error(
        `TTS returned no audio for a ${piece.length}-char chunk. Response: ${JSON.stringify(data).slice(0, 300)}`
      );
    }
    buffers.push(Buffer.from(b64, "base64"));
  }

  return { audioBase64: Buffer.concat(buffers).toString("base64"), mime: "audio/mpeg" };
}

// Split text into chunks under `limit` chars, cutting at sentence ends where possible.
export function chunkBySentence(text: string, limit: number): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return [clean];
  const sentences = clean.match(/[^.!?\n]+[.!?]*\s*/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > limit && current) {
      chunks.push(current.trim());
      current = "";
    }
    // A single sentence longer than the limit gets hard-split.
    if (s.length > limit) {
      for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit).trim());
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// Remove [warm], [sigh], etc. for non-expressive TTS models.
export function stripTags(text: string): string {
  return text.replace(/\[[^\]]{1,24}\]/g, "").replace(/\s{2,}/g, " ").trim();
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
