"""Response templates for each chatbot intent."""

from __future__ import annotations

import hashlib
from typing import Mapping


RESPONSE_TEMPLATES = {
    "greeting": [
        "Hai, aku standby bantu kamu. Mau mulai dari target hari ini atau tugas paling urgent dulu?",
        "Halo. Biar enak, kita beresin satu prioritas dulu terus lanjut step berikutnya.",
        "Hi, siap nemenin kamu fokus. Mau cek target, reminder, atau evaluasi cepat?",
        "Halo, kita bikin progres kecil tapi jadi dulu hari ini.",
    ],
    "check_daily_target": [
        "Target hari ini simpel: selesain 1 tugas prioritas, lanjut 1 sesi fokus, lalu check-in malam.",
        "Ritme aman: deadline terdekat dulu, habis itu lanjut tugas penting berikutnya.",
        "Fokus hari ini: jangan kebanyakan pindah konteks, beresin yang paling berdampak dulu.",
        "Target couple hari ini: ada 1 hasil nyata sebelum malam.",
    ],
    "reminder_ack": [
        "Sip, pengingatnya sudah aktif. Yuk mulai 1 langkah kecil sekarang.",
        "Oke, reminder jalan. Fokus 25 menit dulu, nanti update progres ke aku.",
        "Noted, aku ingetin lagi di timing yang pas.",
        "Siap, reminder beres. Mau aku bantu pilih next task setelah ini?",
    ],
    "checkin_progress": [
        "Check-in cepat ya: yang sudah selesai apa, yang lagi jalan apa, dan kendalanya apa?",
        "Boleh update singkat: progres berapa persen dan next step kamu sekarang?",
        "Kirim status ringkas tugasmu sekarang, biar aku bantu rapihin prioritasnya.",
        "Cukup 2 hal: kemenangan hari ini apa, lalu langkah berikutnya apa.",
    ],
    "evaluation": [
        "Yuk evaluasi 1 menit: apa yang berhasil hari ini, apa yang nghambat, dan apa fokus besok.",
        "Review singkat: target mana yang beres, mana yang ketunda, lalu 1 perbaikan buat besok.",
        "Refleksi couple: hal yang jalan bagus hari ini, dan satu komitmen konkret buat besok.",
        "Biar rapi, sebutin hasil hari ini lalu tentuin jam mulai fokus besok.",
    ],
    "affirmation": [
        "Mantap, lanjut eksekusi sekarang 25 menit. Habis itu update singkat ke aku.",
        "Sip. Ambil 1 tugas inti dulu, jangan buka yang lain sebelum kelar.",
        "Oke, gas terukur: 30 menit fokus, break 5 menit, lanjut lagi.",
        "Deal, kita lanjut. Mau ke target, rekomendasi tugas, atau evaluasi?",
    ],
    "recommend_task": [
        "Prioritas sekarang: kerjain yang deadline-nya paling dekat dulu.",
        "Urutan aman: tugas urgent dulu, lanjut tugas penting, baru sisanya.",
        "Kalau bingung mulai dari mana, pilih tugas yang paling bikin lega kalau selesai hari ini.",
        "Strategi cepat: 1 tugas utama dulu, setelah itu baru pindah ke task lain.",
    ],
    "study_schedule": [
        "Bisa. Kasih aku hari, target menit, dan window waktu (pagi/siang/malam), nanti aku susun jadwal belajarnya.",
        "Siap, kirim aja: 'jadwal belajar besok 150 menit pagi', nanti aku pecah jadi sesi fokus.",
        "Aku bisa bantu isi waktu kosong kamu jadi jadwal belajar yang realistis.",
        "Oke, kita bikin jadwal belajar yang doable biar gak numpuk di akhir.",
    ],
    "toxic_motivation": [
        "Stop overthinking. Pilih satu tugas dan kerjain sekarang.",
        "No excuse mode: jangan nunggu mood, mulai dulu baru semangat nyusul.",
        "Fokus 25 menit tanpa distraksi, buktiin ke diri sendiri.",
        "Kerja sekarang, nikmatin hasilnya nanti.",
    ],
    "fallback": [
        "Mau aku bantu bagian mana dulu: target, reminder, evaluasi, atau rekomendasi tugas?",
        "Aku belum nangkep maksudnya full. Coba tulis lebih spesifik, misalnya: 'cek target harian'.",
        "Aku siap bantu produktivitas kamu. Tinggal arahkan ke target/progres/reminder/evaluasi.",
        "Coba perintah yang lebih jelas, contoh: 'buat jadwal belajar besok 120 menit malam'.",
    ],
}


def _stable_index(seed: str, size: int) -> int:
    # Stable hashing keeps response variation deterministic and stateless.
    digest = hashlib.md5(seed.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % max(size, 1)


def pick_response(intent: str, message: str, context: Mapping[str, str] | None = None) -> str:
    context = dict(context or {})
    templates = RESPONSE_TEMPLATES.get(intent) or RESPONSE_TEMPLATES["fallback"]
    idx = _stable_index(f"{intent}|{message.lower()}", len(templates))
    text = templates[idx]
    try:
        return text.format(**context)
    except Exception:
        return text
