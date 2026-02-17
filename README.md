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
  - Output: `{ "reply": "jawaban bot", "intent": "nama_intent", "response_id": "uuid", "engine": "rule-engine-v1|python-v1|llm-v1", "router": { "mode": "hybrid", ... }, "adaptive": { ... }, "planner": { ... }, "reliability": { "status": "safe|needs_clarification|ambiguous", "score": 0-100 }, "unified_memory": { ... }, "memory_update": { ... }, "feedback_profile": { ... }, "suggestions": [{ "label": "...", "command": "...", "tone": "info" }] }`
  - Feedback loop (learning):
    - `POST /api/chat` dengan body `{ "mode": "bot", "stateless": true, "feedback": { "response_id": "<uuid>", "helpful": true|false, "intent": "..." } }`
    - Z AI akan menyimpan feedback dan menyesuaikan rekomendasi per user.
  - Action Engine reminder:
    - Perintah `ingatkan/reminder/alarm/notifikasi` bisa auto `set_reminder` saat waktu jelas.
    - Jika waktu belum jelas, Z AI akan minta 1 klarifikasi waktu.
- Endpoint profile adaptif lintas device (auth wajib):
  - `GET /api/chatbot_profile`
  - `PUT /api/chatbot_profile`
  - Payload profile:
    - `{ "tone_mode": "supportive|strict|balanced", "focus_minutes": 25, "focus_window": "any|morning|afternoon|evening", "recent_intents": ["evaluation", "recommend_task"] }`
- Endpoint Python langsung: `POST /api/chatbot` (rewritten ke `api/chat.py`)
  - Output Python: `{ "reply": "...", "intent": "...", "adaptive": { ... }, "planner": { ... }, "memory_update": { ... }, "suggestions": [...] }`
- Legacy mode tetap aman:
  - `GET /api/chat`, `DELETE /api/chat`, dan `POST /api/chat` dengan token tetap memakai chat storage lama.

### Hybrid Brain Router (Tahap 1)
- Router engine di `POST /api/chat` (mode stateless):
  - `rule-engine-v1` untuk pesan sederhana (latency rendah)
  - `python-v1` untuk pesan kompleks (planner + adaptive)
  - opsional `llm-v1` via endpoint `POST /api/chatbot-llm`
- Environment variables:
  - `CHATBOT_ENGINE_MODE=hybrid|rule|python|llm` (default `hybrid`)
  - `CHATBOT_COMPLEXITY_THRESHOLD=20..95` (default `56`)
  - `CHATBOT_LLM_ENABLED=true|false` (opsional)
  - `CHATBOT_ACTION_ENGINE_V2=true|false` (default `true`, auto create task/assignment dari chat stateless)
  - `CHATBOT_LLM_URL=https://...` (opsional)
  - `CHATBOT_LLM_USE_LOCAL_PATH=true` untuk mencoba `https://<host>/api/chatbot-llm` saat `CHATBOT_LLM_URL` kosong (opsional)
  - `CHATBOT_LLM_TIMEOUT_MS=1700` (opsional)
  - `CHATBOT_LLM_SHARED_SECRET=...` (opsional)
  - `CHATBOT_LLM_API_KEY=...` (wajib jika pakai endpoint internal `api/chatbot-llm`)
  - `CHATBOT_LLM_MODEL=gpt-4o-mini` (opsional)
  - `CHATBOT_LLM_API_URL=https://api.openai.com/v1/chat/completions` (opsional, OpenAI-compatible)
  - `CHATBOT_LLM_AUTH_HEADER=Authorization` dan `CHATBOT_LLM_AUTH_PREFIX=Bearer ` (opsional)
  - `CHATBOT_LLM_FORCE_JSON=true|false` (default `true`, disarankan `true` agar output stabil)
  - `CHATBOT_LLM_TEMPERATURE=0.28` (default `0.28`, naikkan jika ingin gaya lebih kreatif)
- Monitoring endpoint (auth wajib):
  - `GET /api/chat_metrics?days=7`
  - `GET /api/chat_metrics?days=7&scope=global` (admin `Zaldy`)
  - Output: `fallback_rate_pct`, `avg_latency_ms`, `p95_latency_ms`, breakdown engine/intent, trend 24 jam.
- Routing regression test (lokal/CI):
  - `npm run test:router`
  - Opsional env:
    - `CHATBOT_TEST_BASE_URL=https://itg-ten.vercel.app`
    - `CHATBOT_TEST_STRICT_HYBRID=true|false`

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

## User Activity Tracking (Z AI)
- Endpoint: `POST /api/activity` (auth wajib)
  - Single event:
    - `{ "event_name": "zai_prompt", "page_path": "/chat.html", "payload": { "mode": "bot_stateless" } }`
  - Batch event:
    - `{ "events": [ { ... }, { ... } ] }`
- Endpoint: `GET /api/activity` (auth wajib)
  - Query opsional:
    - `limit=80`
    - `event_name=zai_reply`
    - `page_path=/chat.html`
- Legacy compatibility:
  - `GET /api/activity?entity_type=task&entity_id=12` tetap baca `activity_logs` lama.
- Frontend tracker:
  - `js/activity-tracker.js` otomatis track:
    - `page_view`, `nav_open`, `ui_click`, `api_write`
    - event khusus chat: `zai_prompt`, `zai_reply`, `zai_feedback_saved`, dll
  - Queue lokal akan di-flush periodik ke `/api/activity` saat user login.

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
