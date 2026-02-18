"""Intent detection rules for the stateless chatbot."""

from __future__ import annotations

import json
import math
import os
import re
import threading
import urllib.request
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
    IntentRule(
        "create_assignment",
        _compile(
            r"(?:\b(buat|buatkan|tambah|add|create|catat|simpan)\b.*\b(assignment|tugas kuliah)\b)|"
            r"(?:\b(tugas kuliah|assignment)\b.*\b(buat|tambahkan|catat|simpan)\b)"
        ),
    ),
    IntentRule(
        "create_task",
        _compile(
            r"(?:\b(buat|buatkan|tambah|add|create|catat|simpan)\b.*\b(task|tugas|todo|to-do)\b)|"
            r"(?:\b(task|tugas|todo|to-do)\b.*\b(buat|tambahkan|catat|simpan)\b)"
        ),
    ),
    IntentRule(
        "set_reminder",
        _compile(
            r"\b(reminder|ingatkan|ingetin|notifikasi|alarm|jangan lupa)\b"
        ),
    ),
    IntentRule(
        "daily_brief",
        _compile(
            r"\b(ringkasan hari ini|brief hari ini|summary hari ini|rekap hari ini|status hari ini|fokus hari ini)\b"
        ),
    ),
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
        _compile(
            r"(?:\b(reminder|alarm|notifikasi)\b.*\b(ok|oke|siap|aktif|jalan)\b)|"
            r"(?:\b(ok|oke|siap|aktif|jalan)\b.*\b(reminder|alarm|notifikasi)\b)"
        ),
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


INTENT_PROTOTYPES: dict[str, tuple[str, ...]] = {
    "greeting": (
        "halo z ai",
        "hai bantu aku",
        "hi ada yang bisa dibantu",
    ),
    "create_task": (
        "buat task belajar basis data deadline besok",
        "tambah tugas harian untuk dikerjakan",
        "catat todo kuliah hari ini",
    ),
    "create_assignment": (
        "buat assignment makalah ai deadline minggu ini",
        "tambah tugas kuliah baru",
        "catat assignment kampus",
    ),
    "set_reminder": (
        "ingatkan aku jam 7 malam",
        "set reminder untuk belajar",
        "jangan lupa notifikasi deadline",
    ),
    "daily_brief": (
        "ringkasan hari ini",
        "brief tugas harian",
        "rekap fokus hari ini",
    ),
    "check_daily_target": (
        "cek target harian pasangan",
        "goal hari ini apa",
        "target kita hari ini",
    ),
    "checkin_progress": (
        "update progres tugas",
        "check in progres belajar",
        "laporan progress hari ini",
    ),
    "recommend_task": (
        "rekomendasi tugas mana dulu",
        "prioritas tugas kuliah sekarang",
        "aku harus kerjain apa dulu",
    ),
    "study_schedule": (
        "buat jadwal belajar dari waktu kosong",
        "susun study plan besok pagi",
        "atur sesi belajar",
    ),
    "evaluation": (
        "evaluasi hari ini",
        "review progres hari ini",
        "refleksi belajar",
    ),
    "toxic_motivation": (
        "kasih motivasi tegas",
        "mode no excuse sekarang",
        "gaspol jangan kasih kendor",
    ),
    "affirmation": (
        "oke lanjut",
        "siap gas",
        "deal kerjain sekarang",
    ),
    "reminder_ack": (
        "reminder oke aktifkan",
        "notifikasi sudah jalan",
        "alarmnya siap",
    ),
}


_NEURAL_CENTROID_CACHE: dict[str, dict[str, list[float]]] = {}
_NEURAL_CACHE_LOCK = threading.Lock()


def normalize_message(text: str) -> str:
    return re.sub(r"\s{2,}", " ", str(text or "").strip())


