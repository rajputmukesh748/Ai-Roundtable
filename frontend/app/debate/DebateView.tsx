"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { API, WS, Msg, Result, Side } from "@/lib/api";
import MentionInput, { renderMentions } from "@/components/MentionInput";


// Pick the most natural-sounding English voices the device offers (neural/enhanced first, novelty voices excluded).
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|superstar|trinoids|whisper|zarvox|fred|junior|ralph|kathy|agnes|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|compact/i;
const PREFERRED = /natural|neural|premium|enhanced|google (us|uk)|samantha|daniel|karen|moira|serena|aaron|nicky|allison|ava|tessa|susan|alex|zira|aria|guy|jenny/i;
function buildVoicePool(): SpeechSynthesisVoice[] {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const en = all.filter((v) => v.lang.toLowerCase().startsWith("en") && !NOVELTY.test(v.name));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|premium|enhanced/i.test(v.name) ? 4 : 0) + (PREFERRED.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1) + (v.lang === "en-US" ? 0.5 : 0);
  return [...en].sort((a, b) => score(b) - score(a)).slice(0, 6);
}

// React escapes text nodes, so model output is never injected as HTML.
type Turn = { speaker: string; side: Side; content: string };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const words = (t: string) => t.trim().split(/\s+/).length;

export default function DebateView() {
  const router = useRouter();
  const params = useSearchParams();
  const savedId = params.get("id");
  const [topic, setTopic] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [speakingIdx, setSpeakingIdx] = useState(-1);
  const [names, setNames] = useState<string[]>([]);                       // everyone who can be @tagged
  const [humanTurn, setHumanTurn] = useState<{ speaker: string } | null>(null); // set while the real user must reply
  const [humanWarn, setHumanWarn] = useState<{ msg: string; id: number } | null>(null);
  const humanReply = useRef<((text: string) => void) | null>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const stopAudioRef = useRef<(() => void) | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  // ---- smart auto-scroll: follow new text only while the user is at the bottom ----
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const setAtBottom = (v: boolean) => { atBottomRef.current = v; setShowJump(!v); };
  const distFromBottom = () => document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);

  useEffect(() => {
    const onScroll = () => { if (distFromBottom() < 80) setAtBottom(true); };          // came back to the latest
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) setAtBottom(false); };      // user scrolled up
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => { if (e.touches[0].clientY > touchY + 4) setAtBottom(false); };
    const onKey = (e: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) setAtBottom(false); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll); window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart); window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!atBottomRef.current) return;
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }, [msgs, result]);

  const jumpToLatest = () => {
    setAtBottom(true);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  };

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) { window.speechSynthesis?.cancel(); stopAudioRef.current?.(); } // stops current speech; playback moves on to a reading pause
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (savedId) {
      fetch(`${API}/api/debates/${savedId}`)
        .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
        .then((d) => { setTopic(d.topic); setNames((d.agents ?? []).map((a: { name: string }) => a.name)); setMsgs(d.messages); setResult(d.result); setStatus(`Saved debate (${d.status})`); })
        .catch(() => setStatus("Could not load debate."));
      return;
    }

    const raw = sessionStorage.getItem("debateConfig");
    if (!raw) { router.replace("/"); return; }
    const cfg = JSON.parse(raw);
    setTopic(cfg.topic);
    setNames(cfg.agents.map((a: { name: string }) => a.name.trim()));

    // ---- playback: text streams in and is spoken sentence by sentence as it appears ----
    type Live = { speaker: string; side: Side; text: string; done: boolean; human?: boolean };
    const queue: Live[] = [];
    let curTurn: Live | null = null;
    let backendDone = false, judging = false, resultData: Result | null = null, errored = false, stop = false, total = 0, shown = 0;
    const personaIdx: Record<string, number> = {};
    const personaVoice: Record<string, string> = {};
    cfg.agents.forEach((a: { name: string; voice: string }, i: number) => { personaIdx[a.name.trim()] = i; personaVoice[a.name.trim()] = a.voice; });

    // ---- neural TTS (Piper on the backend); falls back to browser voices if unavailable ----
    const neural = { ok: false };
    const ttsReady = fetch(`${API}/api/tts/status`).then((r) => r.json()).then((d) => { neural.ok = !!d.available; }).catch(() => {});
    const audioCache = new Map<string, Promise<HTMLAudioElement | null>>();
    const getAudio = (text: string, voice: string) => {
      const key = `${voice}|${text}`;
      if (!audioCache.has(key)) {
        audioCache.set(key, (async () => {
          try {
            const r = await fetch(`${API}/api/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) });
            if (!r.ok) return null;
            const a = new Audio(URL.createObjectURL(await r.blob()));
            await new Promise<void>((res) => { a.onloadedmetadata = () => res(); a.onerror = () => res(); });
            return a;
          } catch { return null; }
        })());
      }
      return audioCache.get(key)!;
    };
    const playAudio = (a: HTMLAudioElement) =>
      new Promise<void>((resolve) => {
        const finish = () => { stopAudioRef.current = null; resolve(); };
        stopAudioRef.current = () => { a.pause(); finish(); };
        a.onended = finish; a.onerror = finish;
        a.play().catch(finish);
      });

    const pool = () => buildVoicePool();
    const speak = (text: string, speaker: string, estMs: number) =>
      new Promise<void>((resolve) => {
        const synth = window.speechSynthesis;
        if (!synth || mutedRef.current) return resolve();
        const idx = personaIdx[speaker] ?? 0;
        const voices = pool();
        const u = new SpeechSynthesisUtterance(text);
        if (voices.length) u.voice = voices[idx % voices.length];
        u.rate = 0.92;                                   // calmer, human pace
        u.pitch = [1, 0.92, 1.08, 0.96, 1.04, 0.9][idx % 6]; // subtle per-person variation
        const done = () => { clearTimeout(guard); resolve(); };
        const guard = setTimeout(done, estMs * 1.8 + 4000); // Chrome sometimes never fires onend
        u.onend = done; u.onerror = done;
        synth.speak(u);
      });

    const nextChunk = (rest: string, done: boolean) => {
      const m = rest.match(done ? /^\s*[\s\S]*?[.!?…]+["')\]]*(?=\s|$)/ : /^\s*[\s\S]*?[.!?…]+["')\]]*(?=\s)/);
      if (m) return m[0];
      if (done) return rest;
      return rest.length > 160 ? rest.slice(0, rest.lastIndexOf(" ", 160) + 1 || 160) : ""; // very long run-on
    };

    const play = async (t: Live) => {
      const idx = await new Promise<number>((res) => setMsgs((m) => { res(m.length); return [...m, { speaker: t.speaker, side: t.side, content: "" }]; }));
      if (t.human) {
        // the real user's turn: show the input, send their text, then show it instantly (no voice)
        setStatus(`Your turn, ${t.speaker}…`);
        setHumanTurn({ speaker: t.speaker });
        // sending does not finish the turn: the server may reject the text (guardrails) and ask again
        humanReply.current = (text) => ws.send(JSON.stringify({ type: "user_reply", content: text }));
        while (!t.done && !stop && !errored) await sleep(80);
        humanReply.current = null;
        setHumanTurn(null);
        setHumanWarn(null);
        setStatus("Waiting for the others…");
        while (!t.done && !stop && !errored) await sleep(60);
        setMsgs((m) => m.map((x, j) => (j === idx ? { ...x, content: t.text } : x)));
        shown++;
        await sleep(900);
        return;
      }
      setSpeakingIdx(idx);
      setStatus(`${t.speaker} is speaking (${shown + 1}/${total || "?"})…`);
      let pos = 0, shownText = "";
      while (!stop) {
        const chunk = nextChunk(t.text.slice(pos), t.done);
        if (!chunk.trim()) { if (t.done) break; await sleep(60); continue; }
        pos += chunk.length;
        const sentence = chunk.trim();
        const vIdx = personaVoice[t.speaker] ?? "";
        let estMs = Math.max(900, (words(sentence) / 2.3) * 1000);
        let talking: Promise<void> | null = null;
        if (neural.ok && !mutedRef.current) {
          const audio = await getAudio(sentence, vIdx);          // neural voice (Piper)
          if (audio && !mutedRef.current) { estMs = (audio.duration || estMs / 1000) * 1000; talking = playAudio(audio); }
        }
        // look ahead: start synthesizing the next sentence while this one plays (no gaps)
        if (neural.ok) { const nx = nextChunk(t.text.slice(pos), t.done).trim(); if (nx) void getAudio(nx, vIdx); }
        if (!talking) talking = speak(sentence, t.speaker, estMs); // browser voice fallback
        const perChar = (mutedRef.current ? 28 : estMs / sentence.length);
        const prefix = shownText ? shownText + " " : "";
        for (let i = 1; i <= sentence.length && !stop; i += 2) {
          const part = prefix + sentence.slice(0, i + 1);
          setMsgs((m) => m.map((x, j) => (j === idx ? { ...x, content: part } : x)));
          await sleep(perChar * 2);
        }
        shownText = prefix + sentence;
        setMsgs((m) => m.map((x, j) => (j === idx ? { ...x, content: shownText } : x)));
        await talking;
        await sleep(mutedRef.current ? 350 : 260); // natural breath between sentences
      }
      setSpeakingIdx(-1);
      shown++;
      setStatus("Others are thinking…");
      // time to take it in, then someone jumps in
      await sleep(mutedRef.current ? Math.max(1800, words(shownText) * 250) : 1500);
    };

    const player = async () => {
      await ttsReady;
      while (!stop) {
        const next = queue.shift();
        if (next) { await play(next); continue; }
        if (backendDone) {
          if (resultData) { setStatus("Debate finished."); setResult(resultData); }
          return;
        }
        if (errored) return;
        if (judging) setStatus("Judge is deliberating…");
        await sleep(120);
      }
    };

    const ws = new WebSocket(`${WS}/ws/debate`);
    ws.onopen = () => { setStatus("Debate starting…"); ws.send(raw); };
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
            switch (ev.type) {
        case "turn_start": { total = ev.total; curTurn = { speaker: ev.speaker, side: ev.side, text: "", done: false, human: !!ev.human }; queue.push(curTurn); break; }
        case "token": if (curTurn) curTurn.text += ev.text; break;
        case "turn_end": if (curTurn) { curTurn.text = ev.content; curTurn.done = true; } break;
        case "user_warning": setHumanWarn({ msg: ev.message, id: Date.now() }); break;
        case "judging": judging = true; break;
        case "result": resultData = ev.data; backendDone = true; break;
        case "error": errored = true; setStatus(`Error: ${ev.message}`); break;
      }
    };
    ws.onerror = () => { errored = true; setStatus("Connection error. Is the backend running?"); };
    ws.onclose = () => {
      // the server closes normally after sending the result; anything else means the debate was cut short
      if (!stop && !backendDone && !errored) { errored = true; setStatus("Error: connection to the backend was lost before the debate finished. Start a new debate."); }
    };
    player();

    return () => { stop = true; humanReply.current?.(""); ws.close(); window.speechSynthesis?.cancel(); stopAudioRef.current?.(); };
  }, [savedId, router]);

  const live = status.includes("speaking") || !!humanTurn || status.includes("deliberating") || status.includes("thinking") || status.startsWith("Debate starting") || status === "Connecting…";
  const bad = status.startsWith("Error") || status.startsWith("Connection") || status.startsWith("Could not");

  return (
    <div className="narrow">
      <div className="topbar">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/">← New debate</Link>
          {!savedId && (
            <button className={`audio-btn ${muted ? "off" : ""}`} onClick={toggleMute} aria-pressed={muted}
              aria-label={muted ? "Unmute voices" : "Mute voices"} title={muted ? "Unmute" : "Mute"}>
              {muted ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></svg>
              )}
              <span>{muted ? "Muted" : "Voice on"}</span>
            </button>
          )}
        </div>
        <h1>{topic || "Debate"}</h1>
        <span className="status" role="status" aria-live="polite">
          <span className={`dot ${bad ? "bad" : live ? "live" : ""}`} />{status}
        </span>
      </div>

      

      <div className="chat">
        {msgs.map((m, i) => (
          <div key={i} className={`msg side-${m.side}`}>
            <div className="avatar" aria-hidden>{m.speaker.charAt(0).toUpperCase()}</div>
            <div className="bubble">
              <div className="speaker">{m.speaker}<small>{m.side}</small></div>
              <div className={i === speakingIdx && m.content ? "caret" : ""}>
                {m.content ? renderMentions(m.content, names) : (i === speakingIdx ? <span className="typing" aria-label="typing"><i /><i /><i /></span> : "")}
              </div>
            </div>
          </div>
        ))}
        {status.includes("deliberating") && <div className="skeleton" aria-hidden />}
      </div>

      {result && (
        <section className="card" aria-labelledby="verdict">
          <h2 id="verdict" className="verdict-title">
            {result.winner === "draw" ? "It's a draw" : `${result.winner === "for" ? "For" : "Against"} wins`}
          </h2>
          {result.fallback && <p className="warn">Judge output was invalid — showing a heuristic result based on turn counts.</p>}
          <div className="bar" role="img" aria-label={`For ${result.percentage}%, Against ${100 - result.percentage}%`}>
            {result.percentage > 0 && <div className="bar-for" style={{ width: `${result.percentage}%` }}>{result.percentage}%</div>}
            {result.percentage < 100 && <div className="bar-against" style={{ width: `${100 - result.percentage}%`, transformOrigin: "right" }}>{100 - result.percentage}%</div>}
          </div>
          {result.reason && <p className="reason"><strong>Why:</strong> {result.reason}</p>}
          {result.scores && (
            <div className="scorecard" aria-label="Scorecard">
              {["argument", "evidence", "rebuttal", "clarity"].map((k) => (
                <div key={k} className="score-row">
                  <span className="score-val for">{result.scores!.for[k]}/10</span>
                  <span className="score-name">{k}</span>
                  <span className="score-val against">{result.scores!.against[k]}/10</span>
                </div>
              ))}
              <div className="score-row score-head"><span className="for">For</span><span /><span className="against">Against</span></div>
            </div>
          )}
          <div className="grid2">
            <div className="points for"><h3>For — key points</h3><ul>{result.key_points_for.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
            <div className="points against"><h3>Against — key points</h3><ul>{result.key_points_against.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
          </div>
          <p className="summary">{result.summary}</p>
        </section>
      )}
      {humanTurn && (
        <MentionInput names={names.filter((n) => n !== humanTurn.speaker)} speaker={humanTurn.speaker} warning={humanWarn}
          onSend={(t) => humanReply.current?.(t)} onSkip={() => humanReply.current?.("")} />
      )}
      <div ref={endRef} />
      {showJump && msgs.length > 0 && (
        <button className="jump-btn" onClick={jumpToLatest} aria-label="Scroll to latest message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
          Latest message
        </button>
      )}
    </div>
  );
}
