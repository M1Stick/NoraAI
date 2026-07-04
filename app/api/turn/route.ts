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

export async function POST(req: NextRequest) {
  try {
    const { audioBase64, userText: directText, language, history }: TurnBody = await req.json();

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

    // 3) Voice the reply.
    const { audioBase64: replyAudio, mime } = await synthesize(agentText);

    return NextResponse.json({ userText, agentText, audioBase64: replyAudio, audioMime: mime });
  } catch (err: any) {
    console.error("[/api/turn]", err?.message || err);
    return NextResponse.json(
      { error: "Something broke in the pipeline. Check the server logs and your Inworld key." },
      { status: 500 }
    );
  }
}
