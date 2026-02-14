-- =============================================
-- NZ / CuteFutura — Complete Database Schema
-- Run in Neon SQL Editor or via psql
-- =============================================

-- 1. Tasks (with scoring, assignment, soft-delete, optimistic locking)
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  version INTEGER DEFAULT 0,
  priority VARCHAR(10) DEFAULT 'medium',
  deadline TIMESTAMP,
  goal_id INTEGER,
  assigned_to VARCHAR(50),
  created_by VARCHAR(50),
  updated_by VARCHAR(50),
  completed_by VARCHAR(50),
  completed_at TIMESTAMP,
  score_awarded INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_by VARCHAR(50),
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Memories
CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  media_type TEXT,
  media_data TEXT,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  version INTEGER DEFAULT 0
);

-- 3. Assignments
CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  deadline TIMESTAMP,
  completed BOOLEAN DEFAULT FALSE,
  completed_by VARCHAR(50),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Goals (with soft-delete, optimistic locking)
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'Personal',
  deadline TIMESTAMP,
  progress INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  version INTEGER DEFAULT 0,
  created_by VARCHAR(50),
  updated_by VARCHAR(50),
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_by VARCHAR(50),
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Anniversary (single row)
CREATE TABLE IF NOT EXISTS anniversary (
  id INTEGER PRIMARY KEY,
  date TIMESTAMP,
  note TEXT
);
INSERT INTO anniversary (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 6. Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 7. Class Schedule
CREATE TABLE IF NOT EXISTS schedule (
  id SERIAL PRIMARY KEY,
  day_id INTEGER NOT NULL,        -- 1=Monday, 7=Sunday
  subject VARCHAR(100) NOT NULL,
  room VARCHAR(50),
  time_start TIME NOT NULL,
  time_end TIME NOT NULL,
  lecturer VARCHAR(100),
  created_by VARCHAR(50)
);

-- 8. Monthly Todos
CREATE TABLE IF NOT EXISTS monthly_todos (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  month VARCHAR(7) NOT NULL,      -- YYYY-MM
  title TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 9. Monthly Todo Logs (daily tracking)
CREATE TABLE IF NOT EXISTS monthly_todo_logs (
  id SERIAL PRIMARY KEY,
  monthly_todo_id INTEGER NOT NULL REFERENCES monthly_todos(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  UNIQUE(monthly_todo_id, date)
);

-- 10. Evaluations (mood tracking)
CREATE TABLE IF NOT EXISTS evaluations (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  date DATE,
  mood INTEGER CHECK (mood BETWEEN 1 AND 5),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 11. Activity Logs (audit trail)
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER,
  action_type VARCHAR(20) NOT NULL,
  user_id VARCHAR(50),
  changes JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at) WHERE completed = TRUE;
CREATE INDEX IF NOT EXISTS idx_monthly_todos_user_month ON monthly_todos(user_id, month);
CREATE INDEX IF NOT EXISTS idx_monthly_logs_todo ON monthly_todo_logs(monthly_todo_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_user ON evaluations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
