"use client";
import { useEffect, useState } from "react";
import { API } from "@/lib/api";

type Conn = "idle" | "checking" | "ok" | "fail";
type ProviderInfo = { id: string; label: string; url: string; needs_key: boolean; url_editable: boolean; hint: string };
type Settings = {
  provider: string; url: string; model: string;
  has_key: Record<string, boolean>;
  profiles: Record<string, { url: string; model: string }>;
  providers: ProviderInfo[];
};

// Shown in the dropdown until the live list is loaded (press Test connection to fetch every model you can use).
const SUGGESTED: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
  gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  ollama: [],
  custom: [],
};
const CUSTOM = "__custom__";

const post = (path: string, body: unknown) =>
  fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// Connect the model that runs the debate: local (Ollama) or online (OpenAI, Gemini, any OpenAI-compatible API).
// Calls onReady(true) once the chosen provider is connected AND saved with a model.
export default function ModelConnect({ onReady }: { onReady?: (ready: boolean) => void }) {
  const [cfg, setCfg] = useState<Settings | null>(null);
  const [provider, setProvider] = useState("ollama");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [conn, setConn] = useState<Conn>("idle");
  const [msg, setMsg] = useState("");
  const [saved, setSaved] = useState(false);
  const [customName, setCustomName] = useState(false);

  const info = cfg?.providers.find((p) => p.id === provider);
  const hasKey = !!cfg?.has_key[provider];
  const ready = (v: boolean) => { setSaved(v); onReady?.(v); };

  const test = async (prov: string, u: string, key: string, keep?: string) => {
    setConn("checking"); setMsg("");
    try {
      const r = await post("/api/models/list", { provider: prov, url: u, api_key: key });
      if (!r.ok) throw new Error(r.error);
      setModels(r.models); setConn("ok");
      setMsg(r.models.length ? `Connected · ${r.models.length} model(s) available` : "Connected, but no models found.");
      if (!keep && r.models.length) setModel(r.models[0]);
      return r.models as string[];
    } catch (e: any) {
      setModels([]); setConn("fail"); ready(false);
      setMsg(e?.message && e.message !== "Failed to fetch" ? e.message : "Cannot reach the backend. Is it running?");
      return null;
    }
  };

  const pick = (c: Settings, prov: string) => {
    setProvider(prov);
    setUrl(c.profiles[prov].url); setModel(c.profiles[prov].model);
    setApiKey(""); setModels([]); setConn("idle"); setMsg(""); setCustomName(false); ready(false);
    // Ollama and providers with a saved key: load the real model list straight away.
    if (prov === "ollama" || c.has_key[prov]) void test(prov, c.profiles[prov].url, "", c.profiles[prov].model);
  };

  useEffect(() => {
    fetch(`${API}/api/settings`).then((r) => r.json()).then(async (c: Settings) => {
      setCfg(c); setProvider(c.provider); setUrl(c.url); setModel(c.model);
      const needsKey = c.providers.find((p) => p.id === c.provider)?.needs_key;
      if (needsKey && !c.has_key[c.provider]) return;             // nothing to test yet
      const list = await test(c.provider, c.url, "", c.model);
      if (list && list.includes(c.model)) ready(true);            // saved model still available -> ready
    }).catch(() => { setConn("fail"); setMsg("Cannot reach the backend at " + API); ready(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const r = await fetch(`${API}/api/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, url, model, api_key: apiKey }),
    });
    if (r.ok) { const c: Settings = await r.json(); setCfg(c); setApiKey(""); ready(conn === "ok"); }
    else setMsg((await r.json().catch(() => ({}))).detail || "Could not save settings.");
  };

  const removeKey = async () => {
    const r = await fetch(`${API}/api/settings/key/${provider}`, { method: "DELETE" });
    if (r.ok) { setCfg(await r.json()); setConn("idle"); setMsg("Saved key removed."); ready(false); }
  };

  // Live list when we have one, otherwise suggestions; always keep the current model selectable.
  const base = models.length ? models : SUGGESTED[provider] ?? [];
  const options = model && model !== CUSTOM && !base.includes(model) ? [model, ...base] : base;
  const showCustomInput = customName || (options.length === 0);
  const edit = () => ready(false);
  const keyNeeded = !!info?.needs_key;
  const canTest = !!info && (!keyNeeded || hasKey || apiKey.trim().length > 0);

  if (!cfg) return <div className="skeleton" />;

  return (
    <>
      <label htmlFor="provider">Where should the AI run?</label>
      <select id="provider" value={provider} onChange={(e) => pick(cfg, e.target.value)}>
        <optgroup label="Local">
          {cfg.providers.filter((p) => p.id === "ollama").map((p) => <option key={p.id} value={p.id}>{p.label} · private</option>)}
        </optgroup>
        <optgroup label="Online (API key)">
          {cfg.providers.filter((p) => p.id !== "ollama").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </optgroup>
      </select>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: "var(--fs-sm)" }}>{info?.hint}</p>

      {info?.url_editable && (
        <>
          <label htmlFor="url" style={{ marginTop: 14 }}>{provider === "ollama" ? "Ollama URL" : "API base URL"}</label>
          <input id="url" value={url} onChange={(e) => { setUrl(e.target.value); setConn("idle"); edit(); }}
            placeholder={provider === "ollama" ? "http://localhost:11434" : "https://openrouter.ai/api/v1"} />
        </>
      )}

      {provider !== "ollama" && (
        <>
          <label htmlFor="apikey" style={{ marginTop: 14 }}>API key{provider === "custom" ? " (optional)" : ""}</label>
          <input id="apikey" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setConn("idle"); edit(); }}
            placeholder={hasKey ? "•••••••• saved. Leave blank to keep it" : "Paste your API key"} />
          <p className="muted" style={{ margin: "6px 0 0", fontSize: "var(--fs-sm)" }}>
            Stored only in your local database and sent only to the provider.{" "}
            {hasKey && <button type="button" className="link" style={{ padding: 0, minHeight: 0 }} onClick={removeKey}>Remove saved key</button>}
          </p>
        </>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => test(provider, url, apiKey, model)} disabled={conn === "checking" || !canTest}>
          {conn === "checking" ? "Testing…" : "Test connection"}
        </button>
      </div>

      <p className="status" role="status" aria-live="polite" style={{ marginTop: 10 }}>
        <span className={`dot ${conn === "ok" ? "live" : conn === "fail" ? "bad" : ""}`} />
        {msg || "Not tested yet"}
      </p>

      <label htmlFor="model" style={{ marginTop: 10 }}>Model</label>
      <select id="model" value={showCustomInput && options.length ? CUSTOM : model}
        onChange={(e) => {
          if (e.target.value === CUSTOM) { setCustomName(true); setModel(""); }
          else { setCustomName(false); setModel(e.target.value); }
          edit();
        }}>
        {!model && !showCustomInput && <option value="">Choose a model…</option>}
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
        {provider !== "ollama" && <option value={CUSTOM}>Other (type a name)…</option>}
        {provider === "ollama" && options.length === 0 && <option value="">No models found. Test the connection</option>}
      </select>
      {showCustomInput && provider !== "ollama" && (
        <input aria-label="Model name" style={{ marginTop: 8 }} value={model} placeholder="Type the exact model name"
          onChange={(e) => { setModel(e.target.value); edit(); }} />
      )}
      {!models.length && SUGGESTED[provider]?.length > 0 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: "var(--fs-sm)" }}>
          Suggested models. Press Test connection to load the full list for your key.
        </p>
      )}
      {provider === "ollama" && (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: "var(--fs-sm)" }}>
          Not installed yet? Run <code>ollama pull {model || "qwen2.5:7b"}</code>, then press Test.
        </p>
      )}

      <button className="btn big" onClick={save} disabled={!url || !model || (conn !== "ok" && !saved)}>
        {saved ? "✓ Connected" : "Save & connect"}
      </button>
    </>
  );
}