def _to_float(value: str, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _neural_config() -> dict[str, object]:
    api_key = str(os.getenv("CHATBOT_LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip()
    raw_enabled = str(os.getenv("CHATBOT_NEURAL_INTENT_ENABLED") or "").strip().lower()
    if raw_enabled in {"1", "true", "yes", "on"}:
        enabled = bool(api_key)
    elif raw_enabled in {"0", "false", "no", "off"}:
        enabled = False
    else:
        enabled = bool(api_key)

    api_base = str(os.getenv("CHATBOT_NEURAL_API_BASE") or os.getenv("OPENAI_API_BASE") or "https://api.openai.com").strip()
    model = str(os.getenv("CHATBOT_NEURAL_EMBED_MODEL") or "text-embedding-3-small").strip()
    timeout_s = max(0.3, min(3.0, _to_float(str(os.getenv("CHATBOT_NEURAL_TIMEOUT_S") or "0.9"), 0.9)))
    threshold = max(0.55, min(0.92, _to_float(str(os.getenv("CHATBOT_NEURAL_INTENT_THRESHOLD") or "0.76"), 0.76)))
    margin = max(0.0, min(0.2, _to_float(str(os.getenv("CHATBOT_NEURAL_INTENT_MARGIN") or "0.02"), 0.02)))
    return {
        "enabled": enabled,
        "api_key": api_key,
        "api_base": api_base,
        "model": model,
        "timeout_s": timeout_s,
        "threshold": threshold,
        "margin": margin,
    }


def _request_embeddings(
    texts: list[str],
    *,
    api_key: str,
    api_base: str,
    model: str,
    timeout_s: float,
) -> list[list[float]] | None:
    if not texts:
        return None
    url = f"{api_base.rstrip('/')}/v1/embeddings"
    payload = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(
        url=url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    rows = body.get("data")
    if not isinstance(rows, list) or not rows:
        return None

    by_index: dict[int, list[float]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        idx = row.get("index")
        emb = row.get("embedding")
        if not isinstance(idx, int) or not isinstance(emb, list):
            continue
        vec: list[float] = []
        for num in emb:
            try:
                vec.append(float(num))
            except Exception:
                vec.append(0.0)
        by_index[idx] = vec

    out = [by_index.get(i) for i in range(len(texts))]
    if any(item is None for item in out):
        return None
    return [item or [] for item in out]


def _normalize_vector(vec: list[float]) -> list[float]:
    if not vec:
        return []
    norm = math.sqrt(sum(x * x for x in vec))
    if norm <= 0.0:
        return []
    return [x / norm for x in vec]


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return -1.0
    n = min(len(a), len(b))
    if n <= 0:
        return -1.0
    return sum(a[i] * b[i] for i in range(n))


def _build_intent_centroids(config: dict[str, object]) -> dict[str, list[float]] | None:
    api_key = str(config.get("api_key") or "")
    api_base = str(config.get("api_base") or "")
    model = str(config.get("model") or "")
    timeout_s = float(config.get("timeout_s") or 0.9)
    if not api_key or not api_base or not model:
        return None

    phrases: list[str] = []
    owners: list[str] = []
    for intent_name, samples in INTENT_PROTOTYPES.items():
        for sample in samples:
            text = normalize_message(sample)
            if not text:
                continue
            phrases.append(text)
            owners.append(intent_name)
    if not phrases:
        return None

    vectors = _request_embeddings(
        phrases,
        api_key=api_key,
        api_base=api_base,
        model=model,
        timeout_s=timeout_s,
    )
    if not vectors or len(vectors) != len(phrases):
        return None

    grouped: dict[str, list[list[float]]] = {}
    for intent_name, vec in zip(owners, vectors):
        if not vec:
            continue
        grouped.setdefault(intent_name, []).append(vec)

    centroids: dict[str, list[float]] = {}
    for intent_name, bucket in grouped.items():
        if not bucket:
            continue
        dim = min(len(vec) for vec in bucket if vec)
        if dim <= 0:
            continue
        summed = [0.0] * dim
        for vec in bucket:
            for i in range(dim):
                summed[i] += vec[i]
        avg = [value / len(bucket) for value in summed]
        norm = _normalize_vector(avg)
        if norm:
            centroids[intent_name] = norm
    return centroids or None


def _get_intent_centroids(config: dict[str, object]) -> dict[str, list[float]] | None:
    model = str(config.get("model") or "")
    api_base = str(config.get("api_base") or "")
    cache_key = f"{api_base}|{model}"
    with _NEURAL_CACHE_LOCK:
        cached = _NEURAL_CENTROID_CACHE.get(cache_key)
    if cached:
        return cached

    built = _build_intent_centroids(config)
    if not built:
        return None
    with _NEURAL_CACHE_LOCK:
        _NEURAL_CENTROID_CACHE[cache_key] = built
    return built


def _detect_intent_neural(text: str) -> str | None:
    config = _neural_config()
    if not bool(config.get("enabled")):
        return None
    if len(text) < 8:
        return None

    centroids = _get_intent_centroids(config)
    if not centroids:
        return None

    vector_rows = _request_embeddings(
        [text],
        api_key=str(config.get("api_key") or ""),
        api_base=str(config.get("api_base") or ""),
        model=str(config.get("model") or ""),
        timeout_s=float(config.get("timeout_s") or 0.9),
    )
    if not vector_rows or not vector_rows[0]:
        return None
    query_vec = _normalize_vector(vector_rows[0])
    if not query_vec:
        return None

    best_intent = ""
    best_score = -1.0
    second_score = -1.0
    for intent_name, centroid in centroids.items():
        score = _cosine_similarity(query_vec, centroid)
        if score > best_score:
            second_score = best_score
            best_score = score
            best_intent = intent_name
        elif score > second_score:
            second_score = score

    threshold = float(config.get("threshold") or 0.76)
    margin = float(config.get("margin") or 0.02)
    if best_intent and best_score >= threshold and (best_score - second_score) >= margin:
        return best_intent
    return None


def detect_intent(message: str, rules: Iterable[IntentRule] = INTENT_RULES) -> str:
    text = normalize_message(message)
    if not text:
        return "fallback"

    for rule in rules:
        if rule.pattern.search(text):
            return rule.name

    neural_guess = _detect_intent_neural(text)
    if neural_guess:
        return neural_guess
    return "fallback"
