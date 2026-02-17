# CuteFutura PWA

Organizer pribadi dengan login sederhana (bcrypt + JWT), backend Node serverless di Vercel, dan Neon PostgreSQL.

## Tech Stack
- Frontend: HTML, CSS, Vanilla JS, PWA (manifest + service worker)
- Backend: Vercel Functions (Node.js, pg, jsonwebtoken, bcryptjs)
- DB: Neon PostgreSQL

## Struktur Proyek Aktual
```
.
├── api/                 # Serverless functions
├── css/                 # Stylesheets (disalin ke public/css saat build)
├── js/                  # Frontend scripts (disalin ke public/js saat build)
├── icons/               # Icons
├── public/              # Folder hasil build untuk static (dibuat otomatis)
├── scripts/             # Tools lokal & CI (build, audit, server)
├── db/                  # Schema SQL
├── *.html               # Halaman HTML di root (disalin ke public/ saat build)
├── package.json
├── vercel.json
└── README.md
```

## Pengembangan Lokal
- Prasyarat: Node 20.x (disarankan), Windows gunakan `npm.cmd`
- Pasang dependencies:
  - `npm.cmd install`
- Jalankan server dev (menyalin aset ke `public` lalu serve + API):
  - `npm.cmd run dev`
  - Buka `http://localhost:3000/login.html`
- Uji login:
  - Username: `Zaldy` atau `Nesya`
  - Password: sesuai `APP_PASSWORD_HASH` (contoh lokal: `123456`)
- Mode static (tanpa API, fallback Mock aktif):
  - `npm.cmd run build && npm.cmd start`

## Auth Flow (Ringkas)
- `login.html` POST ke `/api/login`, menyimpan JWT di `localStorage.token`
- `js/api.js` menambahkan header `Authorization: Bearer <token>` dan fallback ke Mock jika backend tidak tersedia
- Logout menghapus token dan redirect ke login

## Assistant API (Phase 1)
- Endpoint: `POST /api/assistant` (auth wajib)
- Streaming endpoint (SSE): `POST /api/assistant/stream` (auth wajib)
- Read intent (langsung eksekusi):
  - body: `{ "message": "jadwal besok" }`
- Write intent (wajib konfirmasi):
  1. Kirim intent:
     - `{ "message": "buat task belajar basis data deadline besok 19:00 priority high" }`
     - respons: `mode=confirmation_required` + `confirmation_token`
  2. Konfirmasi eksekusi:
     - `{ "confirm": true, "confirmation_token": "<token>" }`
     - respons: `mode=write_executed`
- Tools read: tasks, schedule, goals, assignments, report, daily brief
- Tools write: create task, complete task
- Chat command shortcut:
  - `/ai <prompt>` untuk query assistant (streaming response)
  - `/confirm` untuk menjalankan write action yang menunggu konfirmasi

## Python Brain (Phase 1 Hybrid)
- Endpoint Python internal: `POST /api/assistant-brain`
- Alur hybrid:
  - Frontend tetap ke `POST /api/assistant` / `POST /api/assistant/stream`
  - `api/assistant.js` akan memanggil Python brain untuk intent + klarifikasi natural
  - Jika Python gagal/timeout, otomatis fallback ke engine JS lama (non-breaking)
- Environment variables tambahan:
  - `ASSISTANT_ENGINE=python` untuk mengaktifkan hybrid mode
  - `ASSISTANT_BRAIN_URL` opsional (default auto ke `/api/assistant-brain` pada host aktif)
  - `ASSISTANT_BRAIN_TIMEOUT_MS` opsional (default 1100 ms)
  - `ASSISTANT_BRAIN_SHARED_SECRET` disarankan (Node kirim header `X-Brain-Secret` ke Python)

## Chatbot Python Stateless (Mobile Couple Productivity)
- Endpoint utama: `POST /api/chat`
  - Mode chatbot stateless aktif saat request tanpa `Authorization` Bearer token.
  - Input: `{ "message": "text user", "context": { "tone_mode": "supportive|strict|balanced", "focus_minutes": 25, "focus_window": "any|morning|afternoon|evening", "recent_intents": [] } }`
  - Output: `{ "reply": "jawaban bot", "intent": "nama_intent", "adaptive": { ... }, "suggestions": [{ "label": "...", "command": "...", "tone": "info" }] }`
- Endpoint Python langsung: `POST /api/chatbot` (rewritten ke `api/chat.py`)
- Legacy mode tetap aman:
  - `GET /api/chat`, `DELETE /api/chat`, dan `POST /api/chat` dengan token tetap memakai chat storage lama.

### Struktur File Chatbot
```
project/
  api/
    chat.py
  chatbot/
    intents.py
    responses.py
    processor.py
  requirements.txt
  vercel.json
```

### Intent yang didukung
- Greeting detection (`halo`, `hai`, `hi`, dst.)
- Check target harian pasangan
- Reminder acknowledgment
- Fallback response
- Tambahan: check-in progres, rekomendasi tugas, dan mode motivasi tegas

### Contoh Request & Response
Request:
```bash
curl -X POST https://<domain>/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"halo, cek target harian kita\"}"
```

Response:
```json
{
  "reply": "Target harian pasangan: 1 tugas kuliah prioritas tinggi, 1 sesi belajar fokus 45 menit, lalu check-in malam."
}
```

### Deploy singkat
1. Pastikan `vercel.json` memuat build Python:
   - `{ "src": "api/chat.py", "use": "@vercel/python" }`
2. Deploy:
   - `vercel --prod`
3. Uji endpoint:
   - `POST /api/chat` tanpa token untuk mode bot
   - `POST /api/chat` dengan token untuk simpan chat legacy

## Koneksi Neon di Vercel (Langkah demi langkah)
1. Buat project database di Neon.
2. Buat user/password dan dapatkan Connection String:
   - Format: `postgresql://<user>:<password>@<host>/<database>?sslmode=require`
3. Jalankan schema (opsional via Neon SQL editor atau psql):
   ```
50→   psql "<ZN_DATABASE_URL>" -f db/schema.sql
   ```
4. Di Vercel Project Settings → Environment Variables, tambahkan:
53→   - `ZN_DATABASE_URL` → connection string Neon (dengan `sslmode=require`)
   - `APP_PASSWORD_HASH` → hash bcrypt password Anda
     - Buat hash: `node scripts/generate-hash.js yourpassword`
   - `JWT_SECRET` → string acak/kuat
5. Deploy:
   - `vercel --prod` atau gunakan tombol Deploy di dashboard Vercel
6. Verifikasi health:
   - GET `https://<your-vercel-domain>/api/health` harus status `ok` jika DB dan env benar

## Catatan
- Endpoint API membutuhkan `Authorization: Bearer <token>`
- Di lokal tanpa DB, beberapa fitur yang butuh DB akan fallback ke Mock (UI tetap berfungsi)
