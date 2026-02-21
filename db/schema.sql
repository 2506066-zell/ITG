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

-- 11b. User Activity Events (analytics trail for Z AI)
CREATE TABLE IF NOT EXISTS user_activity_events (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(60) NOT NULL,
  session_id VARCHAR(80),
  event_name VARCHAR(80) NOT NULL,
  page_path VARCHAR(200),
  entity_type VARCHAR(80),
  entity_id VARCHAR(80),
  source VARCHAR(40) NOT NULL DEFAULT 'web',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_ts TIMESTAMPTZ,
  server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Chatbot Adaptive Profile (cross-device memory profile)
CREATE TABLE IF NOT EXISTS chatbot_profiles (
  user_id VARCHAR(60) PRIMARY KEY,
  tone_mode VARCHAR(20) NOT NULL DEFAULT 'supportive',
  focus_minutes INTEGER NOT NULL DEFAULT 25,
  focus_window VARCHAR(20) NOT NULL DEFAULT 'any',
  recent_intents JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. Z AI Unified Memory State
CREATE TABLE IF NOT EXISTS z_ai_user_memory (
  user_id VARCHAR(60) PRIMARY KEY,
  last_intent VARCHAR(80),
  focus_topic VARCHAR(80),
  memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Z AI Memory Events (planner/execution traces)
CREATE TABLE IF NOT EXISTS z_ai_memory_events (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(60) NOT NULL,
  message TEXT NOT NULL,
  intent VARCHAR(80),
  reply TEXT,
  planner JSONB NOT NULL DEFAULT '{}'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15. Z AI Feedback Events (learning loop)
CREATE TABLE IF NOT EXISTS z_ai_feedback_events (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(60) NOT NULL,
  response_id VARCHAR(80),
  intent VARCHAR(80),
  helpful BOOLEAN NOT NULL,
  suggestion_command TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15b. Z AI Router Events (engine selection telemetry)
CREATE TABLE IF NOT EXISTS z_ai_router_events (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(60),
  response_id VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'ok',
  router_mode VARCHAR(20),
  selected_engine VARCHAR(40),
  engine_final VARCHAR(40),
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  complexity_score INTEGER,
  complexity_level VARCHAR(20),
  latency_ms INTEGER,
  intent VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 15c. Z AI Reminders (set reminder action queue)
CREATE TABLE IF NOT EXISTS z_ai_reminders (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(60) NOT NULL,
  target_user VARCHAR(60),
  reminder_text TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  source_command TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

-- 16. Class Notes (lecture notes bound to schedule sessions)
CREATE TABLE IF NOT EXISTS class_notes (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(60) NOT NULL,
  schedule_id INTEGER NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  class_date DATE NOT NULL,
  day_id INTEGER,
  subject VARCHAR(140) NOT NULL,
  room VARCHAR(80),
  lecturer VARCHAR(140),
  time_start TIME,
  time_end TIME,
  key_points TEXT DEFAULT '',
  action_items TEXT DEFAULT '',
  questions TEXT DEFAULT '',
  free_text TEXT DEFAULT '',
  meeting_no SMALLINT,
  mood_focus INTEGER,
  confidence VARCHAR(10),
  summary_text TEXT DEFAULT '',
  next_action_text TEXT DEFAULT '',
  risk_hint TEXT DEFAULT '',
  is_minimum_completed BOOLEAN DEFAULT FALSE,
  archive_status VARCHAR(20) NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  quality_score SMALLINT DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  deleted_by VARCHAR(60),
  purge_after TIMESTAMPTZ,
  updated_by VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, schedule_id, class_date)
);

-- Backward-compatible migration for existing class_notes table
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS archive_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS quality_score SMALLINT DEFAULT 0;
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(60);
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS updated_by VARCHAR(60);
ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS meeting_no SMALLINT;

-- 17. Class Note Revisions (version snapshot on every save)
CREATE TABLE IF NOT EXISTS class_note_revisions (
  id BIGSERIAL PRIMARY KEY,
  note_id BIGINT NOT NULL REFERENCES class_notes(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  user_id VARCHAR(60) NOT NULL,
  key_points TEXT DEFAULT '',
  action_items TEXT DEFAULT '',
  questions TEXT DEFAULT '',
  free_text TEXT DEFAULT '',
  meeting_no SMALLINT,
  mood_focus INTEGER,
  confidence VARCHAR(10),
  summary_text TEXT DEFAULT '',
  next_action_text TEXT DEFAULT '',
  risk_hint TEXT DEFAULT '',
  change_reason VARCHAR(40) DEFAULT 'save',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (note_id, version_no)
);
ALTER TABLE class_note_revisions ADD COLUMN IF NOT EXISTS meeting_no SMALLINT;

-- 18. Academic Semester Preferences (per user)
CREATE TABLE IF NOT EXISTS academic_semester_preferences (
  user_id VARCHAR(60) PRIMARY KEY,
  academic_year_start_month SMALLINT NOT NULL DEFAULT 8,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at) WHERE completed = TRUE;
CREATE INDEX IF NOT EXISTS idx_monthly_todos_user_month ON monthly_todos(user_id, month);
CREATE INDEX IF NOT EXISTS idx_monthly_logs_todo ON monthly_todo_logs(monthly_todo_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_user ON evaluations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_user_time ON user_activity_events(user_id, server_ts DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_event_name ON user_activity_events(event_name);
CREATE INDEX IF NOT EXISTS idx_chatbot_profiles_updated_at ON chatbot_profiles(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_user_memory_updated_at ON z_ai_user_memory(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_memory_events_user_time ON z_ai_memory_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_feedback_events_user_time ON z_ai_feedback_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_router_events_user_time ON z_ai_router_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_router_events_time ON z_ai_router_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_router_events_engine ON z_ai_router_events(engine_final, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zai_reminders_due ON z_ai_reminders(status, remind_at ASC);
CREATE INDEX IF NOT EXISTS idx_zai_reminders_user ON z_ai_reminders(target_user, status, remind_at ASC);
CREATE INDEX IF NOT EXISTS idx_class_notes_user_date ON class_notes(user_id, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_notes_schedule_date ON class_notes(schedule_id, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_notes_subject_date ON class_notes(subject, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_notes_status_date ON class_notes(user_id, archive_status, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_notes_partner_read ON class_notes(archive_status, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_notes_subject_status ON class_notes(subject, archive_status, class_date DESC);
CREATE INDEX IF NOT EXISTS idx_class_note_revisions_note_time ON class_note_revisions(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_academic_semester_preferences_updated_at ON academic_semester_preferences(updated_at DESC);
