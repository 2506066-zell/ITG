"""Main message processor for the stateless chatbot."""

from __future__ import annotations

import re

from chatbot.intents import detect_intent, normalize_message
from chatbot.responses import pick_response


MAX_MESSAGE_LEN = 600
MAX_REPLY_LEN = 420


def _detect_focus_domain(message: str) -> str:
    lower = message.lower()
    if re.search(r"\b(kuliah|assignment|deadline|ipk|makalah|quiz|ujian)\b", lower):
        return "kuliah"
    if re.search(r"\b(habit|kebiasaan|olahraga|health|tidur)\b", lower):
        return "habit"
    return "umum"


def _build_context(message: str, intent: str) -> dict[str, str]:
    partner_label = "pasangan kalian"
    if re.search(r"\baku\b|\bsaya\b", message.lower()):
        partner_label = "kalian berdua"
    return {
        "partner_label": partner_label,
        "domain": _detect_focus_domain(message),
        "intent": intent,
    }


def process_message(raw_message: str) -> str:
    message = normalize_message(raw_message)[:MAX_MESSAGE_LEN]
    if not message:
        return pick_response("fallback", "", {})

    intent = detect_intent(message)
    context = _build_context(message, intent)
    reply = pick_response(intent, message, context)
    return reply[:MAX_REPLY_LEN].strip()

