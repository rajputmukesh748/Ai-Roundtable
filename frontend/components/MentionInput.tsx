"use client";
import { useMemo, useRef, useState } from "react";

// Renders text with @Name tags highlighted (React escapes everything, so this is safe).
export function renderMentions(text: string, names: string[]) {
  if (!text || !names.length) return text;
  const esc = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(@(?:${esc.join("|")})(?![\\w]))`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <span key={i} className="mention">{part}</span> : part));
}

type Props = { names: string[]; speaker: string; warning: { msg: string; id: number } | null; onSend: (text: string) => void; onSkip: () => void };

export default function MentionInput({ names, speaker, warning, onSend, onSkip }: Props) {
  const [seenWarn, setSeenWarn] = useState(0); // hides the warning once the user edits again
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // The "@query" being typed right before the caret (must start a word).
  const query = useMemo(() => {
    const m = text.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    return m ? m[1] : null;
  }, [text, caret]);
  const options = useMemo(
    () => (query === null ? [] : names.filter((n) => n.toLowerCase().startsWith(query.toLowerCase()))),
    [names, query],
  );
  const open = options.length > 0 && !dismissed;

  const pick = (name: string) => {
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    setDismissed(false);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(before.length, before.length); });
  };
  const send = () => { const t = text.trim(); if (t) onSend(t); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[active % options.length]); return; }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="compose card" role="group" aria-label={`Your turn as ${speaker}`}>
      <div className="compose-head">It&apos;s your turn, <strong>{speaker}</strong>. Type <kbd>@</kbd> to tag someone.</div>
      <div className="compose-box">
        {open && (
          <ul className="mention-list" role="listbox">
            {options.map((n, i) => (
              <li key={n} role="option" aria-selected={i === active % options.length}
                className={i === active % options.length ? "on" : ""}
                onMouseDown={(e) => { e.preventDefault(); pick(n); }}>@{n}</li>
            ))}
          </ul>
        )}
        <textarea ref={ref} autoFocus rows={2} value={text} maxLength={1000} aria-label="Your reply"
          placeholder="Write your reply… use @name to tag someone"
          onChange={(e) => { if (warning) setSeenWarn(warning.id); setText(e.target.value); setCaret(e.target.selectionStart); setActive(0); setDismissed(false); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKeyDown} />
      </div>
      {warning && warning.id !== seenWarn && <p className="err" role="alert">⚠ {warning.msg} Please rephrase and send again.</p>}
      <div className="compose-actions">
        <button type="button" className="btn ghost" onClick={onSkip}>Pass</button>
        <button type="button" className="btn" disabled={!text.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}
