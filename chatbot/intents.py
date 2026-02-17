"""Intent detection rules for the stateless chatbot."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Pattern


@dataclass(frozen=True)
class IntentRule:
    name: str
    pattern: Pattern[str]


def _compile(pattern: str) -> Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


INTENT_RULES: tuple[IntentRule, ...] = (
    # Order matters: specific intents should be evaluated first.
    IntentRule("toxic_motivation", _compile(r"\b(toxic|mode tegas|gaspol|push keras|no excuse|no excuses)\b")),
    IntentRule(
        "evaluation",
        _compile(r"\b(evaluasi|review|refleksi|retrospektif|daily review|weekly review)\b"),
    ),
    IntentRule(
        "recommend_task",
        _compile(r"\b(rekomendasi|rekomendasi tugas|saran tugas|prioritas|task apa dulu|tugas apa dulu)\b"),
    ),
    IntentRule(
        "study_schedule",
        _compile(
            r"(?:\b(jadwal belajar|study plan|rencana belajar|sesi belajar)\b.*\b(waktu kosong|jam kosong|slot kosong|free slot|free time|waktu luang)\b)|"
            r"(?:\b(buat|buatkan|susun|atur|generate|carikan|rancang)\b.*\b(jadwal belajar|study plan|rencana belajar)\b)|"
            r"(?:^(jadwal belajar|study plan)\b)"
        ),
    ),
    IntentRule(
        "affirmation",
        _compile(r"\b(oke|ok|siap|gas|lanjut|deal|sip|mantap|yuk)\b"),
    ),
    IntentRule(
        "check_daily_target",
        _compile(
            r"(?:\b(target|goal)\b.*\b(harian|hari ini|today|pasangan|bareng|bersama)\b)|"
            r"(?:\bcek\b.*\b(target|goal)\b)|"
            r"(?:\btarget\b.*\b(kita|pasangan)\b)"
        ),
    ),
    IntentRule(
        "reminder_ack",
        _compile(r"\b(reminder|ingatkan|ingetin|notifikasi|alarm|jangan lupa)\b"),
    ),
    IntentRule(
        "checkin_progress",
        _compile(
            r"(?:\b(check-?in|cek in|update)\b.*\b(progress|progres|tugas|belajar|goal|target)\b)|"
            r"(?:\b(progress|progres)\b.*\b(hari ini|today|kita|pasangan)\b)"
        ),
    ),
    IntentRule("greeting", _compile(r"\b(halo|hai|hi|hello|hey)\b")),
)


def normalize_message(text: str) -> str:
    return re.sub(r"\s{2,}", " ", str(text or "").strip())


def detect_intent(message: str, rules: Iterable[IntentRule] = INTENT_RULES) -> str:
    text = normalize_message(message)
    if not text:
        return "fallback"

    for rule in rules:
        if rule.pattern.search(text):
            return rule.name
    return "fallback"
