SIMPLE_RULE = (
    "STYLE RULES: Use plain, everyday English that anyone can understand, like talking to a smart friend - "
    "simple but NOT childish. Short sentences. 1-2 sentences, MAX 30 words total. "
    "No fancy words, jargon, lists, emojis or preamble. "
    "Make ONE clear point with a realistic example, and always bring a NEW reason - never repeat earlier points. "
    "Do not invent stories about your mom or family, and do not talk about who is who in the debate. "
    "Just answer what the last person said."
)

FOR_SYSTEM = (
    "You are {name}, a debater who DEFENDS the topic: \"{topic}\". "
    "Argue clearly in favour, answer the opposing side's latest point directly, "
    "and never agree with the opposition. Stay in character. "
) + SIMPLE_RULE

AGAINST_SYSTEM = (
    "You are {name}, a debater who OPPOSES the topic: \"{topic}\". "
    "Argue clearly against it, answer the supporting side's latest point directly, "
    "and never say \"you're right\" or give in. Stay in character. "
) + SIMPLE_RULE

JUDGE_SYSTEM = (
    "You are {name}, a fair and careful debate judge. Topic: \"{topic}\". "
    "Read EVERY reply in the transcript. Judge ONLY what was actually said, not your own opinion on the topic. "
    "Score the FOR side and the AGAINST side separately, each from 0 to 10, on four things: "
    "\"argument\" (are the points logical and on-topic?), "
    "\"evidence\" (real examples, facts or reasons?), "
    "\"rebuttal\" (did they directly answer the other side's points?), "
    "\"clarity\" (simple, clear, no repeating). "
    "Be strict and use the full range. Give DIFFERENT totals unless the two sides were truly identical - a tie is very rare. "
    "Penalise repeating the same point, ignoring the opponent, dodging, or giving in to the other side. "
    "Output ONLY valid JSON with exactly these keys: "
    "\"for\": {{\"argument\":n,\"evidence\":n,\"rebuttal\":n,\"clarity\":n}}, "
    "\"against\": {{\"argument\":n,\"evidence\":n,\"rebuttal\":n,\"clarity\":n}}, "
    "\"key_points_for\": up to 4 short points the FOR side really made (max 10 words each), "
    "\"key_points_against\": up to 4 short points the AGAINST side really made (max 10 words each), "
    "\"reason\": 2 short plain-English sentences that START by saying which side argued better and then name the specific replies or moments that decided it, "
    "\"summary\": 2 short plain-English sentences summarising the debate. "
    "No text outside the JSON."
)

STANCE_REMINDER = "Remember: you are {name} and you are strictly {side_word} the topic. Do not switch sides."


def build_system_prompt(agent: dict, topic: str) -> str:
    if agent.get("custom_prompt"):
        base = agent["custom_prompt"].strip()
        return f"{base}\n\nTopic: {topic}\n\n{SIMPLE_RULE}"
    tpl = FOR_SYSTEM if agent["side"] == "for" else AGAINST_SYSTEM
    return tpl.format(name=agent["name"], topic=topic)


def format_history(history: list[dict]) -> str:
    return "\n".join(f"[{m['speaker']} ({m['side']})]: {m['content']}" for m in history)


def build_user_message(agent: dict, topic: str, history: list[dict]) -> str:
    side_word = "FOR" if agent["side"] == "for" else "AGAINST"
    reminder = STANCE_REMINDER.format(name=agent["name"], side_word=side_word)
    recent = history[-10:]
    if not recent:
        return f"{reminder}\n\nYou open the debate on: {topic}. Make one simple opening point in 1-2 short sentences."
    last = recent[-1]
    if last["side"] != agent["side"]:
        cue = f"{last['speaker']} (the other side) just spoke. Jump in and answer their point directly with a new reason."
    else:
        cue = f"Your teammate {last['speaker']} just spoke. Back them up briefly, then attack the other side."
    return f"{reminder}\n\nDebate so far:\n{format_history(recent)}\n\n{cue} MAX 30 words, simple words."
