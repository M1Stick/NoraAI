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
    const base64 = await blobToBase64(blob);
    await sendTurn(base64);
  }

  async function sendTurn(audioBase64: string) {
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
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

      <div className="log" ref={logRef}>
        {opening ? (
          <p className="empty">{OPENING[lang]}</p>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={`turn ${t.role === "assistant" ? "nora" : "you"}`}>
              <span className="who">{t.role === "assistant" ? "Nora" : lang === "ru" ? "Ты" : "You"}</span>
              <span className="said">{t.content}</span>
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
