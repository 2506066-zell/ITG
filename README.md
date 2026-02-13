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
