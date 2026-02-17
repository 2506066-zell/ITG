"""Main message processor for the stateless chatbot."""

from __future__ import annotations

import re
from typing import Any, TypedDict

from chatbot.intents import detect_intent, normalize_message
from chatbot.responses import pick_response


MAX_MESSAGE_LEN = 600
MAX_REPLY_LEN = 420
MAX_SUGGESTIONS = 4


class QuickSuggestion(TypedDict):
    label: str
    command: str
    tone: str


class AdaptiveProfile(TypedDict):
    style: str
    focus_minutes: int
    urgency: str
    energy: str
    domain: str


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _normalize_context_hint(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {
            "tone_mode": "supportive",
            "focus_minutes": 25,
            "focus_window": "any",
            "recent_intents": [],
        }

    tone_mode = str(raw.get("tone_mode", "supportive")).strip().lower()
    if tone_mode not in {"supportive", "strict", "balanced"}:
        tone_mode = "supportive"

    focus_minutes = _clamp(_safe_int(raw.get("focus_minutes", 25), 25), 10, 180)

    focus_window = str(raw.get("focus_window", "any")).strip().lower()
    if focus_window not in {"any", "morning", "afternoon", "evening"}:
        focus_window = "any"

    recent_raw = raw.get("recent_intents", [])
    recent_intents: list[str] = []
    if isinstance(recent_raw, list):
        for item in recent_raw:
            text = str(item).strip().lower()
            if not text:
                continue
            if text in recent_intents:
                continue
            recent_intents.append(text)
            if len(recent_intents) >= 6:
                break

    return {
        "tone_mode": tone_mode,
        "focus_minutes": focus_minutes,
        "focus_window": focus_window,
        "recent_intents": recent_intents,
    }


def _detect_focus_domain(message: str) -> str:
    lower = message.lower()
    if re.search(r"\b(kuliah|assignment|deadline|ipk|makalah|quiz|ujian)\b", lower):
        return "kuliah"
    if re.search(r"\b(habit|kebiasaan|olahraga|health|tidur)\b", lower):
        return "habit"
    return "umum"


def _build_context(message: str, intent: str, hint: dict[str, Any]) -> dict[str, str]:
    partner_label = "pasangan kalian"
    if re.search(r"\baku\b|\bsaya\b", message.lower()):
        partner_label = "kalian berdua"
    return {
        "partner_label": partner_label,
        "domain": _detect_focus_domain(message),
        "intent": intent,
        "focus_window": str(hint.get("focus_window", "any")),
    }


def _parse_focus_minutes_from_message(message: str) -> int | None:
    hit = re.search(r"(\d{2,3})\s*(?:menit|min|minutes?)\b", message, flags=re.IGNORECASE)
    if not hit:
        return None
    return _clamp(_safe_int(hit.group(1), 25), 10, 180)


def _infer_adaptive_profile(message: str, context: dict[str, str], hint: dict[str, Any]) -> AdaptiveProfile:
    lower = message.lower()

    tone_mode = str(hint.get("tone_mode", "supportive"))
    if re.search(r"\b(toxic|tegas|gaspol|no excuse|push keras)\b", lower):
        style = "strict"
    elif tone_mode == "strict":
        style = "strict"
    elif tone_mode == "balanced":
        style = "balanced"
    else:
        style = "supportive"

    focus_minutes = _parse_focus_minutes_from_message(message)
    if focus_minutes is None:
        focus_minutes = _clamp(_safe_int(hint.get("focus_minutes", 25), 25), 10, 180)

    if re.search(r"\b(urgent|asap|deadline|besok|hari ini|sekarang juga|telat)\b", lower):
        urgency = "high"
    elif re.search(r"\b(target|goal|reminder|ingatkan|check-in|progres)\b", lower):
        urgency = "medium"
    else:
        urgency = "low"

    if re.search(r"\b(lelah|capek|ngantuk|burnout|drop|mager)\b", lower):
        energy = "low"
    elif re.search(r"\b(semangat|fokus|gas|mantap)\b", lower):
        energy = "high"
    else:
        energy = "normal"

    return {
        "style": style,
        "focus_minutes": focus_minutes,
        "urgency": urgency,
        "energy": energy,
        "domain": context.get("domain", "umum"),
    }


def _adaptive_tail(profile: AdaptiveProfile) -> str:
    focus_minutes = int(profile.get("focus_minutes", 25))
    if profile.get("urgency") == "high" and profile.get("domain") == "kuliah":
        return f"Mode urgent: ambil task kuliah paling dekat deadline, fokus {focus_minutes} menit tanpa distraksi."
    if profile.get("energy") == "low":
        return "Kalau energi lagi turun, mulai 10 menit dulu. Yang penting bergerak dulu."
    if profile.get("style") == "strict":
        return "Mode tegas: eksekusi dulu, evaluasi belakangan."
    return ""


def _apply_adaptive_followup(
    intent: str,
    message: str,
    reply: str,
    context: dict[str, str],
    profile: AdaptiveProfile,
) -> str:
    lower = message.lower()
    domain = context.get("domain", "umum")
    focus_minutes = int(profile.get("focus_minutes", 25))

    if intent == "affirmation":
        if re.search(r"\b(evaluasi|review|refleksi)\b", lower):
            base = pick_response("evaluation", message, context)
        elif re.search(r"\b(reminder|ingat|notifikasi|alarm)\b", lower):
            base = f"Sip. Reminder acknowledged. Lanjut {focus_minutes} menit fokus sekarang, lalu kirim update singkat."
        elif domain == "kuliah":
            base = f"Sip, lanjut tugas kuliah paling dekat dulu {focus_minutes} menit. Setelah itu evaluasi cepat 3 poin."
        else:
            base = f"{reply} Kalau siap, kirim 'rekomendasi tugas' biar aku urutin prioritasmu."
        tail = _adaptive_tail(profile)
        return f"{base} {tail}".strip() if tail else base

    if intent == "reminder_ack":
        base = f"{reply} Next step: mulai sekarang atau atur jam mulai spesifik."
        tail = _adaptive_tail(profile)
        return f"{base} {tail}".strip() if tail else base

    tail = _adaptive_tail(profile)
    return f"{reply} {tail}".strip() if tail else reply


def _dedupe_suggestions(items: list[QuickSuggestion]) -> list[QuickSuggestion]:
    seen_commands: set[str] = set()
    out: list[QuickSuggestion] = []
    for item in items:
        label = str(item.get("label", "")).strip()
        command = str(item.get("command", "")).strip()
        tone = str(item.get("tone", "info")).strip() or "info"
        if not label or not command:
            continue
        cmd_key = command.lower()
        if cmd_key in seen_commands:
            continue
        seen_commands.add(cmd_key)
        out.append({"label": label, "command": command, "tone": tone})
        if len(out) >= MAX_SUGGESTIONS:
            break
    return out


def _build_quick_suggestions(intent: str, context: dict[str, str], profile: AdaptiveProfile, hint: dict[str, Any]) -> list[QuickSuggestion]:
    domain = context.get("domain", "umum")
    focus_minutes = int(profile.get("focus_minutes", 25))
    style = str(profile.get("style", "supportive"))
    recent = [str(x).lower() for x in hint.get("recent_intents", [])]

    by_intent: dict[str, list[QuickSuggestion]] = {
        "greeting": [
            {"label": "Cek Target", "command": "cek target harian pasangan", "tone": "info"},
            {"label": "Rekomendasi Tugas", "command": "rekomendasi tugas kuliah", "tone": "success"},
            {"label": "Evaluasi", "command": "evaluasi hari ini", "tone": "info"},
        ],
        "check_daily_target": [
            {"label": "Check-In Progres", "command": "check-in progres hari ini", "tone": "info"},
            {"label": f"Fokus {focus_minutes}m", "command": f"ingatkan aku fokus {focus_minutes} menit", "tone": "warning"},
            {"label": "Evaluasi", "command": "evaluasi malam ini", "tone": "info"},
        ],
        "reminder_ack": [
            {"label": f"Mulai {focus_minutes}m", "command": f"oke mulai fokus {focus_minutes} menit", "tone": "success"},
            {"label": "Check-In", "command": "check-in progres sekarang", "tone": "info"},
            {"label": "Evaluasi", "command": "evaluasi singkat", "tone": "info"},
        ],
        "checkin_progress": [
            {"label": "Rekomendasi", "command": "rekomendasi tugas berikutnya", "tone": "success"},
            {"label": "Target Besok", "command": "cek target harian besok", "tone": "info"},
            {"label": "Motivasi Tegas", "command": "toxic motivasi", "tone": "warning"},
        ],
        "evaluation": [
            {"label": "Rencana Besok", "command": "cek target harian besok", "tone": "success"},
            {"label": "Prioritas Kuliah", "command": "rekomendasi tugas kuliah", "tone": "warning"},
            {"label": "Check-In", "command": "check-in progres sekarang", "tone": "info"},
        ],
        "affirmation": [
            {"label": "Rekomendasi", "command": "rekomendasi tugas sekarang", "tone": "success"},
            {"label": "Evaluasi", "command": "evaluasi hari ini", "tone": "info"},
            {"label": f"Fokus {focus_minutes}m", "command": f"ingatkan aku fokus {focus_minutes} menit", "tone": "warning"},
        ],
        "recommend_task": [
            {"label": "Mulai Sekarang", "command": "oke mulai sekarang", "tone": "success"},
            {"label": "Breakdown", "command": "pecah tugas jadi langkah kecil", "tone": "info"},
            {"label": "Check-In", "command": "check-in progres tugas", "tone": "info"},
        ],
        "toxic_motivation": [
            {"label": f"Gas {focus_minutes}m", "command": f"oke gas fokus {focus_minutes} menit", "tone": "critical"},
            {"label": "Task Prioritas", "command": "rekomendasi tugas prioritas", "tone": "warning"},
            {"label": "Evaluasi", "command": "evaluasi cepat", "tone": "info"},
        ],
        "fallback": [
            {"label": "Cek Target", "command": "cek target harian pasangan", "tone": "info"},
            {"label": f"Fokus {focus_minutes}m", "command": f"ingatkan aku fokus {focus_minutes} menit", "tone": "warning"},
            {"label": "Rekomendasi", "command": "rekomendasi tugas kuliah", "tone": "success"},
        ],
    }

    suggestions = list(by_intent.get(intent, by_intent["fallback"]))

    if domain == "kuliah":
        suggestions.insert(0, {"label": "Prioritas Kuliah", "command": "rekomendasi tugas kuliah paling urgent", "tone": "warning"})

    if style == "strict":
        suggestions.insert(0, {"label": "Mode Tegas", "command": "toxic motivasi sekarang", "tone": "critical"})

    if "evaluation" in recent:
        suggestions.insert(0, {"label": "Eksekusi Sekarang", "command": "oke mulai sekarang", "tone": "success"})

    return _dedupe_suggestions(suggestions)


def process_message_payload(raw_message: str, context_hint: dict | None = None) -> dict:
    message = normalize_message(raw_message)[:MAX_MESSAGE_LEN]
    hint = _normalize_context_hint(context_hint)

    if not message:
        context = {"domain": "umum", "intent": "fallback", "partner_label": "pasangan kalian", "focus_window": str(hint.get("focus_window", "any"))}
        adaptive = _infer_adaptive_profile("", context, hint)
        reply = pick_response("fallback", "", context)
        return {
            "reply": reply[:MAX_REPLY_LEN].strip(),
            "intent": "fallback",
            "suggestions": _build_quick_suggestions("fallback", context, adaptive, hint),
            "adaptive": adaptive,
        }

    intent = detect_intent(message)
    context = _build_context(message, intent, hint)
    adaptive = _infer_adaptive_profile(message, context, hint)

    reply = pick_response(intent, message, context)
    reply = _apply_adaptive_followup(intent, message, reply, context, adaptive)

    return {
        "reply": reply[:MAX_REPLY_LEN].strip(),
        "intent": intent,
        "suggestions": _build_quick_suggestions(intent, context, adaptive, hint),
        "adaptive": adaptive,
    }


def process_message(raw_message: str) -> str:
    payload = process_message_payload(raw_message)
    return str(payload.get("reply", "")).strip()
