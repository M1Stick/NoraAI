"use client";

import { useEffect, useRef, useState } from "react";

type Lang = "en" | "ru";
type Status = "idle" | "listening" | "thinking" | "speaking";
type Turn = { role: "user" | "assistant"; content: string };

const OPENING: Record<Lang, string> = {
  en: "Hey, I'm Nora. Bring me a subject line, an email, or a whole campaign, and I'll tell you what's working and what's quietly killing your results. What are we looking at?",
  ru: "Привет, я Нора. Принеси мне тему письма, само письмо или целую кампанию — и я скажу, что работает, а что тихо убивает твои результаты. Что у нас есть?",
};

const STATUS_LABEL: Record<Lang, Record<Status, string>> = {
  en: { idle: "Tap to talk", listening: "Listening — tap to send", thinking: "Nora is thinking", speaking: "Nora is speaking" },
  ru: { idle: "Нажми, чтобы говорить", listening: "Слушаю — нажми, чтобы отправить", thinking: "Нора думает", speaking: "Нора говорит" },
};

// Strip inline voice tags like [warm] so they never show in the transcript.
function clean(text: string): string {
  return text.replace(/\[[^\]]{1,24}\]/g, "").replace(/\s{2,}/g, " ").trim();
}

export default function Home() {
  const [lang, setLang] = useState<Lang>("en");
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const busy = status === "thinking" || status === "speaking";

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, status]);

  function stopMeter() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    acRef.current?.close().catch(() => {});
    acRef.current = null;
    setScale(1);
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = handleStop;
      rec.start();
      setStatus("listening");

      // Reactive ring: scale with mic volume.
      const ac = new AudioContext();
      acRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        setScale(1 + Math.min(avg / 140, 0.5));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setError(lang === "ru" ? "Нет доступа к микрофону. Разреши его в браузере." : "No mic access. Allow it in your browser.");
      setStatus("idle");
    }
  }

  function stopRecording() {
    stopMeter();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStatus("thinking");
  }

  async function handleStop() {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    if (blob.size < 1200) {
      setStatus("idle");
      return;
    }
    // Inworld STT chokes on webm/opus containers; convert to WAV 16kHz mono
    // in the browser so the server always receives a format it can decode.
    let base64: string;
    try {
      base64 = await blobToWavBase64(blob);
    } catch {
      base64 = await blobToBase64(blob);
    }
    await sendTurn({ audioBase64: base64 });
  }

  async function sendTurn(payload: { audioBase64?: string; userText?: string }) {
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          language: lang,
          history: turns.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed");

      const next: Turn[] = [];
      if (data.userText) next.push({ role: "user", content: data.userText });
      if (data.agentText) next.push({ role: "assistant", content: clean(data.agentText) });
      if (next.length) setTurns((prev) => [...prev, ...next]);

      if (data.audioBase64) {
        playAudio(data.audioBase64, data.audioMime || "audio/mpeg");
      } else {
        setStatus("idle");
      }
    } catch (e: any) {
      setError(e?.message || "Something went wrong.");
      setStatus("idle");
    }
  }

  function playAudio(b64: string, mime: string) {
    const audio = new Audio(`data:${mime};base64,${b64}`);
    audioRef.current = audio;
    setStatus("speaking");
    audio.onended = () => setStatus("idle");
    audio.onerror = () => setStatus("idle");
    audio.play().catch(() => setStatus("idle"));
  }

  function onOrb() {
    if (busy) return;
    if (status === "listening") stopRecording();
    else startRecording();
  }

  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function submitText() {
    const text = draft.trim();
    if (!text || busy || status === "listening") return;
    setError(null);
    setDraft("");
    setStatus("thinking");
    await sendTurn({ userText: text });
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = await file.text();
      const cleaned = cleanEmail(raw);
      if (!cleaned) throw new Error("empty");
      setDraft((prev) => (prev ? prev + "\n\n" : "") + cleaned);
    } catch {
      setError(
        lang === "ru"
          ? "Не удалось прочитать файл. Попробуй .eml, .html, .txt или .xml."
          : "Couldn't read that file. Try .eml, .html, .txt or .xml."
      );
    }
  }

  const listening = status === "listening";
  const opening = turns.length === 0;

  return (
    <main className="shell">
      <div className="topbar">
        <span className="eyebrow">
          <span className="live-dot" /> Live voice consult
        </span>
        <div className="lang-toggle" role="group" aria-label="Language">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
          <button className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>RU</button>
        </div>
      </div>

      <div className="name-block">
        <h1 className="name">Nora</h1>
        <p className="role">
          <b>Email strategy, out loud.</b> Ten years of deliverability, subject lines, and lifecycle
          flows — as a voice you can argue with.
        </p>
      </div>

      <div className="stage">
        <button
          className={`orb ${listening ? "listening" : ""}`}
          onClick={onOrb}
          aria-label={STATUS_LABEL[lang][status]}
          style={{ ["--glow" as any]: busy ? 0.7 : 0.35 }}
        >
          <span
            className={`ring ${listening ? "wave" : "pulse"}`}
            style={{ ["--scale" as any]: listening ? scale : 1 }}
          />
          <span className="orb-core">
            {status === "thinking" ? "•••" : status === "speaking" ? "◀))" : listening ? "REC" : "TALK"}
          </span>
        </button>
        <div className="status">{STATUS_LABEL[lang][status]}</div>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 9000))}
          placeholder={
            lang === "ru"
              ? "Вставь тему, текст письма — или прикрепи файл"
              : "Paste a subject line, an email — or attach a file"
          }
          rows={3}
        />
        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            accept=".eml,.html,.htm,.txt,.xml"
            onChange={onFile}
            style={{ display: "none" }}
          />
          <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
            {lang === "ru" ? "Прикрепить файл" : "Attach file"}
          </button>
          <button className="send" onClick={submitText} disabled={busy || !draft.trim()}>
            {lang === "ru" ? "Отправить Норе" : "Send to Nora"}
          </button>
        </div>
      </div>

      <div className="log" ref={logRef}>
        {opening ? (
          <p className="empty">{OPENING[lang]}</p>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={`turn ${t.role === "assistant" ? "nora" : "you"}`}>
              <span className="who">{t.role === "assistant" ? "Nora" : lang === "ru" ? "Ты" : "You"}</span>
              <span className="said">
                {t.role === "user" && t.content.length > 220
                  ? t.content.slice(0, 220) + "…"
                  : t.content}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="foot">
        <span>Nora / email strategy agent</span>
        <span className="stack">Inworld · STT · LLM Router · TTS-2</span>
      </div>
    </main>
  );
}

// Exported emails (.eml / .html) are mostly markup and inline CSS. Strip it down
// to readable text so Nora critiques the message, not the <table> soup.
function cleanEmail(raw: string): string {
  const subjectMatch = raw.match(/^Subject:\s*(.+)$/im);
  let t = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (subjectMatch && !t.toLowerCase().startsWith("subject")) {
    t = `Subject: ${subjectMatch[1].trim()}\n\n${t}`;
  }
  return t.slice(0, 8000);
}

function blobToBase64(blob: Blob): Promise<string> {  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Decode whatever the browser recorded, resample to 16kHz mono, and pack it
// into a standard PCM16 WAV file — the most universally accepted STT input.
async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  const ac = new AudioContext();
  const decoded = await ac.decodeAudioData(arrayBuf);
  ac.close().catch(() => {});

  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const pcm = rendered.getChannelData(0);

  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
