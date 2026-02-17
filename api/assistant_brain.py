import json
import os
import re
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler


DEFAULT_TIME_TEXT = "21:00"
ALLOWED_USERS = {"Zaldy", "Nesya"}
ALLOWED_TOOLS = {
    "create_task",
    "create_assignment",
    "complete_task",
    "complete_assignment",
    "update_task_deadline",
    "get_tasks",
    "get_assignments",
    "get_deadline_risk",
    "get_daily_brief",
    "get_unified_memory",
    "get_memory_graph",
    "get_study_plan",
    "get_schedule",
    "get_goals",
    "get_report",
    "set_study_preferences",
    "replan_study_window",
    "nudge_partner_checkin",
}


def _send_json(handler, status_code, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json(handler):
    raw_len = handler.headers.get("Content-Length", "0").strip()
    try:
        length = int(raw_len)
    except Exception:
        length = 0
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8", errors="ignore")
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _collapse_spaces(text=""):
    return re.sub(r"\s{2,}", " ", str(text or "")).strip()


def _normalize_priority(raw=""):
    val = str(raw or "").strip().lower()
    if val in ("high", "tinggi"):
        return "high"
    if val in ("low", "rendah"):
        return "low"
    return "medium"


def _normalize_assigned_to(raw="", fallback=""):
    candidate = str(raw or "").strip().lower()
    if candidate:
        fixed = candidate[:1].upper() + candidate[1:]
        if fixed in ALLOWED_USERS:
            return fixed
    fb = str(fallback or "").strip()
    if fb in ALLOWED_USERS:
        return fb
    return None


def _placeholder_title(title=""):
    clean = _collapse_spaces(title).lower()
    if len(clean) < 3:
        return True
    return clean in {"task", "tugas", "todo", "to-do", "assignment", "kuliah", "belajar", "study"}


def _parse_datetime_from_text(text=""):
    msg = str(text or "")
    lower = msg.lower()
    now = datetime.now()

    iso_match = re.search(r"\b(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?\b", msg)
    if iso_match:
        date_part = iso_match.group(1)
        time_part = iso_match.group(2) or DEFAULT_TIME_TEXT
        try:
            parsed = datetime.strptime(f"{date_part} {time_part}", "%Y-%m-%d %H:%M")
            return parsed.isoformat(timespec="seconds")
        except Exception:
            pass

    dmy_match = re.search(r"\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}:\d{2}))?\b", msg)
    if dmy_match:
        day = int(dmy_match.group(1))
        month = int(dmy_match.group(2))
        year = int(dmy_match.group(3))
        time_part = dmy_match.group(4) or DEFAULT_TIME_TEXT
        try:
            parsed = datetime.strptime(f"{year:04d}-{month:02d}-{day:02d} {time_part}", "%Y-%m-%d %H:%M")
            return parsed.isoformat(timespec="seconds")
        except Exception:
            pass

    time_match = re.search(r"\b(\d{1,2}:\d{2})\b", msg)
    hhmm = time_match.group(1) if time_match else DEFAULT_TIME_TEXT
    try:
        hh, mm = [int(x) for x in hhmm.split(":", 1)]
    except Exception:
        hh, mm = 21, 0

    day_offset = 0
    if re.search(r"\b(lusa|day after tomorrow)\b", lower):
        day_offset = 2
    elif re.search(r"\b(besok|tomorrow)\b", lower):
        day_offset = 1
    elif re.search(r"\b(hari ini|today)\b", lower):
        day_offset = 0
    else:
        return None

    target = now + timedelta(days=day_offset)
    target = target.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return target.isoformat(timespec="seconds")


def _strip_task_title(text=""):
    title = str(text or "")
    title = re.sub(r"^(?:tolong|please|pls|bisa|boleh|minta)\s+", "", title, flags=re.I)
    title = re.sub(r"^(?:buat|buatkan|tambah|add|create|catat|ingatkan)\s+(?:task|tugas)\s*", "", title, flags=re.I)
    title = re.sub(r"\b(?:priority|prioritas)\s*(?:high|medium|low|tinggi|sedang|rendah)\b", "", title, flags=re.I)
    title = re.sub(r"\b(?:assign(?:ed)?\s*to|untuk|for)\s*(?:zaldy|nesya)\b", "", title, flags=re.I)
    title = re.sub(r"\b(?:deadline|due)\b.*$", "", title, flags=re.I)
    title = re.sub(r"\b(?:today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b", "", title, flags=re.I)
    title = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "", title)
    title = re.sub(r"\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b", "", title)
    title = re.sub(r"\b\d{1,2}:\d{2}\b", "", title)
    return _collapse_spaces(title)


