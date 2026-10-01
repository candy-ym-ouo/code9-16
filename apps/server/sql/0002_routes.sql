-- 取景路线：多窗口 / 通勤 / 气象变化下的重排，离线晚到确认防覆盖，时段冲突留痕
PRAGMA foreign_keys = ON;

-- 一条路线 = 某一天内按顺序执行的一串拍摄站（每站对应一个出行计划）
CREATE TABLE IF NOT EXISTS route (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,               -- 本地日期键 YYYY-MM-DD（与所含窗口 date 一致）
  -- 乐观并发版本：每次重排 +1；确认/调序必须基于当前版本，否则只记录不生效
  version     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  origin_text TEXT,                        -- 出发点描述（如"家"/"酒店"）
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_library ON route(library_id, status, date);

CREATE TABLE IF NOT EXISTS route_stop (
  id              TEXT PRIMARY KEY,
  route_id        TEXT NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL REFERENCES shoot_plan(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  dwell_min       INTEGER NOT NULL DEFAULT 45,   -- 预计停留（拍摄）分钟
  arrive_at       TEXT,                          -- 重排算出的到达时刻
  depart_at       TEXT,                          -- 重排算出的离开时刻
  commute_from_prev_min INTEGER,                 -- 与上一站之间的通勤分钟
  commute_source  TEXT CHECK (commute_source IN ('plan','estimate','manual')),
  confirmed_at    TEXT,                          -- 现场确认到场时刻
  confirmed_version INTEGER,                     -- 确认时基于的路线版本
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (route_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_route_stop_route ON route_stop(route_id, seq);

-- 每次重排一个版本：顺序 + 触发源 + 输入快照（窗口判定/通勤段/被放弃的候选）+ 人类可读理由
CREATE TABLE IF NOT EXISTS route_revision (
  id         TEXT PRIMARY KEY,
  route_id   TEXT NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  trigger    TEXT NOT NULL CHECK (trigger IN ('create','system_resequence','manual_reorder','weather_change')),
  stop_order TEXT NOT NULL,              -- JSON: [{stopId, planId, seq, arriveAt, departAt}]
  inputs     TEXT NOT NULL,              -- JSON: 来源快照（窗口/通勤/备选顺序）
  reasons    TEXT NOT NULL,              -- JSON: string[] 调序理由（可复算）
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (route_id, version)
);

-- 时段冲突：必须带来源（sources），必须人工取舍（resolution + rationale）才能关闭
CREATE TABLE IF NOT EXISTS route_conflict (
  id          TEXT PRIMARY KEY,
  route_id    TEXT NOT NULL REFERENCES route(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('window_overlap','commute_insufficient','weather_turned_bad','stale_confirmation')),
  dedup_key   TEXT NOT NULL,             -- 同类未决冲突去重（仅约束 open 状态，由代码保证）
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  summary     TEXT NOT NULL,
  sources     TEXT NOT NULL,             -- JSON: RouteConflictSource[]
  resolution  TEXT,                      -- accept_current / drop_stop / apply_stale_confirmation / auto_resolved
  rationale   TEXT,                      -- 人工取舍依据（人工关闭时必填）
  resolved_by TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_conflict ON route_conflict(route_id, status);
