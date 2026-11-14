"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ModelConnect from "@/components/ModelConnect";
import { API, Config, Gender, MAX_TURNS, MIN_TURNS, Persona, VoiceInfo, validateConfig } from "@/lib/api";

type Past = { id: number; topic: string; status: string; result: { winner: string; percentage: number } | null };

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [judge, setJudge] = useState("Moderator");
  const [rounds, setRounds] = useState(MIN_TURNS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [agents, setAgents] = useState<Persona[]>([
    { name: "Alice", side: "for", gender: "female", voice: "", custom_prompt: "" },
    { name: "Bob", side: "against", gender: "male", voice: "", custom_prompt: "" },
  ]);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [past, setPast] = useState<Past[] | null>(null);

  const loadPast = () =>
    fetch(`${API}/api/debates?limit=5`).then((r) => r.json()).then(setPast).catch(() => setPast([]));
  useEffect(() => { loadPast(); }, []);
  useEffect(() => {
    fetch(`${API}/api/tts/status`).then((r) => r.json()).then((d) => setVoices(d.voices ?? [])).catch(() => {});
  }, []);

  // Voice is chosen automatically from gender: same-gender personas get different voices where possible.
  const assignVoices = (list: Persona[]): Persona[] => {
    const seen: Record<Gender, number> = { male: 0, female: 0 };
    return list.map((p) => {
      const pool = voices.filter((v) => v.gender === p.gender);
      const voice = pool.length ? pool[seen[p.gender]++ % pool.length].id : "";
      return { ...p, voice };
    });
  };
  const setGender = (i: number, g: Gender) => update(i, { gender: g });
  const addPersona = () =>
    setAgents((a) => {
      const side: Persona["side"] = a.filter((x) => x.side === "for").length > a.filter((x) => x.side === "against").length ? "against" : "for";
      const gender: Gender = a.filter((x) => x.gender === "male").length > a.filter((x) => x.gender === "female").length ? "female" : "male";
      return [...a, { name: "", side, gender, voice: "", custom_prompt: "" }];
    });
  const update = (i: number, patch: Partial<Persona>) =>
    setAgents((a) => a.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const start = () => {
    const cfg: Config = { topic, judge_name: judge, rounds, agents: assignVoices(agents) };
    const err = validateConfig(cfg);
    if (err) return setError(err);
    setError("");
    sessionStorage.setItem("debateConfig", JSON.stringify(cfg));
    router.push("/debate");
  };

  const remove = async (id: number) => {
    await fetch(`${API}/api/debates/${id}`, { method: "DELETE" });
    loadPast();
  };

  return (
    <>
      <header className="hero">
        <h1>AI Roundtable</h1>
        <p>Pit AI personas against each other on any topic, then let an impartial judge call the winner.</p>
      </header>

      <div className="home-grid">
        <aside className="home-left">
          <section className="card" aria-labelledby="step1">
            <h2 id="step1">AI model</h2>
            <ModelConnect onReady={setReady} />
          </section>

          <section className="card" aria-labelledby="hist">
            <h2 id="hist">Latest debates</h2>
            {past === null && <><div className="skeleton" /><div className="skeleton" /></>}
            {past && past.length === 0 && <p style={{ color: "var(--muted)", margin: 0 }}>No debates yet. Start your first one.</p>}
            {past?.slice(0, 5).map((d) => (
              <div key={d.id} className="past">
                <Link href={`/debate?id=${d.id}`} className="past-main" title="Open result">
                  <span className="past-topic">{d.topic}</span>
                  <span className="past-meta">
                    {d.result
                      ? <span className={`pill ${d.result.winner}`}>{d.result.winner === "draw" ? "Draw" : `${d.result.winner} wins`} · {d.result.percentage}%</span>
                      : <span className="pill">{d.status}</span>}
                  </span>
                </Link>
                <button className="btn ghost icon" aria-label="Delete debate" onClick={() => remove(d.id)}>🗑</button>
              </div>
            ))}
          </section>
        </aside>

        <div className="home-right">
      <section className={`card locked-wrap ${ready ? "" : "locked"}`} aria-labelledby="setup" aria-disabled={!ready}>
        <h2 id="setup">Start a debate</h2>
        {!ready && <p className="status"><span className="dot" />Connect a model on the left to unlock this.</p>}
        <fieldset disabled={!ready} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label htmlFor="topic">Debate topic</label>
        <textarea id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} rows={3}
          placeholder="e.g. Remote work is better than office work" />

        <div className="section-title">
          <span className="label" style={{ margin: 0 }}>Personas ({agents.length}/6)</span>
          <button className="btn ghost" disabled={agents.length >= 6}
            onClick={addPersona}>
            + Add persona
          </button>
        </div>

        <div className="personas">
          {agents.map((a, i) => (
            <div key={i} className={`persona ${a.side}`}>
              <div className="persona-top">
                <input aria-label={`Persona ${i + 1} name`} value={a.name} placeholder="Persona name"
                  onChange={(e) => update(i, { name: e.target.value })} />
                <div className="seg" role="group" aria-label="Side">
                  <button type="button" aria-pressed={a.side === "for"} className={a.side === "for" ? "on-for" : ""}
                    onClick={() => update(i, { side: "for" })}>For</button>
                  <button type="button" aria-pressed={a.side === "against"} className={a.side === "against" ? "on-against" : ""}
                    onClick={() => update(i, { side: "against" })}>Against</button>
                </div>
                <button className="btn ghost icon" aria-label={`Remove persona ${i + 1}`}
                  onClick={() => setAgents((x) => x.filter((_, j) => j !== i))}>✕</button>
              </div>
              <div className="persona-voice">
                <div className="seg" role="group" aria-label="Gender">
                  <button type="button" aria-pressed={a.gender === "male"} className={a.gender === "male" ? "on-neutral" : ""}
                    onClick={() => setGender(i, "male")}>♂ Male</button>
                  <button type="button" aria-pressed={a.gender === "female"} className={a.gender === "female" ? "on-neutral" : ""}
                    onClick={() => setGender(i, "female")}>♀ Female</button>
                </div>
              </div>
              <button type="button" className="link" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
                {open[i] ? "− Hide custom prompt" : "+ Custom prompt (optional)"}
              </button>
              {open[i] && (
                <textarea rows={2} value={a.custom_prompt} aria-label="Custom system prompt"
                  placeholder="Describe this persona's personality or style…"
                  onChange={(e) => update(i, { custom_prompt: e.target.value })} />
              )}
            </div>
          ))}
        </div>

        <div className="grid2" style={{ marginTop: 22 }}>
          <div><label htmlFor="judge">Judge name</label>
            <input id="judge" value={judge} onChange={(e) => setJudge(e.target.value)} /></div>
          <div>
            <label htmlFor="rounds">Turns per persona</label>
            <div className="stepper">
              <button type="button" className="btn ghost icon" aria-label="Fewer turns"
                onClick={() => setRounds((r) => Math.max(MIN_TURNS, r - 1))} disabled={rounds <= MIN_TURNS}>−</button>
              <output className="stepper-value" htmlFor="rounds">{rounds}</output>
              <button type="button" className="btn ghost icon" aria-label="More turns"
                onClick={() => setRounds((r) => Math.min(MAX_TURNS, r + 1))} disabled={rounds >= MAX_TURNS}>+</button>
            </div>
            <input id="rounds" type="range" min={MIN_TURNS} max={MAX_TURNS} step={1} value={rounds} className="range"
              onChange={(e) => setRounds(Number(e.target.value))} />
            <p className="muted" style={{ margin: "6px 0 0", fontSize: "var(--fs-sm)" }}>
              {rounds * agents.length} messages in total · {MIN_TURNS}–{MAX_TURNS} per persona
            </p>
          </div>
        </div>

        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn big" onClick={start}>Start debate →</button>
        </fieldset>
      </section>
        </div>
      </div>
    </>
  );
}
