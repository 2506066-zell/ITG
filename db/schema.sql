-- Copy semua kode di bawah ini dan jalankan di Neon Dashboard (SQL Editor)

-- 1. Tabel Tasks (dengan versioning untuk konkurensi)
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  version INTEGER DEFAULT 0
);

-- Pastikan kolom version ada
DO $$ 
BEGIN 
  BEGIN
    ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 0;
  EXCEPTION
    WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in tasks';
  END;
END $$;

-- 2. Tabel Memories
CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  media_type TEXT,
  media_data TEXT,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  version INTEGER DEFAULT 0
);

DO $$ 
BEGIN 
  BEGIN
    ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 0;
  EXCEPTION
    WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in memories';
  END;
END $$;

-- 3. Tabel Assignments
CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  deadline TIMESTAMP,
  completed BOOLEAN DEFAULT FALSE
);

-- 4. Tabel Goals (Baru)
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  deadline TIMESTAMP,
  progress INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  version INTEGER DEFAULT 0
);

DO $$ 
BEGIN 
  BEGIN
    ALTER TABLE goals ADD COLUMN version INTEGER DEFAULT 0;
  EXCEPTION
    WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in goals';
  END;
END $$;

-- 5. Tabel Anniversary
CREATE TABLE IF NOT EXISTS anniversary (
  id INTEGER PRIMARY KEY,
  date TIMESTAMP,
  note TEXT
);

-- Inisialisasi data Anniversary
INSERT INTO anniversary (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
