"""Response templates for each chatbot intent."""

from __future__ import annotations

import hashlib
from typing import Mapping


RESPONSE_TEMPLATES = {

    "greeting": [
        "Hai, gue di sini buat bantu kalian tetap on track. Mulai dari target harian dulu, ya?",
        "Halo! Gimana ritme hari ini? Mau cek target atau atur prioritas dulu?",
        "Hi. Kita jaga fokus bareng-bareng. Satu target utama dulu, baru yang lain nyusul.",
        "Halo, partner produktif. Hari ini kita bikin progres kecil tapi nyata.",
        "Hai! Kalau bingung mulai dari mana, kita tentuin 1 tugas paling penting dulu.",
        "Ayo mulai rapi: satu tujuan jelas, satu langkah sekarang.",
        "Selamat datang. Kita bikin hari ini lebih produktif dari kemarin.",
        "Gue siap bantu kalian sinkron. Mau mulai dari target atau progres?",
    ],

    "check_daily_target": [
        "Target hari ini simpel: 1 tugas prioritas selesai, 1 sesi fokus tanpa distraksi, lalu check-in malam.",
        "Ritme aman hari ini: kerjakan deadline terdekat, lanjut 30–45 menit belajar fokus, update progres berdua.",
        "Fokus hari ini: satu hasil nyata dulu. Pilih tugas paling berdampak, tuntaskan, baru lanjut.",
        "Target bareng: progress > perfeksionis. Kerja konsisten, lalu kirim update singkat ke pasangan.",
        "Hari ini kita kejar yang penting dulu: 1 tugas selesai, 1 sesi review, dan check-in sebelum istirahat.",
        "Prioritas hari ini: selesaikan yang mendesak, lanjut yang berdampak, tutup dengan refleksi singkat.",
        "Formula aman: pilih 1 target utama, pecah jadi langkah kecil, eksekusi sekarang.",
        "Target pasangan: progres nyata, bukan sekadar rencana.",
    ],

    "reminder_ack": [
        "Oke, pengingat sudah dicatat. Lanjut satu langkah kecil sekarang biar momentum kebentuk.",
        "Siap, reminder aktif. Kerjain dulu yang paling penting, nanti kita cek lagi.",
        "Noted. Pengingat jalan—fokus 25 menit dulu, habis itu update ya.",
        "Sudah gue tandai. Jalan pelan tapi pasti, yang penting konsisten.",
        "Sip, diingatkan. Mulai dari bagian paling gampang biar cepat bergerak.",
        "Reminder siap. Jangan tunggu mood, mulai sekarang.",
        "Pengingat aktif. Eksekusi dulu, evaluasi belakangan.",
        "Udah dicatat. Satu langkah sekarang lebih berharga dari rencana panjang.",
    ],

    "checkin_progress": [
        "Update cepat: apa yang sudah selesai, lagi dikerjain apa, dan ada hambatan di mana?",
        "Coba ringkas progres: selesai berapa persen, next step apa, butuh bantuan apa?",
        "Biar sinkron: kirim status singkat tugas + level fokus kamu sekarang.",
        "Check-in singkat aja: 1 kemenangan kecil hari ini dan 1 langkah berikutnya.",
        "Gue butuh snapshot progres: done, doing, dan blocker.",
        "Progres report: apa yang maju hari ini dan apa yang menahan?",
        "Update jujur: kerja nyata atau masih persiapan?",
        "Sinkronisasi cepat: status tugas, estimasi selesai, dan kebutuhan dukungan.",
    ],

    "recommend_task": [
        "Prioritas sekarang: selesaikan yang bisa tuntas hari ini, lalu lanjut yang paling berdampak ke nilai.",
        "Langkah aman: kerjain deadline terdekat 30–45 menit, review singkat, lalu update pasangan.",
        "Mulai dari yang paling jelas hasilnya. Tuntaskan satu bagian, baru naik level.",
        "Pecah tugas besar jadi 2–3 bagian. Ambil bagian pertama sekarang.",
        "Kalau ragu, pilih tugas yang bikin lega kalau selesai.",
        "Urutan praktis: deadline terdekat → tugas berdampak → review singkat.",
        "Strategi cepat: satu tugas utama, satu tugas pendukung, selesai.",
        "Kerjakan yang paling mengurangi beban pikiran dulu.",
    ],

    "toxic_motivation": [
        "Stop mikir kebanyakan. Pilih satu tugas, kerjain 30 menit, beres.",
        "Nggak perlu mood bagus buat mulai. Mulai dulu, mood nyusul.",
        "Alasan bisa nunggu. Progress nggak.",
        "Fokus 25 menit tanpa distraksi. Buktiin ke diri sendiri dulu.",
        "Kecil tapi jadi. Jalan sekarang, bukan nanti.",
        "Disiplin itu pilihan. Pilih yang benar hari ini.",
        "Kerja sunyi, hasil yang berisik.",
        "Kalau gampang ditunda, berarti itu yang harus dikerjain sekarang.",
        "Satu langkah nyata > seribu rencana.",
        "Konsisten itu membosankan—dan itu yang bikin berhasil.",
    ],

    "fallback": [
        "Biar tepat, kamu bisa bilang: 'cek target harian', 'rekomendasi tugas', atau 'check-in progres'.",
        "Aku belum nangkep maksudnya. Mau cek target, set reminder, atau update progres?",
        "Coba perintah yang lebih spesifik ya—misalnya minta target hari ini atau rekomendasi tugas.",
        "Kita fokus ke progres. Sebutkan kebutuhanmu: target, reminder, atau check-in.",
        "Kalau bingung, mulai dari 'cek target harian pasangan'.",
        "Perintah belum jelas. Pilih: target, progres, atau rekomendasi.",
        "Gue siap bantu produktivitas. Arahkan permintaanmu dengan jelas.",
        "Butuh bantuan apa sekarang—target, reminder, atau evaluasi?",
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

