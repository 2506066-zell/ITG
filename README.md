# CuteFutura PWA

Personal organizer with simple password login, JWT auth, Neon PostgreSQL, and Vercel serverless backend.

## Tech Stack

- Frontend: HTML5, CSS3, Vanilla JS, PWA (manifest + service worker)
- Backend: Vercel Serverless Functions (Node.js, pg, jsonwebtoken, bcryptjs)
- DB: Neon PostgreSQL

## File Structure

```
cute-futura/
├── public/
│   ├── login.html
│   ├── index.html
│   ├── memories.html
│   ├── anniversary.html
│   ├── daily-tasks.html
│   ├── college-assignments.html
│   ├── chat.html
│   ├── settings.html
│   ├── manifest.json
│   ├── sw.js
│   └── icons/ (192.png, 512.png – placeholders)
├── src/
│   ├── css/
│   │   ├── style.css
│   │   └── themes.css
│   └── js/
│       ├── main.js
│       ├── api.js
│       ├── login.js
│       ├── memories.js
│       ├── anniversary.js
│       ├── tasks.js
│       ├── assignments.js
│       ├── chat.js
│       └── settings.js
├── api/
│   ├── login.js
│   ├── memories.js
│   ├── tasks.js
│   ├── assignments.js
│   └── anniversary.js
├── db/schema.sql
├── vercel.json
├── package.json
└── README.md
```

## Database Schema

```
CREATE TABLE memories (id SERIAL PRIMARY KEY, title TEXT, media_type TEXT, media_data TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT, completed BOOLEAN DEFAULT FALSE);
CREATE TABLE assignments (id SERIAL PRIMARY KEY, title TEXT, deadline DATE, completed BOOLEAN DEFAULT FALSE);
CREATE TABLE anniversary (id INTEGER PRIMARY KEY DEFAULT 1, date DATE, note TEXT);
```

## Auth Flow

- login.html posts password to `/api/login` and stores the returned JWT in `localStorage.token`.
- Protected pages load `main.js`, which checks `localStorage.token`. API wrapper sends `Authorization: Bearer <token>`. On 401, it redirects to login.
- Logout clears the token and redirects to login.

## Deployment

### Environment Variables

- `DATABASE_URL` – Neon connection string
- `APP_PASSWORD_HASH` – bcrypt hash of your chosen password
- `JWT_SECRET` – random string

### Manual Setup

1. Create a Neon PostgreSQL database and copy the connection URL.
2. Generate a password hash:
   ```
   node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"
   ```
3. In Vercel project settings, add environment variables:
   - `DATABASE_URL`
   - `APP_PASSWORD_HASH`
   - `JWT_SECRET`
4. Run the schema on Neon:
   ```
   psql "<DATABASE_URL>" -f db/schema.sql
   ```
   Or paste the SQL into Neon’s SQL editor.
5. Deploy:
   ```
   vercel --prod
   ```
6. Replace icon placeholders with real PNGs in `public/icons/`.

## Notes

- All endpoints require `Authorization: Bearer <token>`.
- JWT expires in 7 days.
- Chat is stored only in localStorage.