def _strip_assignment_title(text=""):
    title = str(text or "")
    title = re.sub(r"^(?:tolong|please|pls|bisa|boleh|minta)\s+", "", title, flags=re.I)
    title = re.sub(r"^(?:buat|buatkan|tambah|add|create|catat|ingatkan)\s+(?:assignment|tugas kuliah)\s*", "", title, flags=re.I)
    title = re.sub(r"\b(?:assign(?:ed)?\s*to|untuk|for)\s*(?:zaldy|nesya)\b", "", title, flags=re.I)
    title = re.sub(r"\b(?:deskripsi|description|desc)\b.*$", "", title, flags=re.I)
    title = re.sub(r"\b(?:deadline|due)\b.*$", "", title, flags=re.I)
    title = re.sub(r"\b(?:today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b", "", title, flags=re.I)
    title = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", "", title)
    title = re.sub(r"\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b", "", title)
    title = re.sub(r"\b\d{1,2}:\d{2}\b", "", title)
    return _collapse_spaces(title)


def _parse_create_task(message="", user=""):
    original = str(message or "").strip()
    priority_match = re.search(r"(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)", original, flags=re.I)
    assigned_match = re.search(r"(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b", original, flags=re.I)
    deadline = _parse_datetime_from_text(original)
    title = _strip_task_title(original)
    args = {
        "title": title,
        "priority": _normalize_priority(priority_match.group(1) if priority_match else ""),
        "assigned_to": _normalize_assigned_to(assigned_match.group(1) if assigned_match else "", user),
        "deadline": deadline,
    }
    return args


def _parse_create_assignment(message="", user=""):
    original = str(message or "").strip()
    assigned_match = re.search(r"(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b", original, flags=re.I)
    deadline = _parse_datetime_from_text(original)
    desc_match = re.search(r"(?:deskripsi|description|desc)\s+(.+?)(?=\s+(?:deadline|due)\b|$)", original, flags=re.I)
    description = _collapse_spaces(desc_match.group(1)) if desc_match else ""
    title = _strip_assignment_title(original)
    args = {
        "title": title,
        "description": description or None,
        "assigned_to": _normalize_assigned_to(assigned_match.group(1) if assigned_match else "", user),
        "deadline": deadline,
    }
    return args


def _build_clarification(field, question, example):
    return {"field": field, "question": question, "example": example}


