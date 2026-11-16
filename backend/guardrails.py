"""Content guardrails: blocks abusive language (English + Hinglish gaali), threats / self-harm
encouragement and requests about clearly illegal activity. Used for the topic, persona fields,
the real user's replies, and (masked) for AI output."""
from __future__ import annotations
import re

# --- single words (matched as whole words, after normalising obfuscation like f*ck / sh1t) ---
ABUSE_WORDS = {
    # English
    "fuck", "fcking", "fuking", "fcker", "fucker", "fucking", "fucked", "motherfucker", "fuk", "fck", "shit", "shitty", "bullshit", "bitch", "bitches",
    "bastard", "asshole", "arsehole", "dick", "dickhead", "cunt", "pussy", "slut", "whore", "dumbass", "jackass",
    "retard", "retarded", "nigger", "nigga", "faggot", "fag", "twat", "wanker", "douchebag", "prick", "moron",
    # Hindi / Hinglish gaali
    "madarchod", "behenchod", "bhenchod", "bhosdike", "bhosdi", "bhosda", "chutiya", "chutiye", "chutia", "gandu",
    "gaandu", "gaand", "harami", "haramzada", "haramzade", "haramkhor", "randi", "raand", "lund", "lauda", "loda",
    "lode", "chut", "kamina", "kamine", "kutta", "kutti", "kutte", "saala", "bakchod", "bakchodi", "jhaatu", "tatti",
    "madarchodh", "mc", "bc",
}
# Ambiguous words (also real words/names/abbreviations) are NOT blocked, to avoid false alarms.
AMBIGUOUS = {"mc", "bc", "saala", "moron", "chut", "loda", "lode", "prick", "dick", "tatti"}
STRICT_WORDS = ABUSE_WORDS - AMBIGUOUS

# --- phrases (regex) ---
THREAT_PATTERNS = [
    r"kill\s+(your\s*self|yourself|urself|you|him|her|them)", r"\bkys\b", r"go\s+(die|kill)", r"hope\s+you\s+die",
    r"i\s*(will|ll|m\s*going\s*to|am\s*going\s*to)\s+(kill|murder|rape|hurt|beat)\b", r"\brape\b", r"\brapist\b",
    r"commit\s+suicide", r"suicide\s+(method|way)s?", r"\bmar\s+ja\b", r"\bmarja\b", r"tujhe\s+maar", r"\bmaar\s+dunga\b",
]
ILLEGAL_PATTERNS = [
    r"(make|making|build|building|buy|buying|sell|selling)\s+(a\s+|an\s+|the\s+)?(bomb|bombs|explosive|explosives|grenade)",
    r"bomb\s*making", r"child\s*(porn|pornography|abuse\s+material)", r"\bcsam\b", r"human\s+trafficking\s+(guide|how)",
    r"(buy|sell|selling|buying|make|making|cook|cooking)\s+(cocaine|heroin|meth|methamphetamine|fentanyl|mdma)",
    r"(hack|hacking|steal|stealing)\s+(someone|somebody|a\s+person|their|his|her)'?s?\s+(account|password|bank|card)",
    r"credit\s*card\s*fraud", r"money\s*laundering\s+(guide|how|method)", r"how\s+to\s+(hack|launder|counterfeit|smuggle)",
]

_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "!": "i", "*": "", "#": ""})
_MENTION = re.compile(r"(?<!\w)@\w+")


def _normalize(text: str) -> str:
    t = _MENTION.sub(" ", text.lower())          # @Name tags are not leetspeak
    t = t.translate(_LEET)
    t = re.sub(r"(.)\1{2,}", r"\1\1", t)         # fuuuuck -> fuuck
    return t


def _squash(w: str) -> str:
    return re.sub(r"(.)\1+", r"\1", w)


_STRICT_SQUASHED = {_squash(w) for w in STRICT_WORDS}
_THREAT = [re.compile(p, re.I) for p in THREAT_PATTERNS]
_ILLEGAL = [re.compile(p, re.I) for p in ILLEGAL_PATTERNS]


def check(text: str) -> str | None:
    """Return a user-facing warning if the text breaks the rules, else None."""
    if not text or not text.strip():
        return None
    t = _normalize(text)
    words = re.findall(r"[a-z]+", t)
    for w in words:
        s = _squash(w)
        if s in _STRICT_SQUASHED:
            return "Please avoid abusive or offensive language (including gaali)."
    # letters separated by spaces/dots: "f u c k"
    spaced = re.sub(r"(?<=\b[a-z])[\s.\-_]+(?=[a-z]\b)", "", t)
    for w in re.findall(r"[a-z]{3,}", spaced):
        if _squash(w) in _STRICT_SQUASHED:
            return "Please avoid abusive or offensive language (including gaali)."
    if any(p.search(t) for p in _THREAT):
        return "Please avoid threats, violent or self-harm language."
    if any(p.search(t) for p in _ILLEGAL):
        return "Please avoid content about illegal activity."
    return None


def mask(text: str) -> str:
    """Replace offending words with asterisks (used on AI output, which cannot be 'rejected')."""
    def repl(m: re.Match) -> str:
        w = m.group(0)
        return "*" * len(w) if _squash(_normalize(w).strip()) in _STRICT_SQUASHED else w
    return re.sub(r"[A-Za-z0-9$@!*#]+", repl, text)
