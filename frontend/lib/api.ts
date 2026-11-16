export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
export const WS = API.replace(/^http/, "ws");

export type Side = "for" | "against";
export type Gender = "male" | "female";
export type VoiceInfo = { id: string; label: string; gender: Gender };
export type Persona = { name: string; side: Side; gender: Gender; voice: string; custom_prompt: string; is_human?: boolean };
export const MIN_TURNS = 5;
export const MAX_TURNS = 50;
export type Config = { topic: string; judge_name: string; rounds: number; agents: Persona[] };
export type Msg = { speaker: string; side: Side; content: string };
export type Result = {
  winner: "for" | "against" | "draw";
  percentage: number;
  key_points_for: string[];
  key_points_against: string[];
  summary: string;
  reason?: string;
  scores?: { for: Record<string, number>; against: Record<string, number> };
  fallback?: boolean;
};

export function validateConfig(c: Config): string | null {
  if (!c.topic.trim()) return "Topic is required.";
  if (c.agents.length > 6) return "Max 6 debaters.";
  if (c.agents.length < 2) return "Add at least two personas.";
  const names = c.agents.map((a) => a.name.trim().toLowerCase());
  if (names.some((n) => !n)) return "Persona names cannot be empty.";
  if (new Set(names).size !== names.length) return "Persona names must be unique.";
  if (!c.agents.some((a) => a.side === "for") || !c.agents.some((a) => a.side === "against"))
    return "Need at least one For and one Against persona.";
  if (c.agents.filter((a) => a.is_human).length > 1) return "Only one persona can be a real user.";
  if (!c.judge_name.trim()) return "Judge name is required.";
  if (c.rounds < MIN_TURNS || c.rounds > MAX_TURNS) return `Turns per persona must be ${MIN_TURNS}-${MAX_TURNS}.`;
  return null;
}