def _detect_intent(message="", user=""):
    msg = str(message or "").strip()
    lower = msg.lower()

    if re.search(r"(?:buat|buatkan|tambah|add|create)\s+(?:task|tugas)\b", lower):
        args = _parse_create_task(msg, user)
        clarifications = []
        if _placeholder_title(args.get("title", "")):
            clarifications.append(_build_clarification("title", "Judul task-nya apa?", "buat task review basis data deadline besok 19:00 priority high"))
        if not args.get("deadline"):
            clarifications.append(_build_clarification("deadline", "Deadline task kapan?", "buat task review basis data deadline besok 19:00 priority high"))
        if clarifications:
            return {
                "tool": "create_task",
                "mode": "clarification_required",
                "summary": "Butuh detail untuk buat task",
                "args": args,
                "clarifications": clarifications,
                "confidence": "high",
                "natural_reply": "Siap, aku bantu buat task. Biar akurat, aku perlu detail berikut dulu.",
            }
        return {
            "tool": "create_task",
            "mode": "write",
            "summary": "Buat task baru",
            "args": args,
            "confidence": "high",
            "natural_reply": "Sip, task-nya akan langsung aku eksekusi sekarang.",
        }

    if re.search(r"(?:buat|buatkan|tambah|add|create)\s+(?:assignment|tugas kuliah)\b", lower):
        args = _parse_create_assignment(msg, user)
        clarifications = []
        if _placeholder_title(args.get("title", "")):
            clarifications.append(_build_clarification("title", "Judul tugas kuliahnya apa?", "buat assignment makalah AI deadline besok 21:00"))
        if not args.get("deadline"):
            clarifications.append(_build_clarification("deadline", "Deadline tugas kuliahnya kapan?", "buat assignment makalah AI deadline 2026-03-01 21:00"))
        if clarifications:
            return {
                "tool": "create_assignment",
                "mode": "clarification_required",
                "summary": "Butuh detail untuk buat assignment",
                "args": args,
                "clarifications": clarifications,
                "confidence": "high",
                "natural_reply": "Oke, aku siap buat tugas kuliah. Tinggal lengkapi detail pentingnya dulu.",
            }
        return {
            "tool": "create_assignment",
            "mode": "write",
            "summary": "Buat assignment baru",
            "args": args,
            "confidence": "high",
            "natural_reply": "Siap, assignment akan langsung aku buat sesuai detailmu.",
        }

    complete_task = re.search(r"(?:selesaikan|complete|done|tandai)\s+(?:task|tugas)(?:\s*id)?\s*#?(\d+)", lower)
    if complete_task:
        return {
            "tool": "complete_task",
            "mode": "write",
            "summary": f"Tandai task #{complete_task.group(1)} selesai",
            "args": {"id": int(complete_task.group(1))},
            "confidence": "high",
            "natural_reply": "Mantap, aku tandai task itu sebagai selesai.",
        }

    complete_assignment = re.search(r"(?:selesaikan|complete|done|tandai)\s+(?:assignment|tugas kuliah)(?:\s*id)?\s*#?(\d+)", lower)
    if complete_assignment:
        return {
            "tool": "complete_assignment",
            "mode": "write",
            "summary": f"Tandai assignment #{complete_assignment.group(1)} selesai",
            "args": {"id": int(complete_assignment.group(1))},
            "confidence": "high",
            "natural_reply": "Siap, assignment itu aku tandai sudah selesai.",
        }

    update_deadline = re.search(r"(?:ubah|update|ganti|reschedule|geser)\s+(?:deadline|due).*(?:task|tugas)(?:\s*id)?\s*#?(\d+)", lower)
    if update_deadline:
        return {
            "tool": "update_task_deadline",
            "mode": "write",
            "summary": f"Ubah deadline task #{update_deadline.group(1)}",
            "args": {"id": int(update_deadline.group(1)), "deadline": _parse_datetime_from_text(msg)},
            "confidence": "medium",
            "natural_reply": "Baik, aku bantu update deadline task-nya.",
        }

    if re.search(r"(?:risk|resiko|risiko|berisiko|rawan|terlambat).*(?:deadline|task|tugas|assignment|kuliah)", lower):
        return {
            "tool": "get_deadline_risk",
            "mode": "read",
            "summary": "Prediksi risiko deadline",
            "args": {"horizon_hours": 48},
            "confidence": "high",
            "natural_reply": "Aku cek dulu item yang paling berisiko telat.",
        }

    if re.search(r"(?:assignment|tugas kuliah|kuliah).*(?:pending|belum|deadline|list|daftar|apa)", lower):
        return {
            "tool": "get_assignments",
            "mode": "read",
            "summary": "Lihat assignment",
            "args": {"limit": 8, "pending_only": True},
            "confidence": "high",
            "natural_reply": "Siap, aku tampilkan assignment yang masih pending.",
        }

    if re.search(r"(?:task|tugas|todo|to-do).*(?:pending|belum|deadline|list|daftar|apa)", lower):
        return {
            "tool": "get_tasks",
            "mode": "read",
            "summary": "Lihat task",
            "args": {"limit": 8, "pending_only": True, "scope": "mine"},
            "confidence": "high",
            "natural_reply": "Oke, aku ambil task yang belum selesai.",
        }

    if re.search(r"(?:memory graph|graf|graph memory)", lower):
        return {
            "tool": "get_memory_graph",
            "mode": "read",
            "summary": "Lihat memory graph",
            "args": {},
            "confidence": "medium",
            "natural_reply": "Aku buka memory graph terbaru biar konteksnya kebaca jelas.",
        }

    if re.search(r"(?:memory|snapshot|konteks|context)", lower):
        return {
            "tool": "get_unified_memory",
            "mode": "read",
            "summary": "Lihat memory snapshot",
            "args": {},
            "confidence": "medium",
            "natural_reply": "Aku tarik snapshot konteks terpadu dulu.",
        }

    if re.search(r"(?:jadwal belajar|study plan|belajar besok|target belajar)", lower):
        return {
            "tool": "get_study_plan",
            "mode": "read",
            "summary": "Rencana belajar",
            "args": {"target_minutes": 150},
            "confidence": "medium",
            "natural_reply": "Siap, aku susun plan belajar yang realistis dulu.",
        }

    if re.search(r"(?:ringkasan hari ini|brief|summary|hari ini)", lower):
        return {
            "tool": "get_daily_brief",
            "mode": "read",
            "summary": "Ringkasan hari ini",
            "args": {"limit": 5},
            "confidence": "high",
            "natural_reply": "Oke, aku rangkum status terpenting hari ini.",
        }

    return None


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        _send_json(
            self,
            200,
            {
                "ok": True,
                "engine": "python-v1",
                "path": self.path.split("?", 1)[0],
                "ready": True,
            },
        )

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/assistant-brain", "/api/assistant_brain.py"):
            _send_json(self, 404, {"ok": False, "error": "Not Found"})
            return

        required_secret = str(os.getenv("ASSISTANT_BRAIN_SHARED_SECRET", "")).strip()
        if required_secret:
            incoming_secret = str(self.headers.get("X-Brain-Secret", "")).strip()
            if incoming_secret != required_secret:
                _send_json(self, 401, {"ok": False, "error": "Unauthorized"})
                return

        body = _read_json(self)
        message = _collapse_spaces(body.get("message", ""))
        user = _collapse_spaces(body.get("user", ""))
        if not message:
            _send_json(self, 400, {"ok": False, "error": "message required"})
            return

        decision = _detect_intent(message, user)
        if not decision:
            _send_json(self, 200, {"ok": False, "reason": "no_intent", "engine": "python-v1"})
            return

        tool = str(decision.get("tool", "")).strip()
        if tool not in ALLOWED_TOOLS:
            _send_json(self, 200, {"ok": False, "reason": "tool_not_allowed", "engine": "python-v1"})
            return

        decision["ok"] = True
        decision["engine"] = "python-v1"
        _send_json(self, 200, decision)
