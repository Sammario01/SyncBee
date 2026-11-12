// db/database.js
const Database = require('better-sqlite3');
const path = require('path');

// Creates syncbee.db in the /db folder if it doesn't exist yet
const db = new Database(require('../server/paths').dbFile);

// Recommended for desktop apps: safer + faster writes
db.pragma('journal_mode = WAL');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS examinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      exam_title TEXT NOT NULL,
      exam_code TEXT,
      description TEXT,
      subject_id INTEGER NOT NULL,
      class_id INTEGER,
      program_id INTEGER,
      is_global INTEGER DEFAULT 0,
      session_id INTEGER,
      term_id INTEGER,
      total_marks INTEGER NOT NULL,
      passing_marks INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT DEFAULT 'Scheduled'
        CHECK (status IN ('Scheduled','Ongoing','Closed','Cancelled')),
      max_attempts INTEGER DEFAULT 1,
      anti_cheat_enabled INTEGER,
      questions_to_attempt INTEGER,
      retake_policy TEXT DEFAULT 'Not Allowed'
        CHECK (retake_policy IN ('Not Allowed','Manual','Auto')),
      shuffle_questions INTEGER DEFAULT 0,
      shuffle_options INTEGER DEFAULT 0,
      require_camera INTEGER DEFAULT 0,
      ip_restriction TEXT,
      auto_grade INTEGER DEFAULT 1,
      show_result TEXT DEFAULT 'After Publish'
        CHECK (show_result IN ('Immediately','After Publish','Never')),
      published INTEGER DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      theory_duration INTEGER,
      theory_total_score INTEGER,
      has_theory INTEGER DEFAULT 0,
      theory_allowed_to_answer INTEGER DEFAULT 0,
      theory_format TEXT,
      last_synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS branding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      school_display_name TEXT,
      logo_data_uri TEXT,
      color_primary TEXT,
      color_accent TEXT,
      color_success TEXT,
      updated_at TEXT
    );

           CREATE TABLE IF NOT EXISTS exam_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_code TEXT,
      bundle_code TEXT,
      locked INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

        CREATE TABLE IF NOT EXISTS exam_broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_code TEXT,
      bundle_code TEXT,
      school_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('message', 'force_submit')),
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

        CREATE TABLE IF NOT EXISTS help_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      exam_code TEXT,
      bundle_code TEXT,
      school_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_broadcasts_exam_code ON exam_broadcasts(exam_code);
    CREATE INDEX IF NOT EXISTS idx_help_requests_exam_code ON help_requests(exam_code);
    

        CREATE TABLE IF NOT EXISTS exam_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
            anti_cheat_enabled INTEGER DEFAULT 0,
      bundle_code TEXT NOT NULL UNIQUE,
      bundle_title TEXT NOT NULL,
      description TEXT,
      class_id INTEGER,
      program_id INTEGER,
      is_global INTEGER DEFAULT 0,
      published INTEGER DEFAULT 0,
      navigation_mode TEXT NOT NULL DEFAULT 'strict_sequential'
        CHECK (navigation_mode IN ('strict_sequential', 'sequential_unlock', 'free')),
      total_duration_minutes INTEGER DEFAULT 0,
      show_result TEXT DEFAULT 'After Publish' CHECK (show_result IN ('Immediately','After Publish','Never')),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

        CREATE TABLE IF NOT EXISTS answer_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_attempt_id ON answer_audit_log(attempt_id);
    
    CREATE TABLE IF NOT EXISTS exam_bundle_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_code TEXT NOT NULL,
      exam_code TEXT NOT NULL,
      item_order INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS student_bundle_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      bundle_attempt_id TEXT NOT NULL UNIQUE,
      bundle_code TEXT NOT NULL,
      student_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'In Progress' CHECK (status IN ('In Progress','Submitted')),
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      current_item_order INTEGER DEFAULT 1,
      remaining_seconds INTEGER,
            submission_reason TEXT DEFAULT 'student_manual' CHECK (submission_reason IN ('student_manual','timeout','anti_cheat','admin_force_submit')),
      is_synced INTEGER DEFAULT 0

    );

    CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle_code ON exam_bundle_items(bundle_code);
    CREATE INDEX IF NOT EXISTS idx_bundle_attempts_student ON student_bundle_attempts(student_id, bundle_code);

    
      CREATE TABLE IF NOT EXISTS exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id TEXT NOT NULL UNIQUE,
      school_id TEXT NOT NULL,
      exam_code TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'MCQ_SINGLE'
        CHECK (question_type IN ('MCQ_SINGLE','TRUE_FALSE','MCQ_MULTIPLE','SHORT_ANSWER','LONG_ANSWER','THEORY')),
      question_text TEXT NOT NULL,
      marks REAL NOT NULL DEFAULT 1.00,
      correct_answer TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      explanation TEXT,
      difficulty_level TEXT CHECK (difficulty_level IN ('easy','medium','hard')),
      negative_marks REAL,
      passage_id TEXT,
      answer_mode TEXT CHECK (answer_mode IN ('screen_to_screen','screen_to_paper')),
      model_answer TEXT,
      student_instructions TEXT,
      max_words INTEGER,
      time_limit_minutes INTEGER,
      image_url TEXT,
      image_width_pct INTEGER DEFAULT 60 CHECK (image_width_pct IS NULL OR (image_width_pct BETWEEN 10 AND 100)),
      image_align TEXT CHECK (image_align IS NULL OR image_align IN ('left','center','right'))
    );
    CREATE TABLE IF NOT EXISTS subjects (
      subject_id INTEGER PRIMARY KEY,
      subject_code TEXT,
      subject_type TEXT,
      school_id TEXT NOT NULL,
      branch_id TEXT,
      subject_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY,
      school_id TEXT NOT NULL,
      program_name TEXT NOT NULL,
      program_code TEXT,
      branch_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subjects_school_id ON subjects(school_id);
    CREATE INDEX IF NOT EXISTS idx_programs_school_id ON programs(school_id);

 CREATE TABLE IF NOT EXISTS exam_question_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      option_id TEXT NOT NULL UNIQUE,
      question_id TEXT NOT NULL,
      option_text TEXT NOT NULL,
      is_correct INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      image_url TEXT,
      image_width_pct INTEGER DEFAULT 60 CHECK (image_width_pct IS NULL OR (image_width_pct BETWEEN 10 AND 100)),
      image_align TEXT CHECK (image_align IS NULL OR image_align IN ('left','center','right'))
    );

        CREATE TABLE IF NOT EXISTS branches (
      branch_id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      branch_type TEXT NOT NULL CHECK (branch_type IN ('Primary','Secondary','Both')),
      address TEXT,
      phone_number TEXT,
      email TEXT,
      principal_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      gate_latitude REAL,
      gate_longitude REAL,
      gate_radius_meters INTEGER
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      branch_id TEXT,
      class_teacher_id TEXT NOT NULL,
      name TEXT NOT NULL,
      compartment TEXT NOT NULL,
      class_type TEXT NOT NULL,
      department_id TEXT,
      create_date TEXT
    );

        CREATE TABLE IF NOT EXISTS candidate_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_ip TEXT,
      user_agent TEXT,
      last_student_id TEXT,
      first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (school_id, device_id)
    );

   

    CREATE TABLE IF NOT EXISTS active_sessions (
  sid TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  student_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

    CREATE TABLE IF NOT EXISTS exam_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      bundle_attempt_id TEXT,
      student_id TEXT NOT NULL,
      school_id TEXT NOT NULL,
      event_uid TEXT NOT NULL,
      event_type TEXT NOT NULL,
      question_id TEXT,
      data TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (attempt_id, event_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_exam_events_attempt ON exam_events(attempt_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_exam_events_bundle ON exam_events(bundle_attempt_id);

        CREATE TABLE IF NOT EXISTS theory_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      exam_code TEXT NOT NULL,
      student_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      attempt_id TEXT,
      answer_text TEXT,
      word_count INTEGER,
      answer_file TEXT,
      score REAL,
      max_score REAL,
      marker_id TEXT,
      marker_comment TEXT,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','marked')),
      submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      marked_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_theory_answers_exam_code ON theory_answers(exam_code);
    CREATE INDEX IF NOT EXISTS idx_theory_answers_student_id ON theory_answers(student_id);
    CREATE INDEX IF NOT EXISTS idx_theory_answers_question_id ON theory_answers(question_id);
    CREATE INDEX IF NOT EXISTS idx_theory_answers_status ON theory_answers(status);

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      term_id INTEGER,
            student_id TEXT NOT NULL UNIQUE,
      registration_number TEXT,
      school_id TEXT NOT NULL,
      branch_id TEXT,
      class_id INTEGER,
      program_id INTEGER,
      enrollment_start TEXT,
      firstname TEXT NOT NULL,
      middlename TEXT NOT NULL,
      lastname TEXT NOT NULL,
      email TEXT NOT NULL,
      date_of_birth TEXT,
      gender TEXT NOT NULL,
      address TEXT,
      phone_number TEXT,
      guardian_name TEXT,
      religion TEXT NOT NULL,
      state TEXT NOT NULL,
      state_origin TEXT,
      lga_origin TEXT,
      state_birth TEXT,
      blood_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      nationality TEXT NOT NULL,
      genotype TEXT,
      pass TEXT,
      role TEXT NOT NULL,
      image TEXT NOT NULL,
      login_status INTEGER NOT NULL DEFAULT 1,
      parent_id INTEGER,
      pass_name TEXT,
      active_status INTEGER NOT NULL DEFAULT 1,
      graduated INTEGER NOT NULL DEFAULT 0,
      start_term_id INTEGER,
      start_session_id INTEGER,
      joined TEXT NOT NULL,
      payment_status TEXT CHECK (payment_status IN ('paid','partial','pending'))
    );

    CREATE TABLE IF NOT EXISTS exam_passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passage_id TEXT NOT NULL,
      school_id TEXT NOT NULL,
      passage_by TEXT NOT NULL,
      exam_id INTEGER,
      exam_code TEXT NOT NULL,
      passage_title TEXT,
      passage_text TEXT NOT NULL,
      passage_order INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
      
    );

    -- Canonical attempts table (confirmed: student_attempts is correct; "student_attemps"
    -- was an earlier misread of a stray/legacy table, not what the live PHP app uses)
       CREATE TABLE IF NOT EXISTS student_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id TEXT NOT NULL,
      last_seen_at TEXT,
      attempt_id TEXT NOT NULL,
      exam_code TEXT NOT NULL,
      student_id TEXT NOT NULL,
                  current_question_index INTEGER DEFAULT 0,
      exam_id INTEGER NOT NULL,
      is_synced INTEGER DEFAULT 0,
            submission_reason TEXT DEFAULT 'student_manual' CHECK (submission_reason IN ('student_manual','timeout','anti_cheat','admin_force_submit')),
            bundle_attempt_id TEXT DEFAULT NULL,
      section TEXT DEFAULT 'A' CHECK (section IN ('A','B')),
      attempt_number INTEGER NOT NULL DEFAULT 1,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      synced_at TEXT,
      finished_at TEXT DEFAULT CURRENT_TIMESTAMP,
      score REAL,
      last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
      questions_answered INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'In Progress'
        CHECK (status IN ('In Progress','Submitted','Cancelled'))
    );

    CREATE INDEX IF NOT EXISTS idx_student_attempts_attempt_id ON student_attempts(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_student_attempts_exam_code ON student_attempts(exam_code);
    CREATE INDEX IF NOT EXISTS idx_student_attempts_student_id ON student_attempts(student_id);
    CREATE INDEX IF NOT EXISTS idx_student_attempts_status ON student_attempts(status);


  CREATE TABLE IF NOT EXISTS backup_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    reason      TEXT NOT NULL DEFAULT 'manual',
    status      TEXT NOT NULL DEFAULT 'success',
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

      CREATE TABLE IF NOT EXISTS feature_flags (
      feature_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attempt_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_question_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      exam_code TEXT NOT NULL,
      student_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      section TEXT DEFAULT 'A' CHECK (section IN ('A','B')),
      question_order INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      school_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id TEXT NOT NULL,
  sync_type TEXT NOT NULL
    CHECK (sync_type IN ('push_results','pull_exam','reference_seed')),
  direction TEXT NOT NULL CHECK (direction IN ('upload','download')),
  target TEXT,                          -- exam_code for pull_exam, 'batch' for push_results, the ref type (e.g. 'students') for reference_seed
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','success','partial','error')),
  records_synced INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  message TEXT,                         -- human-readable outcome, e.g. server error text
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_school_id ON sync_logs(school_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_sync_type ON sync_logs(sync_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at ON sync_logs(started_at);


    CREATE TABLE IF NOT EXISTS student_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_code TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      exam_id INTEGER,
      question_id TEXT NOT NULL,
      answer TEXT,
      submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      attempt_id TEXT NOT NULL,
      school_id TEXT NOT NULL,
      synced INTEGER DEFAULT 0
    );

        CREATE TABLE IF NOT EXISTS risk_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

       CREATE INDEX IF NOT EXISTS idx_students_student_id ON students(student_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_questions_attempt_id ON attempt_questions(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_student_ansers_attempt_id ON student_answers(attempt_id);

    CREATE INDEX IF NOT EXISTS idx_examinations_exam_code ON examinations(exam_code);
    CREATE INDEX IF NOT EXISTS idx_exam_questions_exam_code ON exam_questions(exam_code);
    CREATE INDEX IF NOT EXISTS idx_exam_question_options_question_id ON exam_question_options(question_id);

    -- Anti-cheat: mirrors PHP setup/sql.php's exam_incidents table
    CREATE TABLE IF NOT EXISTS exam_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_exam_incidents_attempt_id ON exam_incidents(attempt_id);
  `);
}

initSchema();

// ---- Safe migrations: run on every start, change nothing if already applied ----
function runMigrations() {
  const studentCols = db.prepare('PRAGMA table_info(students)').all().map(c => c.name);
  if (!studentCols.includes('origin')) {
    // Existing rows came from the cloud sync, so they default to 'cloud'.
    db.exec("ALTER TABLE students ADD COLUMN origin TEXT NOT NULL DEFAULT 'cloud'");
  }

  // Attempts by local students, or on LOCAL- exams, are never uploaded: the cloud has
  // nothing to attach them to. is_synced = 2 means "stays on this computer" and keeps
  // them out of every "pending upload" count (those only look at is_synced = 0).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_attempts_local_only
    AFTER INSERT ON student_attempts
    WHEN NEW.exam_code LIKE 'LOCAL-%'
      OR EXISTS (SELECT 1 FROM students s WHERE s.student_id = NEW.student_id AND s.origin = 'local')
    BEGIN
      UPDATE student_attempts SET is_synced = 2 WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    UPDATE student_attempts SET is_synced = 2
    WHERE is_synced = 0
      AND (exam_code LIKE 'LOCAL-%'
           OR student_id IN (SELECT student_id FROM students WHERE origin = 'local'))
  `);
}
runMigrations();

// Classroom position of each candidate computer (A1, B3…). A new column on an existing
// table needs an explicit migration; CREATE TABLE IF NOT EXISTS can't add it.
(function addSeatLabelColumn() {
  const cols = db.prepare('PRAGMA table_info(candidate_devices)').all().map(c => c.name);
  if (!cols.includes('seat_label')) db.exec('ALTER TABLE candidate_devices ADD COLUMN seat_label TEXT');
})();

module.exports = db;