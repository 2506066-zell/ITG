"""Main message processor for the stateless chatbot."""

from __future__ import annotations

import re
from typing import Any, TypedDict

from chatbot.intents import detect_intent, normalize_message
from chatbot.responses import pick_response


MAX_MESSAGE_LEN = 600
MAX_REPLY_LEN = 420
MAX_SUGGESTIONS = 4
MAX_PLAN_ACTIONS = 5
MAX_HISTORY_ITEMS = 8


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


class PlannerStep(TypedDict):
    id: str
    kind: str
    summary: str
    status: str
    command: str
    missing: list[str]


class PlannerFrame(TypedDict):
    mode: str
    confidence: str
    requires_clarification: bool
    clarifications: list[dict[str, str]]
    actions: list[PlannerStep]
    summary: str
    next_best_action: str


class MemoryUpdate(TypedDict):
    focus_topic: str
    recent_topics: list[str]
    recent_intents: list[str]
    unresolved_fields: list[str]
    pending_tasks: int
    pending_assignments: int
    avg_mood_7d: float


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _normalize_string_list(raw: Any, limit: int = MAX_HISTORY_ITEMS) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        text = str(item).strip().lower()
        if not text or text in out:
            continue
        out.append(text)
        if len(out) >= limit:
            break
    return out


def _extract_unresolved_fields(raw: Any, limit: int = MAX_HISTORY_ITEMS) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            text = str(item.get("field", "")).strip().lower()
        else:
            text = str(item).strip().lower()
        if not text or text in out:
            continue
        out.append(text)
        if len(out) >= limit:
            break
    return out


