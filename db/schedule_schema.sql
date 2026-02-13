CREATE TABLE IF NOT EXISTS schedule (
  id SERIAL PRIMARY KEY,
  day_id INTEGER NOT NULL, -- 1=Monday, 7=Sunday
  subject VARCHAR(100) NOT NULL,
  room VARCHAR(50),
  time_start TIME NOT NULL,
  time_end TIME NOT NULL,
  lecturer VARCHAR(100),
  created_by VARCHAR(50)
);
