import {
  planRoute,
  validateManualOrder,
  diffWindowAssignment,
  type LatLng,
  type PlannedStop,
  type RouteConflict,
  type RoutePlanInput,
  type RouteStopCandidate,
  type RouteWindowOption,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import type {
  RouteConflictDto,
  RouteDto,
  RouteStopDto,
  WindowVerdict,
} from '@flil/shared';
import { computeWindowsForInspiration } from './windowEngine.js';

interface RouteRow {
  id: string;
  library_id: string;
  title: string;
  date: string;
  status: string;
  version: number;
  origin_lat: number | null;
  origin_lng: number | null;
  earliest_depart_at: string | null;
  speed_kmh: number;
  slack_min: number;
  initial_buffer_min: number;
  weather_degraded: number;
  needs_review: number;
  total_commute_min: number;
  total_distance_km: number;
  has_blocking: number;
  plan_snapshot: string;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------- 数据装配

interface LoadedCandidate {
  inspirationId: string;
  title: string;
  spotId: string;
  lat: number;
  lng: number;
  windows: RouteWindowOption[];
}

/** 取某库在指定日期有窗口的卡（可限定 inspirationIds），窗口判定不低于 minVerdict */
function loadCandidates(
  libraryId: string,
  date: string,
  inspirationIds: string[],
  minVerdict: WindowVerdict,
): LoadedCandidate[] {
  const db = getDb();
  const rank: Record<WindowVerdict, number> = { good: 0, marginal: 1, bad: 2 };
  const maxRank = rank[minVerdict];

  const where = ['w.library_id = ?', 'w.date = ?', "i.deleted_at IS NULL", 's.id IS NOT NULL'];
  const args: (string | number)[] = [libraryId, date];
  if (inspirationIds.length) {
    where.push(`w.inspiration_id IN (${inspirationIds.map(() => '?').join(',')})`);
    args.push(...inspirationIds);
  }
  const rows = db
    .prepare(
      `SELECT w.id AS window_id, w.inspiration_id, w.start_at, w.end_at, w.verdict, w.reasons,
              w.weather_degraded, w.date AS wdate, i.title, i.spot_id, s.lat, s.lng
       FROM repro_window w
       JOIN inspiration i ON i.id = w.inspiration_id
       JOIN spot s ON s.id = i.spot_id
       WHERE ${where.join(' AND ')}
       ORDER BY w.start_at ASC`,
    )
    .all(...args) as {
    window_id: string;
    inspiration_id: string;
    start_at: string;
    end_at: string;
    verdict: WindowVerdict;
    reasons: string;
    weather_degraded: number;
    wdate: string;
    title: string;
    spot_id: string;
    lat: number;
    lng: number;
  }[];

  const byInsp = new Map<string, LoadedCandidate>();
  for (const r of rows) {
    if (rank[r.verdict] > maxRank) continue;
    const c = byInsp.get(r.inspiration_id) ?? {
      inspirationId: r.inspiration_id,
      title: r.title,
      spotId: r.spot_id,
      lat: r.lat,
      lng: r.lng,
      windows: [],
    };
    c.windows.push({
      windowId: r.window_id,
      inspirationId: r.inspiration_id,
      date: r.wdate,
      startAt: r.start_at,
      endAt: r.end_at,
      verdict: r.verdict,
      reasons: parseJson<RouteWindowOption['reasons']>(r.reasons, []),
      weatherDegraded: r.weather_degraded === 1,
    });
    byInsp.set(r.inspiration_id, c);
  }
  return [...byInsp.values()];
}

function toPlannerInput(
  loaded: LoadedCandidate[],
  p: {
    date: string;
    origin: LatLng | null;
    earliestDepartAt: string | null;
    speedKmh: number;
    slackMin: number;
    initialBufferMin: number;
  },
): RoutePlanInput {
  const candidates: RouteStopCandidate[] = loaded.map((c) => ({
    inspirationId: c.inspirationId,
    title: c.title,
    spotId: c.spotId,
    location: { lat: c.lat, lng: c.lng },
    options: c.windows,
  }));
  return {
    date: p.date,
    origin: p.origin,
    earliestDepartAt: p.earliestDepartAt,
    speedKmh: p.speedKmh,
    slackMin: p.slackMin,
    initialBufferMin: p.initialBufferMin,
    candidates,
  };
}

// ----------------------------------------------------------- 规划（不落库）

export interface PlanSpec {
  date: string;
  inspirationIds: string[];
  origin: LatLng | null;
  earliestDepartAt: string | null;
  speedKmh: number;
  slackMin: number;
  initialBufferMin: number;
  minVerdict: WindowVerdict;
}

export function previewPlan(libraryId: string, spec: PlanSpec) {
  const loaded = loadCandidates(libraryId, spec.date, spec.inspirationIds, spec.minVerdict);
  const result = planRoute(
    toPlannerInput(loaded, {
      date: spec.date,
      origin: spec.origin,
      earliestDepartAt: spec.earliestDepartAt,
      speedKmh: spec.speedKmh,
      slackMin: spec.slackMin,
      initialBufferMin: spec.initialBufferMin,
    }),
  );
  return { result, candidateCount: loaded.length };
}

// ----------------------------------------------------------- 冲突落库

function insertConflict(
  db: ReturnType<typeof getDb>,
  routeId: string,
  libraryId: string,
  c: RouteConflict,
  ts: string,
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO route_conflict
       (id, route_id, library_id, kind, source, status, from_inspiration_id, to_inspiration_id,
        message, evidence, window_ids, resolution_basis, resolved_by, resolved_at, created_at)
     VALUES (?,?,?,?,?, 'open', ?,?,?,?,?, NULL,NULL,NULL,?)`,
  ).run(
    id,
    routeId,
    libraryId,
    c.kind,
    c.source,
    c.between.fromInspirationId,
    c.between.toInspirationId,
    c.message,
    toJson(c.evidence ?? {}),
    toJson(c.windowIds ?? []),
    ts,
  );
  return id;
}

// ----------------------------------------------------------- 创建路线

export function createRoute(
  libraryId: string,
  spec: PlanSpec & { title: string },
): { id: string; version: number } {
  const db = getDb();
  const { result } = previewPlan(libraryId, spec);
  const id = newId();
  const ts = nowIso();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO shoot_route
        (id, library_id, title, date, status, version, origin_lat, origin_lng, earliest_depart_at,
         speed_kmh, slack_min, initial_buffer_min, weather_degraded, needs_review, total_commute_min,
         total_distance_km, has_blocking, plan_snapshot, created_at, updated_at)
       VALUES (?,?,?,?, 'draft', 1, ?,?,?, ?,?,?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      libraryId,
      spec.title,
      spec.date,
      spec.origin?.lat ?? null,
      spec.origin?.lng ?? null,
      spec.earliestDepartAt,
      spec.speedKmh,
      spec.slackMin,
      spec.initialBufferMin,
      result.totalCommuteMin,
      result.totalDistanceKm,
      result.hasBlockingConflict ? 1 : 0,
      toJson({ dropped: result.dropped }),
      ts,
      ts,
    );

    persistStops(db, id, libraryId, result.stops);
    // 规划器产出的冲突全部留痕，来源 auto_plan
    for (const c of result.conflicts) insertConflict(db, id, libraryId, c, ts);
  });
  tx();

  return { id, version: 1 };
}

function persistStops(db: ReturnType<typeof getDb>, routeId: string, libraryId: string, stops: PlannedStop[]): void {
  db.prepare('DELETE FROM route_stop WHERE route_id = ?').run(routeId);
  const stmt = db.prepare(
    `INSERT INTO route_stop
      (id, route_id, library_id, seq, inspiration_id, spot_id, window_id, date, start_at, end_at,
       verdict, status, distance_km, commute_min, depart_at, arrive_at, leg_feasible, alt_window_ids, arrived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'planned', ?,?,?,?,?,?, NULL)`,
  );
  for (const s of stops) {
    stmt.run(
      newId(),
      routeId,
      libraryId,
      s.seq,
      s.inspirationId,
      s.spotId,
      s.windowId,
      s.date,
      s.startAt,
      s.endAt,
      s.verdict,
      s.leg.distanceKm,
      s.leg.commuteMin,
      s.leg.departAt,
      s.leg.arriveAt,
      s.leg.feasible ? 1 : 0,
      toJson(s.alternateOptionWindowIds),
    );
  }
}

// ----------------------------------------------------------- 读取

function requireRoute(db: ReturnType<typeof getDb>, routeId: string, libraryId: string): RouteRow {
  const row = db.prepare('SELECT * FROM shoot_route WHERE id = ? AND library_id = ?').get(routeId, libraryId) as
    | RouteRow
    | undefined;
  if (!row) throw errors.notFound('路线');
  return row;
}

interface StopRow {
  id: string;
  seq: number;
  inspiration_id: string;
  spot_id: string | null;
  window_id: string | null;
  date: string;
  start_at: string;
  end_at: string;
  verdict: WindowVerdict;
  status: RouteStopDto['status'];
  distance_km: number;
  commute_min: number;
  depart_at: string | null;
  arrive_at: string | null;
  leg_feasible: number;
  alt_window_ids: string;
  arrived_at: string | null;
}

export function listRoutes(libraryId: string): RouteDto[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM shoot_route WHERE library_id = ? ORDER BY date DESC, updated_at DESC LIMIT 200')
    .all(libraryId) as RouteRow[];
  return rows.map((r) => toRouteDto(r));
}

export function getRoute(libraryId: string, routeId: string): RouteDto {
  return toRouteDto(requireRoute(getDb(), routeId, libraryId));
}

function loadStops(routeId: string): (StopRow & { inspiration_title: string; spot_lat: number; spot_lng: number })[] {
  return getDb()
    .prepare(
      `SELECT st.*, i.title AS inspiration_title, s.lat AS spot_lat, s.lng AS spot_lng
       FROM route_stop st
       JOIN inspiration i ON i.id = st.inspiration_id
       LEFT JOIN spot s ON s.id = st.spot_id
       WHERE st.route_id = ? ORDER BY st.seq ASC`,
    )
    .all(routeId) as (StopRow & { inspiration_title: string; spot_lat: number; spot_lng: number })[];
}

function loadConflicts(routeId: string): RouteConflictDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM route_conflict WHERE route_id = ? ORDER BY created_at ASC, id ASC')
    .all(routeId) as Record<string, unknown>[];
  return rows.map(toConflictDto);
}

function toConflictDto(r: Record<string, unknown>): RouteConflictDto {
  return {
    id: r.id as string,
    kind: r.kind as RouteConflictDto['kind'],
    source: r.source as RouteConflictDto['source'],
    status: r.status as RouteConflictDto['status'],
    fromInspirationId: (r.from_inspiration_id as string | null) ?? null,
    toInspirationId: r.to_inspiration_id as string,
    message: r.message as string,
    evidence: parseJson<Record<string, unknown>>(r.evidence, {}),
    windowIds: parseJson<string[]>(r.window_ids, []),
    resolutionBasis: (r.resolution_basis as string | null) ?? null,
    resolvedBy: (r.resolved_by as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

function toRouteDto(row: RouteRow): RouteDto {
  const stopRows = loadStops(row.id);
  const stops: RouteStopDto[] = stopRows.map((s) => ({
    id: s.id,
    seq: s.seq,
    inspirationId: s.inspiration_id,
    inspirationTitle: s.inspiration_title,
    spotId: s.spot_id ?? '',
    windowId: s.window_id,
    date: s.date,
    startAt: s.start_at,
    endAt: s.end_at,
    verdict: s.verdict,
    status: s.status,
    leg: {
      fromInspirationId: null,
      distanceKm: s.distance_km,
      commuteMin: s.commute_min,
      departAt: s.depart_at,
      arriveAt: s.arrive_at,
      feasible: s.leg_feasible === 1,
    },
    alternateOptionWindowIds: parseJson<string[]>(s.alt_window_ids, []),
    arrivedAt: s.arrived_at,
  }));
  // 填 leg.fromInspirationId
  stops.forEach((s, i) => {
    s.leg.fromInspirationId = i === 0 ? null : stops[i - 1].inspirationId;
  });

  const conflicts = loadConflicts(row.id);
  const snapshot = parseJson<{ dropped?: RouteDto['dropped'] }>(row.plan_snapshot, {});

  return {
    id: row.id,
    title: row.title,
    date: row.date,
    status: row.status as RouteDto['status'],
    version: row.version,
    origin: row.origin_lat != null && row.origin_lng != null ? { lat: row.origin_lat, lng: row.origin_lng } : null,
    earliestDepartAt: row.earliest_depart_at,
    speedKmh: row.speed_kmh,
    slackMin: row.slack_min,
    initialBufferMin: row.initial_buffer_min,
    weatherDegraded: row.weather_degraded === 1,
    needsReview: row.needs_review === 1,
    totalCommuteMin: row.total_commute_min,
    totalDistanceKm: row.total_distance_km,
    hasBlockingConflict: row.has_blocking === 1,
    stops,
    conflicts,
    dropped: snapshot.dropped ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ----------------------------------------------------- 人工改序 / 换窗

interface StopWithCoord extends StopRow {
  lat: number;
  lng: number;
  title: string;
}

function fetchStopsWithCoords(routeId: string): StopWithCoord[] {
  return getDb()
    .prepare(
      `SELECT st.*, i.title, s.lat, s.lng FROM route_stop st
       JOIN inspiration i ON i.id = st.inspiration_id
       JOIN spot s ON s.id = st.spot_id
       WHERE st.route_id = ? ORDER BY st.seq ASC`,
    )
    .all(routeId) as StopWithCoord[];
}

/**
 * 人工改序。
 * 顺序不被自动纠正；若通勤不成立，逐条留 manual 冲突并写取舍依据，版本号 +1。
 */
export function reorderRoute(
  libraryId: string,
  routeId: string,
  userId: string,
  input: { baseVersion: number; orderedInspirationIds: string[]; rationale: string },
): RouteDto {
  const db = getDb();
  const row = requireRoute(db, routeId, libraryId);
  if (input.baseVersion !== row.version) {
    throw errors.routeVersionConflict(row.version);
  }
  const current = fetchStopsWithCoords(routeId);
  const byInsp = new Map(current.map((s) => [s.inspiration_id, s]));
  const ordered: StopWithCoord[] = [];
  for (const id of input.orderedInspirationIds) {
    const s = byInsp.get(id);
    if (!s) throw errors.badRequest(`顺序中包含不属于本路线的卡片：${id}`);
    ordered.push(s);
  }
  if (ordered.length !== current.length) {
    throw errors.badRequest('改序必须包含路线上的全部停靠，不能增删');
  }

  const origin: LatLng | null =
    row.origin_lat != null && row.origin_lng != null ? { lat: row.origin_lat, lng: row.origin_lng } : null;
  const manualConflicts = validateManualOrder(
    ordered.map((s) => ({
      inspirationId: s.inspiration_id,
      title: s.title,
      windowId: s.window_id ?? '',
      startAt: s.start_at,
      endAt: s.end_at,
      location: { lat: s.lat, lng: s.lng },
    })),
    {
      origin,
      earliestDepartAt: row.earliest_depart_at,
      speedKmh: row.speed_kmh,
      slackMin: row.slack_min,
      initialBufferMin: row.initial_buffer_min,
    },
  );

  const ts = nowIso();
  const tx = db.transaction(() => {
    // 先把 seq 让到负值，避免 UPDATE 过程中与 (route_id, seq) 唯一索引相撞
    ordered.forEach((s, i) => db.prepare('UPDATE route_stop SET seq=? WHERE id=?').run(-(i + 1000), s.id));

    // 再按新顺序写 seq，并用新的前序机位重算通勤腿
    let prevLoc = origin;
    let prevReady = row.earliest_depart_at ? new Date(row.earliest_depart_at).getTime() : Number.NEGATIVE_INFINITY;
    let prevId: string | null = null;
    ordered.forEach((s, i) => {
      const startMs = new Date(s.start_at).getTime();
      const dist = prevLoc ? kmBetween(prevLoc, { lat: s.lat, lng: s.lng }) : 0;
      const commute = prevLoc
        ? Math.round((dist / row.speed_kmh) * 60) + (i === 0 ? row.initial_buffer_min : 0)
        : 0;
      const departAt = new Date(startMs - commute * 60000 - row.slack_min * 60000).toISOString();
      const arriveAt = new Date(new Date(departAt).getTime() + commute * 60000).toISOString();
      const feasible = i === 0 || !prevLoc || new Date(departAt).getTime() >= prevReady;
      db.prepare(
        `UPDATE route_stop SET seq=?, distance_km=?, commute_min=?, depart_at=?, arrive_at=?, leg_feasible=?
         WHERE id=?`,
      ).run(i + 1, Number(dist.toFixed(2)), commute, prevLoc ? departAt : null, prevLoc ? arriveAt : null, feasible ? 1 : 0, s.id);
      prevLoc = { lat: s.lat, lng: s.lng };
      prevReady = new Date(s.end_at).getTime();
      prevId = s.inspiration_id;
    });
    void prevId;

    for (const c of manualConflicts) insertConflict(db, routeId, libraryId, c, ts);
    // 一条总的"人工改序"审计冲突，记录取舍依据
    insertConflict(
      db,
      routeId,
      libraryId,
      {
        kind: 'manual_reorder',
        source: 'manual',
        between: { fromInspirationId: null, toInspirationId: ordered[0].inspiration_id },
        message: `人工调整了 ${ordered.length} 个停靠的顺序：${input.rationale}`,
        evidence: {
          orderedInspirationIds: input.orderedInspirationIds,
          rationale: input.rationale,
          commuteConflicts: manualConflicts.length,
          by: userId,
        },
        windowIds: ordered.map((s) => s.window_id).filter((x): x is string => Boolean(x)),
      },
      ts,
    );

    const blocking = openBlockingConflictCount(db, routeId);
    db.prepare(
      'UPDATE shoot_route SET version=version+1, has_blocking=?, updated_at=? WHERE id=?',
    ).run(blocking > 0 ? 1 : 0, ts, routeId);
  });
  tx();

  return getRoute(libraryId, routeId);
}

/** 换窗：把某停靠切到其备选窗口，并重算后续通勤，留 weather/manual 痕迹 */
export function changeStopWindow(
  libraryId: string,
  routeId: string,
  userId: string,
  input: { baseVersion: number; stopId: string; windowId: string; rationale: string },
): RouteDto {
  const db = getDb();
  const row = requireRoute(db, routeId, libraryId);
  if (input.baseVersion !== row.version) throw errors.routeVersionConflict(row.version);

  const stop = db
    .prepare('SELECT * FROM route_stop WHERE id = ? AND route_id = ?')
    .get(input.stopId, routeId) as StopRow | undefined;
  if (!stop) throw errors.notFound('停靠');
  const alts = parseJson<string[]>(stop.alt_window_ids, []);
  if (!alts.includes(input.windowId)) {
    throw errors.badRequest('目标窗口不在该停靠的可选窗口内（不能换成别的卡或别日窗口）');
  }
  const win = db
    .prepare(
      `SELECT id, date, start_at, end_at, verdict, weather_degraded FROM repro_window
       WHERE id = ? AND inspiration_id = ? AND library_id = ?`,
    )
    .get(input.windowId, stop.inspiration_id, libraryId) as
    | { id: string; date: string; start_at: string; end_at: string; verdict: WindowVerdict; weather_degraded: number }
    | undefined;
  if (!win) throw errors.notFound('窗口');

  const ts = nowIso();
  const tx = db.transaction(() => {
    const newAlts = [stop.window_id, ...alts.filter((w) => w !== input.windowId)].filter(
      (w): w is string => Boolean(w),
    );
    db.prepare(
      'UPDATE route_stop SET window_id=?, date=?, start_at=?, end_at=?, verdict=?, alt_window_ids=? WHERE id=?',
    ).run(win.id, win.date, win.start_at, win.end_at, win.verdict, toJson(newAlts), stop.id);

    insertConflict(
      db,
      routeId,
      libraryId,
      {
        kind: 'weather_shift',
        source: 'manual',
        between: { fromInspirationId: null, toInspirationId: stop.inspiration_id },
        message: `人工把该停靠换到备选窗口：${input.rationale}`,
        evidence: {
          oldWindowId: stop.window_id,
          newWindowId: win.id,
          newVerdict: win.verdict,
          weatherDegraded: win.weather_degraded === 1,
          rationale: input.rationale,
          by: userId,
        },
        windowIds: [stop.window_id, win.id].filter((x): x is string => Boolean(x)),
      },
      ts,
    );

    // 换窗后重算全部通勤腿并补登新产生的冲突
    const stops = fetchStopsWithCoords(routeId);
    const origin: LatLng | null =
      row.origin_lat != null && row.origin_lng != null ? { lat: row.origin_lat, lng: row.origin_lng } : null;
    const conflicts = validateManualOrder(
      stops.map((s) => ({
        inspirationId: s.inspiration_id,
        title: s.title,
        windowId: s.window_id ?? '',
        startAt: s.start_at,
        endAt: s.end_at,
        location: { lat: s.lat, lng: s.lng },
      })),
      {
        origin,
        earliestDepartAt: row.earliest_depart_at,
        speedKmh: row.speed_kmh,
        slackMin: row.slack_min,
        initialBufferMin: row.initial_buffer_min,
      },
    );
    applyLegs(db, row, stops);
    // 仅登记"当前实际存在"且此前没有等价 open 记录的冲突，避免重复刷屏
    for (const c of conflicts) {
      if (!hasOpenConflict(db, routeId, c)) insertConflict(db, routeId, libraryId, c, ts);
    }

    const blocking = openBlockingConflictCount(db, routeId);
    db.prepare('UPDATE shoot_route SET version=version+1, has_blocking=?, needs_review=0, updated_at=? WHERE id=?').run(
      blocking > 0 ? 1 : 0,
      ts,
      routeId,
    );
  });
  tx();
  return getRoute(libraryId, routeId);
}

function applyLegs(db: ReturnType<typeof getDb>, row: RouteRow, stops: StopWithCoord[]): void {
  let prevLoc: LatLng | null =
    row.origin_lat != null && row.origin_lng != null ? { lat: row.origin_lat, lng: row.origin_lng } : null;
  let prevReady = row.earliest_depart_at ? new Date(row.earliest_depart_at).getTime() : Number.NEGATIVE_INFINITY;
  stops.forEach((s, i) => {
    const startMs = new Date(s.start_at).getTime();
    const dist = prevLoc ? kmBetween(prevLoc, { lat: s.lat, lng: s.lng }) : 0;
    const commute = prevLoc ? Math.round((dist / row.speed_kmh) * 60) + (i === 0 ? row.initial_buffer_min : 0) : 0;
    const departAt = new Date(startMs - commute * 60000 - row.slack_min * 60000);
    const arriveAt = new Date(departAt.getTime() + commute * 60000);
    const feasible = i === 0 || !prevLoc || departAt.getTime() >= prevReady;
    db.prepare(
      'UPDATE route_stop SET distance_km=?, commute_min=?, depart_at=?, arrive_at=?, leg_feasible=? WHERE id=?',
    ).run(
      Number(dist.toFixed(2)),
      commute,
      prevLoc ? departAt.toISOString() : null,
      prevLoc ? arriveAt.toISOString() : null,
      feasible ? 1 : 0,
      s.id,
    );
    prevLoc = { lat: s.lat, lng: s.lng };
    prevReady = new Date(s.end_at).getTime();
  });
}

function kmBetween(a: LatLng, b: LatLng): number {
  // 服务端直接用 shared 的 distanceKm；这里独立实现避免循环导入差异
  const R = 6371.0088;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ----------------------------------------------------------- 气象重算 + 重排

/**
 * 重新拉取各卡窗口，按规划器重排。
 * 若任何停靠的窗口发生变化（气象变化导致换窗/时刻漂移），置 needs_review 并留 weather_rescan 冲突，
 * 新顺序**不自动生效覆盖**，等人确认（对应"气象变化下重排"且不丢人工判断）。
 */
export async function rescanWeather(
  libraryId: string,
  routeId: string,
  baseVersion: number,
): Promise<{ changed: boolean; route: RouteDto }> {
  const db = getDb();
  const row = requireRoute(db, routeId, libraryId);
  if (baseVersion !== row.version) throw errors.routeVersionConflict(row.version);

  const stops = fetchStopsWithCoords(routeId);
  const inspirationIds = [...new Set(stops.map((s) => s.inspiration_id))];
  for (const id of inspirationIds) {
    try {
      await computeWindowsForInspiration(id, { days: 8 });
    } catch {
      /* 单卡失败不阻断整体重算 */
    }
  }

  const origin: LatLng | null =
    row.origin_lat != null && row.origin_lng != null ? { lat: row.origin_lat, lng: row.origin_lng } : null;
  const loaded = loadCandidates(libraryId, row.date, inspirationIds, 'bad');
  const result = planRoute(
    toPlannerInput(loaded, {
      date: row.date,
      origin,
      earliestDepartAt: row.earliest_depart_at,
      speedKmh: row.speed_kmh,
      slackMin: row.slack_min,
      initialBufferMin: row.initial_buffer_min,
    }),
  );

  const beforeAssignment = stops.map((s) => ({
    inspirationId: s.inspiration_id,
    windowId: s.window_id ?? '',
    verdict: s.verdict,
  }));
  const afterMap = new Map(
    result.stops.map(
      (s) =>
        [
          s.inspirationId,
          { windowId: s.windowId, verdict: s.verdict, reasons: [] as { code: string; text: string }[] },
        ] as const,
    ),
  );
  // 用新窗口的真实 reasons 填充
  for (const c of loaded) {
    const chosen = result.stops.find((s) => s.inspirationId === c.inspirationId);
    if (chosen) {
      const win = c.windows.find((w) => w.windowId === chosen.windowId);
      afterMap.set(c.inspirationId, {
        windowId: chosen.windowId,
        verdict: chosen.verdict,
        reasons: win?.reasons.map((r) => ({ code: r.code, text: r.text })) ?? [],
      });
    }
  }

  const weatherConflicts = diffWindowAssignment(beforeAssignment, afterMap, 'weather_rescan');
  const anyDegraded = loaded.some((c) => c.windows.some((w) => w.weatherDegraded));
  const changed = weatherConflicts.length > 0;

  const ts = nowIso();
  const tx = db.transaction(() => {
    if (changed) {
      // 更新窗口指针/时刻为新规划结果，但保留人工 seq？——需求是"重排"，故采用新顺序，等待确认
      persistStops(db, routeId, libraryId, result.stops);
      for (const c of weatherConflicts) insertConflict(db, routeId, libraryId, c, ts);
      for (const c of result.conflicts) {
        if (c.kind !== 'weather_shift' && !hasOpenConflict(db, routeId, c)) insertConflict(db, routeId, libraryId, c, ts);
      }
      db.prepare('UPDATE shoot_route SET needs_review=1, weather_degraded=? WHERE id=?').run(anyDegraded ? 1 : 0, routeId);
    }
    const blocking = openBlockingConflictCount(db, routeId);
    db.prepare(
      'UPDATE shoot_route SET version=version+1, total_commute_min=?, total_distance_km=?, has_blocking=?, weather_degraded=?, updated_at=? WHERE id=?',
    ).run(result.totalCommuteMin, result.totalDistanceKm, blocking > 0 ? 1 : 0, anyDegraded ? 1 : 0, ts, routeId);
  });
  tx();

  return { changed, route: getRoute(libraryId, routeId) };
}

/** 人工确认接受气象重排后的新顺序 */
export function acceptWeatherRescan(libraryId: string, routeId: string, userId: string, basis: string): RouteDto {
  const db = getDb();
  requireRoute(db, routeId, libraryId);
  const ts = nowIso();
  db.transaction(() => {
    const openWeather = db
      .prepare("SELECT id FROM route_conflict WHERE route_id=? AND kind='weather_shift' AND status='open'")
      .all(routeId) as { id: string }[];
    for (const c of openWeather) {
      db.prepare(
        'UPDATE route_conflict SET status=?, resolution_basis=?, resolved_by=?, resolved_at=? WHERE id=?',
      ).run('kept_manual', basis, userId, ts, c.id);
    }
    const blocking = openBlockingConflictCount(db, routeId);
    db.prepare('UPDATE shoot_route SET needs_review=0, has_blocking=?, updated_at=? WHERE id=?').run(
      blocking > 0 ? 1 : 0,
      ts,
      routeId,
    );
  })();
  return getRoute(libraryId, routeId);
}

// ----------------------------------------------------------- 到达确认（含离线保护）

export interface ArriveResult {
  status: 'recorded' | 'already';
  stopStatus: 'arrived' | 'late';
  version: number;
}

/**
 * 到达确认。
 * - 在线（带 baseVersion）：版本不一致直接 409，绝不覆盖新顺序。
 * - 离线（clientOpId，无 baseVersion）：版本不一致时挂起到 route_pending_confirmation，等人取舍；不写入到达。
 */
export function markArrived(
  libraryId: string,
  routeId: string,
  userId: string,
  stopId: string,
  input: { clientOpId?: string; baseVersion?: number; arrivedAt?: string; late?: boolean },
): ArriveResult {
  const db = getDb();
  const row = requireRoute(db, routeId, libraryId);
  const stop = db
    .prepare('SELECT * FROM route_stop WHERE id=? AND route_id=?')
    .get(stopId, routeId) as StopRow | undefined;
  if (!stop) throw errors.notFound('停靠');

  // 幂等：同一离线操作重复提交
  if (input.clientOpId) {
    const dup = db
      .prepare('SELECT id, status FROM route_pending_confirmation WHERE client_op_id=?')
      .get(input.clientOpId) as { id: string; status: string } | undefined;
    if (dup) {
      return { status: 'already', stopStatus: stop.status === 'late' ? 'late' : 'arrived', version: row.version };
    }
  }

  const ts = nowIso();
  const isStale = input.baseVersion !== undefined && input.baseVersion !== row.version;

  if (isStale && input.baseVersion !== undefined) {
    // 在线却拿到旧版本：直接 409，让前端刷新后基于新顺序操作
    throw errors.routeVersionConflict(row.version, '该停靠所属顺序已变更，请刷新后再确认到达');
  }

  // 离线晚到确认：没有 baseVersion（断网时无法知道当前版本）。
  // 若路线在此期间被重排/换窗（version>1 且该 stop 已不在原位），不能直接盖到新顺序上 → 挂起。
  const offline = input.baseVersion === undefined && Boolean(input.clientOpId);
  const stopMoved = stop.window_id !== currentWindowAtSeq(db, routeId, stop.seq);
  if (offline && (row.version > 1 || stopMoved)) {
    enqueuePending(db, {
      routeId,
      libraryId,
      clientOpId: input.clientOpId!,
      stopId,
      inspirationId: stop.inspiration_id,
      action: 'arrive',
      payload: { arrivedAt: input.arrivedAt ?? ts, late: input.late ?? false },
      baseVersion: 1,
      reason:
        '离线期间路线已被重排或换窗（气象变化/人工改序），晚到的到达确认不能覆盖新顺序，需人工决定作用到哪个停靠',
    });
    // 记录一条 offline_stale 冲突留痕
    insertConflict(
      db,
      routeId,
      libraryId,
      {
        kind: 'offline_stale',
        source: 'offline',
        between: { fromInspirationId: null, toInspirationId: stop.inspiration_id },
        message: '离线晚到确认落在旧顺序上，已挂起等待人工取舍，未覆盖新顺序',
        evidence: {
          clientOpId: input.clientOpId,
          stopId,
          seq: stop.seq,
          currentVersion: row.version,
          windowId: stop.window_id,
          by: userId,
        },
        windowIds: stop.window_id ? [stop.window_id] : [],
      },
      ts,
    );
    // 挂起不增加 version（顺序未变），但 needs_review 打开提醒人工
    db.prepare('UPDATE shoot_route SET needs_review=1, updated_at=? WHERE id=?').run(ts, routeId);
    return { status: 'already', stopStatus: stop.status === 'late' ? 'late' : 'arrived', version: row.version };
  }

  const late = input.late ?? new Date(input.arrivedAt ?? ts).getTime() > new Date(stop.start_at).getTime();
  db.transaction(() => {
    db.prepare("UPDATE route_stop SET status=?, arrived_at=? WHERE id=?").run(
      late ? 'late' : 'arrived',
      input.arrivedAt ?? ts,
      stopId,
    );
    // 首个到达把路线激活；全部到达则完成
    const pendingCount = db
      .prepare("SELECT COUNT(*) AS n FROM route_stop WHERE route_id=? AND status='planned'")
      .get(routeId) as { n: number };
    const newStatus = pendingCount.n === 0 ? 'completed' : 'active';
    db.prepare('UPDATE shoot_route SET status=?, updated_at=? WHERE id=?').run(newStatus, ts, routeId);
    if (input.clientOpId) {
      db.prepare(
        `INSERT INTO offline_op (id, library_id, client_op_id, op_type, payload, result, applied_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        newId(),
        libraryId,
        input.clientOpId,
        'route_arrive',
        toJson({ routeId, stopId }),
        toJson({ applied: true }),
        ts,
        ts,
      );
    }
  })();
  return { status: 'recorded', stopStatus: late ? 'late' : 'arrived', version: row.version };
}

