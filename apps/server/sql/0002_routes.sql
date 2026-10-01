-- 取景路线（shooting route）：多窗口 / 通勤 / 气象变化下的重排
-- 对应需求：①多窗口+通勤+气象重排 ②离线晚到确认不得覆盖新顺序 ③冲突必须带来源与人工取舍依据

CREATE TABLE IF NOT EXISTS shoot_route (
  id                 TEXT PRIMARY KEY,
  library_id         TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  date               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','active','completed','archived')),
  -- 乐观版本号：每次重排/换窗/到达 +1。离线确认携带 baseVersion，过期则拒绝并入队
  version            INTEGER NOT NULL DEFAULT 1,
  origin_lat         REAL,
  origin_lng         REAL,
  earliest_depart_at TEXT,
  speed_kmh          REAL NOT NULL DEFAULT 25,
  slack_min          INTEGER NOT NULL DEFAULT 0,
  initial_buffer_min INTEGER NOT NULL DEFAULT 0,
  weather_degraded   INTEGER NOT NULL DEFAULT 0,
  -- 气象重算后存在未处理的换窗/降级，需要人工确认
  needs_review       INTEGER NOT NULL DEFAULT 0,
  total_commute_min  INTEGER NOT NULL DEFAULT 0,
  total_distance_km  REAL NOT NULL DEFAULT 0,
  has_blocking       INTEGER NOT NULL DEFAULT 0,
  -- 规划时刻的完整快照（含 dropped），保证审计可复算
  plan_snapshot      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_library ON shoot_route(library_id, date, status);
CREATE INDEX IF NOT EXISTS idx_route_review ON shoot_route(library_id, needs_review);

CREATE TABLE IF NOT EXISTS route_stop (
  id              TEXT PRIMARY KEY,
  route_id        TEXT NOT NULL REFERENCES shoot_route(id) ON DELETE CASCADE,
  library_id      TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  inspiration_id  TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  spot_id         TEXT REFERENCES spot(id) ON DELETE SET NULL,
  window_id       TEXT REFERENCES repro_window(id) ON DELETE SET NULL,
  date            TEXT NOT NULL,
  start_at        TEXT NOT NULL,
  end_at          TEXT NOT NULL,
  verdict         TEXT NOT NULL DEFAULT 'marginal',
  status          TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','arrived','late','skipped')),
  distance_km     REAL NOT NULL DEFAULT 0,
  commute_min     INTEGER NOT NULL DEFAULT 0,
  depart_at       TEXT,
  arrive_at       TEXT,
  leg_feasible    INTEGER NOT NULL DEFAULT 1,
  alt_window_ids  TEXT NOT NULL DEFAULT '[]',
  arrived_at      TEXT,
  UNIQUE (route_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_stop_route ON route_stop(route_id, seq);
CREATE INDEX IF NOT EXISTS idx_stop_window ON route_stop(window_id);

-- 冲突台账：任何时段/通勤/换窗/离线冲突都落这里，带来源 + 人工取舍依据
CREATE TABLE IF NOT EXISTS route_conflict (
  id                   TEXT PRIMARY KEY,
  route_id             TEXT NOT NULL REFERENCES shoot_route(id) ON DELETE CASCADE,
  library_id           TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL
                       CHECK (kind IN ('overlap','commute_unreachable','weather_shift','manual_reorder','offline_stale')),
  source               TEXT NOT NULL
                       CHECK (source IN ('auto_plan','weather_rescan','manual','offline')),
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','kept_auto','kept_manual','resolved','ignored')),
  from_inspiration_id  TEXT,
  to_inspiration_id    TEXT NOT NULL,
  message              TEXT NOT NULL,
  evidence             TEXT NOT NULL DEFAULT '{}',
  window_ids           TEXT NOT NULL DEFAULT '[]',
  -- 人工取舍依据（必填，杜绝"悄悄改了但不知道为什么"）
  resolution_basis     TEXT,
  resolved_by          TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflict_route ON route_conflict(route_id, status);
CREATE INDEX IF NOT EXISTS idx_conflict_open ON route_conflict(library_id, status);

-- 离线晚到确认挂起队列：baseVersion 落后于当前 version 时不入账，存这里等人取舍
CREATE TABLE IF NOT EXISTS route_pending_confirmation (
  id            TEXT PRIMARY KEY,
  route_id      TEXT NOT NULL REFERENCES shoot_route(id) ON DELETE CASCADE,
  library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  client_op_id  TEXT NOT NULL UNIQUE,
  stop_id       TEXT,
  inspiration_id TEXT,
  action        TEXT NOT NULL CHECK (action IN ('arrive','reorder')),
  payload       TEXT NOT NULL DEFAULT '{}',
  base_version  INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','applied','discarded')),
  decision_basis TEXT,
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_route ON route_pending_confirmation(route_id, status);
