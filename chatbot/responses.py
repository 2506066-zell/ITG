"""Response templates for each chatbot intent."""

from __future__ import annotations

import hashlib
from typing import Mapping


RESPONSE_TEMPLATES = {
    "greeting": [
        "Hai, gue di sini buat bantu kalian tetap on track. Mulai dari target harian dulu, ya?",
        "Halo. Mau cek target harian, rekomendasi tugas, atau evaluasi singkat?",
        "Hi. Kita jaga fokus bareng: satu target utama dulu, lalu eksekusi.",
        "Halo, partner produktif. Hari ini kita cari progres kecil tapi nyata.",
    ],
    "check_daily_target": [
        "Target hari ini: 1 tugas prioritas selesai, 1 sesi fokus 30-45 menit, lalu check-in malam.",
        "Ritme aman hari ini: deadline terdekat dulu, lanjut sesi belajar fokus, kemudian update berdua.",
        "Fokus harian: progress > perfeksionis. Pilih tugas paling berdampak dan tuntaskan.",
        "Target couple: satu hasil nyata sebelum malam, lalu evaluasi 3 menit.",
    ],
    "reminder_ack": [
        "Oke, reminder sudah dicatat. Mulai satu langkah kecil sekarang biar momentum kebentuk.",
        "Siap, pengingat aktif. Fokus 25 menit dulu, habis itu update progres.",
        "Noted. Eksekusi dulu, evaluasi belakangan.",
        "Sip, reminder jalan. Mau lanjut ke rekomendasi tugas berikutnya?",
    ],
    "checkin_progress": [
        "Update cepat: apa yang sudah selesai, lagi dikerjain apa, dan blocker-nya apa?",
        "Ringkas progres: selesai berapa persen, next step apa, butuh bantuan apa?",
        "Biar sinkron, kirim status singkat tugas + level fokus kamu sekarang.",
        "Check-in singkat: 1 kemenangan hari ini dan 1 langkah berikutnya.",
    ],
    "evaluation": [
        "Evaluasi cepat 3 poin: 1) Menang hari ini apa? 2) Hambatan utama apa? 3) Aksi terpenting besok apa?",
        "Review harian: progres vs target, tugas yang ketunda, lalu 1 perbaikan kecil buat besok.",
        "Template evaluasi couple: apa yang berjalan baik, apa yang bikin beban naik, dan komitmen aksi besok.",
        "Refleksi singkat: hasil nyata hari ini, faktor penghambat, dan jam mulai fokus besok.",
    ],
    "affirmation": [
        "Sip, langsung eksekusi 25 menit sekarang. Habis itu kirim update 1 kalimat.",
        "Mantap. Pilih 1 tugas inti dan tuntaskan dulu sebelum buka task lain.",
        "Oke, gas terukur: fokus 30 menit, break 5 menit, lalu check-in progres.",
        "Deal. Mau lanjut ke target, rekomendasi tugas, atau evaluasi?",
    ],
    "recommend_task": [
        "Prioritas sekarang: kerjakan deadline terdekat 30-45 menit, lalu lanjut tugas paling berdampak.",
        "Urutan praktis: deadline terdekat -> tugas bernilai tinggi -> review 10 menit.",
        "Kalau ragu, pilih tugas yang paling mengurangi beban pikiran jika selesai sekarang.",
        "Strategi cepat: satu tugas utama, satu tugas pendukung, lalu check-in ke pasangan.",
    ],
    "study_schedule": [
        "Siap. Aku bisa susun jadwal belajar dari waktu kosong. Sebutkan hari (hari ini/besok), target menit, dan window (pagi/siang/malam).",
        "Bisa banget. Kirim format cepat: 'jadwal belajar besok 150 menit pagi' biar aku susun slot belajar paling realistis.",
        "Aku siap bikin study plan dari jam kosong. Kasih preferensi target menit dan waktu fokus favoritmu dulu.",
        "Oke, kita bikin jadwal belajar yang doable. Tentukan hari + durasi target, nanti aku pecah jadi sesi fokus.",
    ],
    "toxic_motivation": [
        "Stop overthinking. Pilih satu tugas, kerjain 30 menit, beres.",
        "No excuse mode: jangan tunggu mood. Mulai sekarang.",
        "Fokus 25 menit tanpa distraksi. Buktiin ke diri sendiri dulu.",
        "Kerja sunyi, hasil yang berisik.",
    ],
    "fallback": [
        "Butuh bantuan apa sekarang: target, reminder, evaluasi, atau rekomendasi tugas?",
        "Perintah belum kebaca jelas. Coba: 'cek target harian' atau 'rekomendasi tugas kuliah'.",
        "Gue siap bantu produktivitas. Arahkan ke target, progres, reminder, atau evaluasi.",
        "Coba perintah spesifik: 'evaluasi hari ini' atau 'oke lanjut rekomendasi tugas'.",
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