function currentWindowAtSeq(db: ReturnType<typeof getDb>, routeId: string, seq: number): string | null {
  const row = db
    .prepare('SELECT window_id FROM route_stop WHERE route_id=? AND seq=?')
    .get(routeId, seq) as { window_id: string | null } | undefined;
  return row?.window_id ?? null;
}

interface PendingInput {
  routeId: string;
  libraryId: string;
  clientOpId: string;
  stopId: string | null;
  inspirationId: string | null;
  action: 'arrive' | 'reorder';
  payload: Record<string, unknown>;
  baseVersion: number;
  reason: string;
}

function enqueuePending(db: ReturnType<typeof getDb>, p: PendingInput): void {
  db.prepare(
    `INSERT INTO route_pending_confirmation
      (id, route_id, library_id, client_op_id, stop_id, inspiration_id, action, payload, base_version, reason, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`,
  ).run(
    newId(),
    p.routeId,
    p.libraryId,
    p.clientOpId,
    p.stopId,
    p.inspirationId,
    p.action,
    toJson(p.payload),
    p.baseVersion,
    p.reason,
    nowIso(),
  );
}

// ----------------------------------------------------------- 冲突 / 挂起队列

function openBlockingConflictCount(db: ReturnType<typeof getDb>, routeId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM route_conflict
       WHERE route_id=? AND status='open' AND kind IN ('overlap','commute_unreachable')`,
    )
    .get(routeId) as { n: number };
  return row.n;
}

function hasOpenConflict(db: ReturnType<typeof getDb>, routeId: string, c: RouteConflict): boolean {
  const rows = db
    .prepare("SELECT evidence FROM route_conflict WHERE route_id=? AND status='open' AND kind=?")
    .all(routeId, c.kind) as { evidence: string }[];
  return rows.some((r) => {
    const e = parseJson<Record<string, unknown>>(r.evidence, {});
    return JSON.stringify(e.windowStartAt ?? e.startAt) === JSON.stringify(c.evidence.windowStartAt ?? c.evidence.startAt);
  });
}

export function resolveConflict(
  libraryId: string,
  routeId: string,
  conflictId: string,
  userId: string,
  input: { resolution: 'keep_auto' | 'keep_manual' | 'ignore'; basis: string },
): RouteDto {
  const db = getDb();
  requireRoute(db, routeId, libraryId);
  const c = db
    .prepare('SELECT * FROM route_conflict WHERE id=? AND route_id=?')
    .get(conflictId, routeId) as Record<string, unknown> | undefined;
  if (!c) throw errors.notFound('冲突');

  const ts = nowIso();
  const statusMap = { keep_auto: 'kept_auto', keep_manual: 'kept_manual', ignore: 'ignored' } as const;
  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE route_conflict SET status=?, resolution_basis=?, resolved_by=?, resolved_at=? WHERE id=?',
    ).run(statusMap[input.resolution], input.basis, userId, ts, conflictId);
    // keep_manual：接受当前（人工）顺序；ignore：标记忽略但保留可追溯
    const blocking = openBlockingConflictCount(db, routeId);
    db.prepare('UPDATE shoot_route SET has_blocking=?, updated_at=? WHERE id=?').run(
      blocking > 0 ? 1 : 0,
      ts,
      routeId,
    );
  });
  tx();
  return getRoute(libraryId, routeId);
}

export function listPendingConfirmations(libraryId: string, routeId?: string) {
  const db = getDb();
  const where = ['library_id = ?', "status = 'pending'"];
  const args: string[] = [libraryId];
  if (routeId) {
    where.push('route_id = ?');
    args.push(routeId);
  }
  const rows = db
    .prepare(`SELECT * FROM route_pending_confirmation WHERE ${where.join(' AND ')} ORDER BY created_at ASC`)
    .all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id,
    routeId: r.route_id,
    clientOpId: r.client_op_id,
    stopId: r.stop_id,
    inspirationId: r.inspiration_id,
    action: r.action,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    baseVersion: r.base_version,
    currentVersion: (db.prepare('SELECT version FROM shoot_route WHERE id=?').get(r.route_id) as { version: number })
      .version,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/**
 * 处理挂起的离线确认：
 *  - apply：把确认作用到"当前最新顺序"中同 inspiration 的停靠（人已核对），并写依据。
 *  - discard：丢弃，留痕。
 */
export function resolvePendingConfirmation(
  libraryId: string,
  pendingId: string,
  userId: string,
  input: { decision: 'apply' | 'discard'; basis: string },
): RouteDto {
  const db = getDb();
  const p = db
    .prepare('SELECT * FROM route_pending_confirmation WHERE id=? AND library_id=?')
    .get(pendingId, libraryId) as Record<string, unknown> | undefined;
  if (!p) throw errors.notFound('挂起确认');
  if (p.status !== 'pending') throw errors.badRequest('该挂起确认已处理');

  const routeId = p.route_id as string;
  requireRoute(db, routeId, libraryId);
  const ts = nowIso();
  const tx = db.transaction(() => {
    if (input.decision === 'apply' && p.action === 'arrive') {
      const payload = parseJson<{ arrivedAt?: string; late?: boolean }>(p.payload, {});
      // 关键：作用到当前顺序里同一张卡的停靠，而不是旧 stopId，避免盖错位
      const target = db
        .prepare('SELECT id, start_at, status FROM route_stop WHERE route_id=? AND inspiration_id=? ORDER BY seq ASC LIMIT 1')
        .get(routeId, p.inspiration_id) as { id: string; start_at: string; status: string } | undefined;
      if (target && target.status === 'planned') {
        const late =
          payload.late ?? new Date(payload.arrivedAt ?? ts).getTime() > new Date(target.start_at).getTime();
        db.prepare('UPDATE route_stop SET status=?, arrived_at=? WHERE id=?').run(
          late ? 'late' : 'arrived',
          payload.arrivedAt ?? ts,
          target.id,
        );
      }
    }
    db.prepare(
      'UPDATE route_pending_confirmation SET status=?, decision_basis=?, decided_by=?, decided_at=? WHERE id=?',
    ).run(input.decision === 'apply' ? 'applied' : 'discarded', input.basis, userId, ts, pendingId);
    // 对应 offline_stale 冲突关闭，记依据
    db.prepare(
      `UPDATE route_conflict SET status='resolved', resolution_basis=?, resolved_by=?, resolved_at=?
       WHERE route_id=? AND kind='offline_stale' AND status='open'
         AND json_extract(evidence, '$.clientOpId') = ?`,
    ).run(input.basis, userId, ts, routeId, p.client_op_id);
    const blocking = openBlockingConflictCount(db, routeId);
    const stillPending = db
      .prepare("SELECT COUNT(*) AS n FROM route_pending_confirmation WHERE route_id=? AND status='pending'")
      .get(routeId) as { n: number };
    db.prepare('UPDATE shoot_route SET has_blocking=?, needs_review=?, updated_at=? WHERE id=?').run(
      blocking > 0 ? 1 : 0,
      stillPending.n > 0 ? 1 : 0,
      ts,
      routeId,
    );
  });
  tx();
  return getRoute(libraryId, routeId);
}