def _normalize_context_hint(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {
            "tone_mode": "supportive",
            "focus_minutes": 25,
            "focus_window": "any",
            "recent_intents": [],
            "preferred_commands": [],
            "avoid_commands": [],
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

    preferred_commands = _normalize_string_list(raw.get("preferred_commands", []), limit=6)
    avoid_commands = [item for item in _normalize_string_list(raw.get("avoid_commands", []), limit=6) if item not in preferred_commands]

    return {
        "tone_mode": tone_mode,
        "focus_minutes": focus_minutes,
        "focus_window": focus_window,
        "recent_intents": recent_intents,
        "preferred_commands": preferred_commands,
        "avoid_commands": avoid_commands,
    }


def _normalize_memory_hint(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {
            "focus_topic": "general",
            "recent_topics": [],
            "recent_intents": [],
            "pending_tasks": 0,
            "pending_assignments": 0,
            "avg_mood_7d": 0.0,
            "unresolved_fields": [],
        }

    nested = raw.get("memory") if isinstance(raw.get("memory"), dict) else {}

    recent_topics_raw = raw.get("recent_topics")
    if recent_topics_raw is None:
        recent_topics_raw = nested.get("recent_topics")
    recent_topics = _normalize_string_list(recent_topics_raw)

    recent_intents_raw = raw.get("recent_intents")
    if recent_intents_raw is None:
        recent_intents_raw = nested.get("recent_intents")
    recent_intents = _normalize_string_list(recent_intents_raw)

    unresolved_fields_raw = raw.get("unresolved_fields")
    if unresolved_fields_raw is None:
        unresolved_fields_raw = raw.get("unresolved")
    if unresolved_fields_raw is None:
        unresolved_fields_raw = nested.get("unresolved_fields")
    if unresolved_fields_raw is None:
        unresolved_fields_raw = nested.get("unresolved")
    unresolved_fields = _extract_unresolved_fields(unresolved_fields_raw)

    focus_topic = str(raw.get("focus_topic", nested.get("focus_topic", "general"))).strip().lower() or "general"
    if focus_topic == "general" and recent_topics:
        focus_topic = recent_topics[0]

    return {
        "focus_topic": focus_topic,
        "recent_topics": recent_topics,
        "recent_intents": recent_intents,
        "pending_tasks": max(0, _safe_int(raw.get("pending_tasks", 0), 0)),
        "pending_assignments": max(0, _safe_int(raw.get("pending_assignments", 0), 0)),
        "avg_mood_7d": float(raw.get("avg_mood_7d", 0.0) or 0.0),
        "unresolved_fields": unresolved_fields,
    }


def _has_deadline_signal(text: str) -> bool:
    return bool(re.search(r"(\bdeadline\b|\bdue\b|\bbesok\b|\blusa\b|\bhari ini\b|\btoday\b|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})", text, flags=re.IGNORECASE))


def _planner_action_from_segment(segment: str, index: int) -> PlannerStep | None:
    lower = segment.lower()
    missing: list[str] = []
    kind = ""
    summary = ""

    if re.search(r"(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\b", lower):
        kind = "create_assignment"
        summary = "Buat assignment baru"
        if not _has_deadline_signal(lower):
            missing.append("deadline")
        stripped = re.sub(r"(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\s*", "", segment, flags=re.IGNORECASE).strip()
        if len(stripped) < 3:
            missing.append("title")
    elif re.search(r"(?:buat|tambah|add|create)\s+(?:task|tugas)\b", lower):
        kind = "create_task"
        summary = "Buat task baru"
        if not _has_deadline_signal(lower):
            missing.append("deadline")
        stripped = re.sub(r"(?:buat|tambah|add|create)\s+(?:task|tugas)\s*", "", segment, flags=re.IGNORECASE).strip()
        if len(stripped) < 3:
            missing.append("title")
    elif re.search(r"(?:ingatkan|reminder|alarm|notifikasi)", lower):
        kind = "set_reminder"
        summary = "Atur reminder fokus"
    elif re.search(r"(?:evaluasi|review|refleksi)", lower):
        kind = "evaluation"
        summary = "Jalankan evaluasi singkat"
    elif re.search(r"(?:rekomendasi|prioritas|tugas apa dulu|task apa dulu)", lower):
        kind = "recommendation"
        summary = "Susun prioritas tugas"
    elif re.search(r"(?:target harian|cek target|goal hari ini)", lower):
        kind = "daily_target"
        summary = "Cek target harian"
    else:
        return None

    return {
        "id": f"step_{index}",
        "kind": kind,
        "summary": summary,
        "status": "blocked" if missing else "ready",
        "command": segment.strip(),
        "missing": missing,
    }


def _normalize_planner_step(raw: Any, index: int) -> PlannerStep | None:
    if not isinstance(raw, dict):
        return None
    missing = _extract_unresolved_fields(raw.get("missing"), limit=3)
    summary = str(raw.get("summary", "")).strip() or "Klarifikasi kebutuhan utama"
    command = normalize_message(str(raw.get("command", "")).strip()) or summary
    kind = str(raw.get("kind", "explore")).strip().lower() or "explore"
    status = str(raw.get("status", "")).strip().lower()
    if status not in {"ready", "blocked"}:
        status = "blocked" if missing else "ready"
    step_id = str(raw.get("id", f"step_{index}")).strip() or f"step_{index}"
    return {
        "id": step_id,
        "kind": kind,
        "summary": summary,
        "status": status,
        "command": command,
        "missing": missing,
    }


def _normalize_planner_hint(raw: Any) -> PlannerFrame | None:
    if not isinstance(raw, dict):
        return None

    actions: list[PlannerStep] = []
    actions_raw = raw.get("actions")
    if isinstance(actions_raw, list):
        for idx, item in enumerate(actions_raw, start=1):
            step = _normalize_planner_step(item, idx)
            if step is None:
                continue
            actions.append(step)
            if len(actions) >= MAX_PLAN_ACTIONS:
                break

    clarifications: list[dict[str, str]] = []
    clarifications_raw = raw.get("clarifications")
    if isinstance(clarifications_raw, list):
        for item in clarifications_raw:
            if not isinstance(item, dict):
                continue
            field = str(item.get("field", "")).strip().lower()
            if not field:
                continue
            question = str(item.get("question", "")).strip()
            if not question:
                question = "Deadline-nya kapan?" if field == "deadline" else "Detail yang kurang bisa dilengkapi?"
            action_id = str(item.get("action_id", "memory")).strip() or "memory"
            clarifications.append({"action_id": action_id, "field": field, "question": question})
            if len(clarifications) >= 4:
                break

    if not clarifications:
        for action in actions:
            for field in action.get("missing", []):
                question = "Deadline-nya kapan?" if field == "deadline" else "Judul/tujuannya apa?"
                clarifications.append({"action_id": action["id"], "field": field, "question": question})
                if len(clarifications) >= 4:
                    break
            if len(clarifications) >= 4:
                break

    requires_clarification = bool(raw.get("requires_clarification")) or len(clarifications) > 0
    confidence = str(raw.get("confidence", "")).strip().lower()
    if confidence not in {"low", "medium", "high"}:
        if not actions:
            confidence = "low"
        elif requires_clarification:
            confidence = "medium"
        else:
            confidence = "high"

    mode = str(raw.get("mode", "")).strip().lower()
    if mode not in {"single", "bundle"}:
        mode = "bundle" if len(actions) > 1 else "single"

    summary = str(raw.get("summary", "")).strip()
    if not summary:
        summary = " -> ".join([f"{i + 1}. {action['summary']}" for i, action in enumerate(actions)]) if actions else "Belum ada rencana eksekusi yang jelas."

    next_best_action = str(raw.get("next_best_action", "")).strip()
    if not next_best_action:
        next_best_action = "Lengkapi detail yang kurang dulu." if requires_clarification else (f"Eksekusi: {actions[0]['summary']}" if actions else "Jelaskan kebutuhanmu lebih spesifik.")

    return {
        "mode": mode,
        "confidence": confidence,
        "requires_clarification": requires_clarification,
        "clarifications": clarifications[:4],
        "actions": actions,
        "summary": summary,
        "next_best_action": next_best_action,
    }


def _build_planner(
    message: str,
    intent: str,
    memory: dict[str, Any],
    planner_hint: dict[str, Any] | None = None,
) -> PlannerFrame:
    hinted = _normalize_planner_hint(planner_hint)
    normalized = normalize_message(message)
    segments = [
        part.strip()
        for part in re.split(r"\s*(?:;|(?:,\s*)?(?:dan|lalu|kemudian|terus|habis itu|setelah itu))\s*", normalized, flags=re.IGNORECASE)
        if part.strip()
    ]
    if not segments and normalized:
        segments = [normalized]

    actions: list[PlannerStep] = []
    if hinted and hinted.get("actions"):
        actions = hinted.get("actions", [])[:MAX_PLAN_ACTIONS]
    else:
        for idx, segment in enumerate(segments, start=1):
            action = _planner_action_from_segment(segment, idx)
            if action is not None:
                actions.append(action)
            elif len(segments) == 1:
                actions.append({
                    "id": "step_1",
                    "kind": intent or "explore",
                    "summary": "Klarifikasi kebutuhan utama",
                    "status": "ready",
                    "command": segment,
                    "missing": [],
                })
            if len(actions) >= MAX_PLAN_ACTIONS:
                break

    clarifications: list[dict[str, str]] = []
    if hinted and hinted.get("clarifications"):
        clarifications = hinted.get("clarifications", [])[:4]
    else:
        for action in actions:
            for field in action.get("missing", []):
                question = "Deadline-nya kapan?" if field == "deadline" else "Judul/tujuannya apa?"
                clarifications.append({"action_id": action["id"], "field": field, "question": question})

    unresolved_fields = memory.get("unresolved_fields", [])
    if not clarifications and isinstance(unresolved_fields, list) and unresolved_fields and intent == "fallback":
        for field in unresolved_fields[:2]:
            question = "Deadline-nya kapan?" if field == "deadline" else "Detail yang kurang bisa dilengkapi?"
            clarifications.append({"action_id": "memory", "field": str(field), "question": question})

    requires_clarification = len(clarifications) > 0
    summary = str(hinted.get("summary", "")).strip() if hinted else ""
    if not summary:
        summary = " -> ".join([f"{i + 1}. {action['summary']}" for i, action in enumerate(actions)]) if actions else "Belum ada rencana eksekusi yang jelas."

    confidence = str(hinted.get("confidence", "")).strip().lower() if hinted else ""
    if confidence not in {"low", "medium", "high"}:
        confidence = "high"
    if not actions:
        confidence = "low"
    elif requires_clarification and confidence == "high":
        confidence = "medium"

    mode = str(hinted.get("mode", "")).strip().lower() if hinted else ""
    if mode not in {"single", "bundle"}:
        mode = "bundle" if len(actions) > 1 else "single"

    next_best_action = str(hinted.get("next_best_action", "")).strip() if hinted else ""
    if not next_best_action:
        next_best_action = "Lengkapi detail yang kurang dulu." if requires_clarification else (f"Eksekusi: {actions[0]['summary']}" if actions else "Jelaskan kebutuhanmu lebih spesifik.")

    return {
        "mode": mode,
        "confidence": confidence,
        "requires_clarification": requires_clarification,
        "clarifications": clarifications[:4],
        "actions": actions,
        "summary": summary,
        "next_best_action": next_best_action,
    }


def _detect_focus_domain(message: str) -> str:
    lower = message.lower()
    if re.search(r"\b(kuliah|assignment|deadline|ipk|makalah|quiz|ujian)\b", lower):
        return "kuliah"
    if re.search(r"\b(belajar|study plan|jadwal belajar|sesi belajar)\b", lower):
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


def _build_quick_suggestions(
    intent: str,
    context: dict[str, str],
    profile: AdaptiveProfile,
    hint: dict[str, Any],
    memory: dict[str, Any],
    planner: PlannerFrame,
) -> list[QuickSuggestion]:
    domain = context.get("domain", "umum")
    focus_minutes = int(profile.get("focus_minutes", 25))
    style = str(profile.get("style", "supportive"))
    recent = [str(x).lower() for x in hint.get("recent_intents", [])]
    preferred_commands = _normalize_string_list(hint.get("preferred_commands", []), limit=6)
    avoid_commands = set(_normalize_string_list(hint.get("avoid_commands", []), limit=6))

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
        "study_schedule": [
            {"label": "Besok Pagi", "command": "jadwal belajar besok pagi 120 menit", "tone": "info"},
            {"label": "Target 180m", "command": "jadwal belajar 180 menit", "tone": "success"},
            {"label": "Mode Malam", "command": "jadwal belajar malam 90 menit", "tone": "warning"},
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

    unresolved = memory.get("unresolved_fields", [])
    if isinstance(unresolved, list):
        if "deadline" in unresolved:
            suggestions.insert(0, {"label": "Isi Deadline", "command": "deadline besok 19:00", "tone": "warning"})
        if "title" in unresolved:
            suggestions.insert(0, {"label": "Isi Judul", "command": "judul tugas [isi judul]", "tone": "info"})

    if planner.get("requires_clarification"):
        suggestions.insert(0, {"label": "Lengkapi Detail", "command": "oke saya lengkapi detailnya", "tone": "warning"})
    elif planner.get("mode") == "bundle":
        suggestions.insert(0, {"label": "Jalankan Bundle", "command": "oke jalankan rencana ini", "tone": "success"})

    if avoid_commands:
        suggestions = [
            item for item in suggestions
            if str(item.get("command", "")).strip().lower() not in avoid_commands
        ]

    if preferred_commands:
        by_command = {}
        for item in suggestions:
            cmd = str(item.get("command", "")).strip().lower()
            if not cmd or cmd in by_command:
                continue
            by_command[cmd] = item

        prioritized: list[QuickSuggestion] = []
        for cmd in preferred_commands:
            if cmd in by_command:
                prioritized.append(by_command[cmd])
            else:
                label = cmd[:30] if len(cmd) > 30 else cmd
                prioritized.append({"label": label, "command": cmd, "tone": "success"})

        for item in suggestions:
            cmd = str(item.get("command", "")).strip().lower()
            if cmd in preferred_commands:
                continue
            prioritized.append(item)
        suggestions = prioritized

    return _dedupe_suggestions(suggestions)


def _extract_message_topics(message: str) -> list[str]:
    lower = str(message).lower()
    topics: list[str] = []

    def push(value: str) -> None:
        if value not in topics:
            topics.append(value)

    if re.search(r"\b(kuliah|assignment|deadline|ujian|quiz|makalah)\b", lower):
        push("kuliah")
    if re.search(r"\b(target|goal|prioritas)\b", lower):
        push("target")
    if re.search(r"\b(reminder|ingat|alarm|notifikasi)\b", lower):
        push("reminder")
    if re.search(r"\b(check-?in|progres|progress|sync)\b", lower):
        push("checkin")
    if re.search(r"\b(evaluasi|review|refleksi)\b", lower):
        push("evaluation")
    if re.search(r"\b(mood|lelah|burnout|stress)\b", lower):
        push("mood")
    if re.search(r"\b(couple|pasangan|partner)\b", lower):
        push("couple")
    if not topics:
        push("general")
    return topics[:5]


def _build_memory_update(
    intent: str,
    message: str,
    memory: dict[str, Any],
    planner: PlannerFrame,
) -> MemoryUpdate:
    topics = _extract_message_topics(message)
    unresolved_fields: list[str] = []
    for item in planner.get("clarifications", []):
        field = str(item.get("field", "")).strip().lower()
        if not field or field in unresolved_fields:
            continue
        unresolved_fields.append(field)
        if len(unresolved_fields) >= 4:
            break

    recent_topics = _normalize_string_list([*topics, *(memory.get("recent_topics", []) or [])], MAX_HISTORY_ITEMS)
    if intent:
        recent_intents = _normalize_string_list([intent, *(memory.get("recent_intents", []) or [])], MAX_HISTORY_ITEMS)
    else:
        recent_intents = _normalize_string_list(memory.get("recent_intents", []), MAX_HISTORY_ITEMS)

    focus_topic = str(memory.get("focus_topic", "general")).strip().lower() or "general"
    if topics:
        focus_topic = topics[0]
    elif focus_topic == "general" and recent_topics:
        focus_topic = recent_topics[0]

    return {
        "focus_topic": focus_topic,
        "recent_topics": recent_topics,
        "recent_intents": recent_intents,
        "unresolved_fields": unresolved_fields,
        "pending_tasks": max(0, _safe_int(memory.get("pending_tasks", 0), 0)),
        "pending_assignments": max(0, _safe_int(memory.get("pending_assignments", 0), 0)),
        "avg_mood_7d": float(memory.get("avg_mood_7d", 0.0) or 0.0),
    }


def process_message_payload(
    raw_message: str,
    context_hint: dict | None = None,
    memory_hint: dict | None = None,
    planner_hint: dict | None = None,
) -> dict:
    message = normalize_message(raw_message)[:MAX_MESSAGE_LEN]
    hint = _normalize_context_hint(context_hint)
    memory = _normalize_memory_hint(memory_hint)

    if not message:
        context = {"domain": "umum", "intent": "fallback", "partner_label": "pasangan kalian", "focus_window": str(hint.get("focus_window", "any"))}
        adaptive = _infer_adaptive_profile("", context, hint)
        planner = _build_planner("", "fallback", memory, planner_hint)
        reply = pick_response("fallback", "", context)
        memory_update = _build_memory_update("fallback", "", memory, planner)
        return {
            "reply": reply[:MAX_REPLY_LEN].strip(),
            "intent": "fallback",
            "planner": planner,
            "suggestions": _build_quick_suggestions("fallback", context, adaptive, hint, memory, planner),
            "adaptive": adaptive,
            "memory_update": memory_update,
        }

    intent = detect_intent(message)
    context = _build_context(message, intent, hint)
    adaptive = _infer_adaptive_profile(message, context, hint)
    planner = _build_planner(message, intent, memory, planner_hint)

    reply = pick_response(intent, message, context)
    reply = _apply_adaptive_followup(intent, message, reply, context, adaptive)
    memory_update = _build_memory_update(intent, message, memory, planner)

    return {
        "reply": reply[:MAX_REPLY_LEN].strip(),
        "intent": intent,
        "planner": planner,
        "suggestions": _build_quick_suggestions(intent, context, adaptive, hint, memory, planner),
        "adaptive": adaptive,
        "memory_update": memory_update,
    }


def process_message(raw_message: str) -> str:
    payload = process_message_payload(raw_message)
    return str(payload.get("reply", "")).strip()
