import {
  distanceKm,
  estimateCommuteMin,
  formatLocal,
  type RouteConflictDto,
  type RouteConflictSource,
  type RouteDto,
  type RouteRevisionDto,
  type RouteStopDto,
  type RouteTrigger,
  type WindowReasonDto,
  type WindowVerdict,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { emitEvent } from './events.js';

/**
 * 取景路线服务。
 *
 * 三条硬规则的落点：
 * 1) 重排必须给来源：每次调序写 route_revision（触发源 + 窗口/通勤输入快照 + 被放弃的候选顺序）。
 * 2) 离线晚到确认不得覆盖新顺序：确认必须带 baseVersion，落后版本只记录 stale_confirmation 冲突。
 * 3) 时段冲突必须人工取舍：route_conflict 从 open 到 resolved 必须填 resolution + rationale。
 */

// ---------------------------------------------------------------- 数据装载

interface RouteRow {
  id: string;
  library_id: string;
  title: string;
  date: string;
  version: number;
  status: string;
  origin_text: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface StopRow {
  stop_id: string;
  route_id: string;
  plan_id: string;
  seq: number;
  dwell_min: number;
  arrive_at: string | null;
  depart_at: string | null;
  commute_from_prev_min: number | null;
  commute_source: string | null;
  confirmed_at: string | null;
  confirmed_version: number | null;
  inspiration_id: string;
  inspiration_title: string;
  plan_commute_min: number;
  window_id: string | null;
  win_start: string | null;
  win_end: string | null;
  win_verdict: string | null;
  win_reasons: string | null;
  win_computed_at: string | null;
  win_degraded: number | null;
  spot_lat: number | null;
  spot_lng: number | null;
  spot_tz: string | null;
}

export function requireRoute(routeId: string, libraryId: string): RouteRow {
  const row = getDb().prepare('SELECT * FROM route WHERE id = ? AND library_id = ?').get(routeId, libraryId) as
    | RouteRow
    | undefined;
  if (!row) throw errors.notFound('路线');
  return row;
}

function loadStopRows(routeId: string): StopRow[] {
  return getDb()
    .prepare(
      `SELECT rs.id AS stop_id, rs.route_id, rs.plan_id, rs.seq, rs.dwell_min, rs.arrive_at, rs.depart_at,
              rs.commute_from_prev_min, rs.commute_source, rs.confirmed_at, rs.confirmed_version,
              i.id AS inspiration_id, i.title AS inspiration_title, p.commute_min AS plan_commute_min,
              w.id AS window_id, w.start_at AS win_start, w.end_at AS win_end, w.verdict AS win_verdict,
              w.reasons AS win_reasons, w.computed_at AS win_computed_at, w.weather_degraded AS win_degraded,
              s.lat AS spot_lat, s.lng AS spot_lng, s.tz AS spot_tz
       FROM route_stop rs
       JOIN shoot_plan p ON p.id = rs.plan_id
       JOIN inspiration i ON i.id = p.inspiration_id
       LEFT JOIN repro_window w ON w.id = p.window_id
       LEFT JOIN spot s ON s.id = i.spot_id
       WHERE rs.route_id = ?
       ORDER BY rs.seq ASC`,
    )
    .all(routeId) as StopRow[];
}

// ---------------------------------------------------------------- 求值（纯函数部分）

/** 窗口判定理由中属于"气象硬性不符"的编码（与 windowEngine 的输出一一对应） */
const WEATHER_FAIL_CODES = /^(PRECIP|WIND|VISIBILITY|CLOUD|TEMP|PHENOMENON)_FAIL$/;

interface StopInput {
  stopId: string;
  planId: string;
  inspirationTitle: string;
  dwellMin: number;
  planCommuteMin: number;
  lat: number | null;
  lng: number | null;
  tz: string;
  windowId: string | null;
  winStart: Date;
  winEnd: Date;
  verdict: WindowVerdict;
  winReasons: WindowReasonDto[];
  winComputedAt: string | null;
  weatherDegraded: boolean;
  /** 已确认的站不被自动重排（钉在当前位置） */
  pinned: boolean;
  seq: number;
}

interface LegInfo {
  fromStopId: string | null;
  toStopId: string;
  minutes: number;
  source: 'plan' | 'estimate' | 'manual';
  distanceKm: number | null;
}

interface ConflictDraft {
  kind: 'window_overlap' | 'commute_insufficient' | 'weather_turned_bad';
  dedupKey: string;
  summary: string;
  sources: RouteConflictSource[];
}

interface StopSchedule {
  stopId: string;
  arriveAt: string;
  departAt: string;
  leg: LegInfo;
}

interface EvalResult {
  schedules: StopSchedule[];
  conflicts: ConflictDraft[];
  totalCommuteMin: number;
  totalMissedMin: number;
  reasons: string[];
}

function windowSource(s: StopInput): RouteConflictSource {
  return {
    type: 'window',
    stopId: s.stopId,
    inspirationTitle: s.inspirationTitle,
    windowId: s.windowId,
    startAt: s.winStart.toISOString(),
    endAt: s.winEnd.toISOString(),
    verdict: s.verdict,
    computedAt: s.winComputedAt,
    reasons: s.winReasons,
  };
}

function legBetween(prev: StopInput, next: StopInput): LegInfo {
  if (prev.lat !== null && prev.lng !== null && next.lat !== null && next.lng !== null) {
    const km = distanceKm({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng });
    return {
      fromStopId: prev.stopId,
      toStopId: next.stopId,
      minutes: estimateCommuteMin(km),
      source: 'estimate',
      distanceKm: Math.round(km * 10) / 10,
    };
  }
  // 缺坐标时退化为占位估算，并在理由里说明（不静默编造）
  return { fromStopId: prev.stopId, toStopId: next.stopId, minutes: 30, source: 'estimate', distanceKm: null };
}

function fmtHM(iso: Date, tz: string): string {
  return formatLocal(iso, tz);
}

/**
 * 评估一个候选顺序：沿时间轴走一遍，产出每站到离时刻、通勤段、时段冲突与理由。
 * 规则（可复算）：
 * - 首站按窗口开始时刻到达（从出发点倒推出发时间，用计划里的通勤分钟）；
 * - 后续站：最早到达 = 上一站离开 + 通勤；早到则等窗口开始；
 * - 到达晚于窗口结束 → commute_insufficient；停留被窗口结束压缩 → window_overlap；
 * - 窗口判定为 bad 且含气象硬性不符 → weather_turned_bad。
 */
export function evaluateOrder(ordered: StopInput[]): EvalResult {
  const schedules: StopSchedule[] = [];
  const conflicts: ConflictDraft[] = [];
  const reasons: string[] = [];
  let totalCommuteMin = 0;
  let totalMissedMin = 0;
  let prev: StopInput | null = null;
  let prevDepart: Date | null = null;

  for (const s of ordered) {
    const leg: LegInfo = prev
      ? legBetween(prev, s)
      : {
          fromStopId: null,
          toStopId: s.stopId,
          minutes: s.planCommuteMin,
          source: 'plan',
          distanceKm: null,
        };
    totalCommuteMin += leg.minutes;

    const earliest: Date = prev && prevDepart ? new Date(prevDepart.getTime() + leg.minutes * 60000) : s.winStart;
    const arrive: Date = earliest > s.winStart ? earliest : s.winStart;
    const depart: Date = new Date(arrive.getTime() + s.dwellMin * 60000);
    schedules.push({
      stopId: s.stopId,
      arriveAt: arrive.toISOString(),
      departAt: depart.toISOString(),
      leg,
    });

    if (prev && leg.distanceKm !== null) {
      reasons.push(
        `「${prev.inspirationTitle}」→「${s.inspirationTitle}」通勤约 ${leg.minutes} 分钟（距离 ${leg.distanceKm} km，估算）`,
      );
    } else if (prev) {
      reasons.push(`「${prev.inspirationTitle}」→「${s.inspirationTitle}」缺少机位坐标，通勤按 ${leg.minutes} 分钟占位估算`);
    }

    if (earliest > s.winEnd) {
      const missed = s.dwellMin;
      totalMissedMin += missed;
      conflicts.push({
        kind: 'commute_insufficient',
        dedupKey: `commute:${prev?.stopId ?? 'origin'}→${s.stopId}`,
        summary:
          `到「${s.inspirationTitle}」最早 ${fmtHM(earliest, s.tz)} 到达（通勤 ${leg.minutes} 分钟），` +
          `已晚于窗口结束 ${fmtHM(s.winEnd, s.tz)}`,
        sources: [
          ...(prev ? [windowSource(prev)] : []),
          windowSource(s),
          {
            type: 'commute',
            fromStopId: leg.fromStopId ?? 'origin',
            toStopId: s.stopId,
            distanceKm: leg.distanceKm ?? 0,
            minutes: leg.minutes,
            source: leg.source,
          },
        ],
      });
    } else if (depart > s.winEnd) {
      const clippedMin = Math.round((depart.getTime() - s.winEnd.getTime()) / 60000);
      totalMissedMin += clippedMin;
      conflicts.push({
        kind: 'window_overlap',
        dedupKey: `overlap:${prev?.stopId ?? 'origin'}→${s.stopId}`,
        summary:
          `「${s.inspirationTitle}」${fmtHM(arrive, s.tz)} 才能开拍，停留 ${s.dwellMin} 分钟将超出窗口结束 ` +
          `${fmtHM(s.winEnd, s.tz)}（被压缩 ${clippedMin} 分钟）`,
        sources: [
          ...(prev ? [windowSource(prev)] : []),
          windowSource(s),
          {
            type: 'commute',
            fromStopId: leg.fromStopId ?? 'origin',
            toStopId: s.stopId,
            distanceKm: leg.distanceKm ?? 0,
            minutes: leg.minutes,
            source: leg.source,
          },
        ],
      });
    }

    if (s.verdict === 'bad') {
      const weatherFails = s.winReasons.filter((r) => WEATHER_FAIL_CODES.test(r.code));
      if (weatherFails.length > 0) {
        conflicts.push({
          kind: 'weather_turned_bad',
          dedupKey: `weather:${s.stopId}`,
          summary: `「${s.inspirationTitle}」窗口气象转差：${weatherFails.map((r) => r.text).join('；')}`,
          sources: [windowSource(s)],
        });
      }
    }

    prev = s;
    prevDepart = depart;
  }

  return { schedules, conflicts, totalCommuteMin, totalMissedMin, reasons };
}

// ---------------------------------------------------------------- 选序

interface Candidate {
  order: StopInput[];
  result: EvalResult;
}

function scoreOf(r: EvalResult, order: StopInput[]): [number, number, number, number] {
  // 字典序：先比冲突数，再比被压缩/错过的分钟数，再比总通勤；
  // 完全打平时偏向"早窗口排前面"的自然顺序（确定性的，与传入顺序无关）。
  // 权重随位置递减：越早的位置权重越大，最小化该加权和 ⇔ 早窗口尽量靠前。
  const n = order.length;
  const chrono = order.reduce((acc, s, idx) => acc + (n - 1 - idx) * (s.winStart.getTime() / 60000), 0);
  return [r.conflicts.length, r.totalMissedMin, r.totalCommuteMin, chrono];
}

function compareScore(a: Candidate, b: Candidate): number {
  const sa = scoreOf(a.result, a.order);
  const sb = scoreOf(b.result, b.order);
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sa[i] - sb[i];
  return 0;
}

function* permute<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permute(rest)) yield [items[i], ...tail];
  }
}

const MAX_PERMUTE_FREE = 8;

/**
 * 选出最优顺序：已确认的站钉住不动，其余站在空位上全排列（≤8 个），
 * 按 (冲突数, 错过分钟, 总通勤) 字典序取最优；同时保留两个被放弃的候选作为取舍依据。
 */
export function chooseOrder(stops: StopInput[]): {
  best: Candidate;
  alternatives: { order: string[]; conflicts: number; missedMin: number; commuteMin: number; note: string }[];
} {
  const indexed = stops.map((s, i) => ({ s, i }));
  const pinned = new Map<number, StopInput>();
  const free: StopInput[] = [];
  for (const { s, i } of indexed) {
    if (s.pinned) pinned.set(i, s);
    else free.push(s);
  }

  const freeOrders: StopInput[][] =
    free.length === 0
      ? [[]]
      : free.length > MAX_PERMUTE_FREE
        ? [free.slice().sort((a, b) => a.winStart.getTime() - b.winStart.getTime())]
        : Array.from(permute(free));

  let best: Candidate | null = null;
  const others: Candidate[] = [];
  for (const freeOrder of freeOrders) {
    const order: StopInput[] = [];
    let f = 0;
    for (let i = 0; i < stops.length; i += 1) {
      const p = pinned.get(i);
      if (p) order.push(p);
      else {
        order.push(freeOrder[f]);
        f += 1;
      }
    }
    const result = evaluateOrder(order);
    const candidate = { order, result };
    if (!best || compareScore(candidate, best) < 0) best = candidate;
    else others.push(candidate);
  }

  const alternatives = others
    .sort((a, b) => compareScore(a, b))
    .slice(0, 2)
    .map((c) => {
      const [bc, bm, bt] = scoreOf(best!.result, best!.order);
      const [cc, cm, ct] = scoreOf(c.result, c.order);
      const parts: string[] = [];
      if (cc > bc) parts.push(`冲突多 ${cc - bc} 个`);
      if (cm > bm) parts.push(`错过窗口多 ${cm - bm} 分钟`);
      if (ct > bt) parts.push(`通勤多 ${ct - bt} 分钟`);
      return {
        order: c.order.map((s) => s.stopId),
        conflicts: cc,
        missedMin: cm,
        commuteMin: ct,
        note: parts.length ? parts.join('，') : '与最优方案同分，按窗口先后次序落选',
      };
    });

  return { best: best!, alternatives };
}

// ---------------------------------------------------------------- 落库

function toStopInput(row: StopRow): StopInput | null {
  if (!row.win_start || !row.win_end) return null;
  return {
    stopId: row.stop_id,
    planId: row.plan_id,
    inspirationTitle: row.inspiration_title,
    dwellMin: row.dwell_min,
    planCommuteMin: row.plan_commute_min,
    lat: row.spot_lat,
    lng: row.spot_lng,
    tz: row.spot_tz ?? 'Asia/Shanghai',
    windowId: row.window_id,
    winStart: new Date(row.win_start),
    winEnd: new Date(row.win_end),
    verdict: (row.win_verdict ?? 'bad') as WindowVerdict,
    winReasons: parseJson<WindowReasonDto[]>(row.win_reasons, []),
    winComputedAt: row.win_computed_at,
    weatherDegraded: row.win_degraded === 1,
    pinned: row.confirmed_at !== null,
    seq: row.seq,
  };
}

const AUTO_KINDS = new Set(['window_overlap', 'commute_insufficient', 'weather_turned_bad']);

/** 自动类冲突随重排同步：消失的自动关闭（留痕），新出现的开单；晚到确认类永不自动关闭 */
function syncAutoConflicts(routeId: string, drafts: ConflictDraft[], ts: string): void {
  const db = getDb();
  const open = db
    .prepare("SELECT id, kind, dedup_key FROM route_conflict WHERE route_id = ? AND status = 'open'")
    .all(routeId) as { id: string; kind: string; dedup_key: string }[];

  const draftKeys = new Set(drafts.map((d) => d.dedupKey));
  for (const c of open) {
    if (!AUTO_KINDS.has(c.kind)) continue;
    if (!draftKeys.has(c.dedup_key)) {
      db.prepare(
        "UPDATE route_conflict SET status = 'resolved', resolution = 'auto_resolved', rationale = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      ).run('重排后该冲突已不存在（系统自动关闭，历史保留）', ts, ts, c.id);
    }
  }

  const openKeys = new Set(
    open.filter((c) => c.dedup_key && AUTO_KINDS.has(c.kind)).map((c) => c.dedup_key),
  );
  for (const d of drafts) {
    if (openKeys.has(d.dedupKey)) continue;
    db.prepare(
      `INSERT INTO route_conflict (id, route_id, kind, dedup_key, status, summary, sources, created_at, updated_at)
       VALUES (?,?,?,?, 'open', ?,?,?,?)`,
    ).run(newId(), routeId, d.kind, d.dedupKey, d.summary, toJson(d.sources), ts, ts);
  }
}

function applyOrder(
  route: RouteRow,
  order: StopInput[],
  result: EvalResult,
  alternatives: { order: string[]; conflicts: number; missedMin: number; commuteMin: number; note: string }[],
  trigger: RouteTrigger,
  extraReasons: string[],
  actorId: string | null,
  version: number,
): void {
  const db = getDb();
  const ts = nowIso();
  const scheduleByStop = new Map(result.schedules.map((s) => [s.stopId, s]));

  const run = db.transaction(() => {
    order.forEach((s, idx) => {
      const sch = scheduleByStop.get(s.stopId)!;
      db.prepare(
        `UPDATE route_stop SET seq = ?, arrive_at = ?, depart_at = ?, commute_from_prev_min = ?, commute_source = ?, updated_at = ?
         WHERE id = ?`,
      ).run(idx + 1, sch.arriveAt, sch.departAt, sch.leg.minutes, sch.leg.source, ts, s.stopId);
    });
    db.prepare('UPDATE route SET version = ?, updated_at = ? WHERE id = ?').run(version, ts, route.id);
    db.prepare(
      `INSERT INTO route_revision (id, route_id, version, trigger, stop_order, inputs, reasons, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId(),
      route.id,
      version,
      trigger,
      toJson(
        order.map((s, idx) => {
          const sch = scheduleByStop.get(s.stopId)!;
          return { stopId: s.stopId, planId: s.planId, seq: idx + 1, arriveAt: sch.arriveAt, departAt: sch.departAt };
        }),
      ),
      toJson({
        generatedAt: ts,
        windows: order.map((s) => ({
          stopId: s.stopId,
          windowId: s.windowId,
          startAt: s.winStart.toISOString(),
          endAt: s.winEnd.toISOString(),
          verdict: s.verdict,
          computedAt: s.winComputedAt,
        })),
        legs: result.schedules.map((s) => s.leg),
        alternatives,
      }),
      toJson([...extraReasons, ...result.reasons]),
      actorId,
      ts,
    );
    syncAutoConflicts(route.id, result.conflicts, ts);
  });
  run();

  emitEvent({
    type: 'route_resequenced',
    libraryId: route.library_id,
    payload: { routeId: route.id, version, trigger },
  });
}

// ---------------------------------------------------------------- 对外操作

export function createRoute(
  libraryId: string,
  input: { title: string; date: string; planIds: string[]; originText?: string | null },
  actorId: string,
): string {
  const db = getDb();
  const plans = input.planIds.map((pid) => {
    const row = db
      .prepare(
        `SELECT p.id, p.status, w.date AS win_date FROM shoot_plan p
         LEFT JOIN repro_window w ON w.id = p.window_id
         WHERE p.id = ? AND p.library_id = ?`,
      )
      .get(pid, libraryId) as { id: string; status: string; win_date: string | null } | undefined;
    if (!row) throw errors.notFound(`计划 ${pid}`);
    if (row.status !== 'planned') throw errors.badRequest('只有待出发的计划才能加入路线');
    if (!row.win_date) throw errors.badRequest('计划缺少窗口，无法排入路线');
    if (row.win_date !== input.date) {
      throw errors.badRequest(`计划窗口日期（${row.win_date}）与路线日期（${input.date}）不一致`);
    }
    const dup = db
      .prepare(
        `SELECT 1 AS x FROM route_stop rs JOIN route r ON r.id = rs.route_id
         WHERE rs.plan_id = ? AND r.status = 'active'`,
      )
      .get(pid);
    if (dup) throw errors.badRequest('该计划已在另一条进行中的路线里');
    return row;
  });
  if (plans.length !== input.planIds.length) throw errors.badRequest('计划数量异常');

  const routeId = newId();
  const ts = nowIso();
  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO route (id, library_id, title, date, version, status, origin_text, created_by, created_at, updated_at)
       VALUES (?,?,?,?,1,'active',?,?,?,?)`,
    ).run(routeId, libraryId, input.title, input.date, input.originText ?? null, actorId, ts, ts);
    input.planIds.forEach((pid, idx) => {
      db.prepare(
        `INSERT INTO route_stop (id, route_id, plan_id, seq, dwell_min, created_at, updated_at)
         VALUES (?,?,?,?,45,?,?)`,
      ).run(newId(), routeId, pid, idx + 1, ts, ts);
    });
  });
  insert();

  // 创建即做第一次排序（trigger=create，版本 1）
  const route = requireRoute(routeId, libraryId);
  const stops = loadStopRows(routeId).map(toStopInput).filter((s): s is StopInput => s !== null);
  const { best, alternatives } = chooseOrder(stops);
  applyOrder(route, best.order, best.result, alternatives, 'create', ['创建路线：按窗口开始时间与通勤估算生成初始顺序'], actorId, 1);
  return routeId;
}

/** 系统重排：多窗口 + 通勤 + 当前气象判定下重新选序（版本 +1，旧版本永远可回溯） */
export function resequenceRoute(
  routeId: string,
  libraryId: string,
  trigger: RouteTrigger,
  actorId: string | null,
  extraReasons: string[] = [],
): { version: number; conflicts: number } {
  const route = requireRoute(routeId, libraryId);
  if (route.status !== 'active') throw errors.badRequest('路线已结束或取消，不能重排');
  const stops = loadStopRows(routeId).map(toStopInput).filter((s): s is StopInput => s !== null);
  if (stops.length === 0) throw errors.badRequest('路线内没有可重排的站（窗口缺失）');
  const { best, alternatives } = chooseOrder(stops);
  const version = route.version + 1;
  applyOrder(route, best.order, best.result, alternatives, trigger, extraReasons, actorId, version);
  return { version, conflicts: best.result.conflicts.length };
}

/** 人工调序：必须带当前版本 + 取舍依据；依据会写进版本记录 */
export function manualReorderRoute(
  routeId: string,
  libraryId: string,
  input: { stopIds: string[]; rationale: string; baseVersion: number },
  actorId: string,
): { version: number } {
  const route = requireRoute(routeId, libraryId);
  if (route.status !== 'active') throw errors.badRequest('路线已结束或取消，不能调序');
  if (input.baseVersion !== route.version) {
    throw errors.routeVersionStale(currentOrderDetails(route.id, route.version));
  }
  const rows = loadStopRows(routeId);
  const byId = new Map(rows.map((r) => [r.stop_id, r]));
  const wanted = new Set(input.stopIds);
  if (wanted.size !== rows.length || rows.some((r) => !wanted.has(r.stop_id))) {
    throw errors.badRequest('调序列表必须恰好包含路线内的全部站点');
  }
  const ordered: StopInput[] = input.stopIds.map((sid) => {
    const s = toStopInput(byId.get(sid)!);
    if (!s) throw errors.badRequest('存在窗口缺失的站点，无法调序');
    return s;
  });
  const result = evaluateOrder(ordered);
  const version = route.version + 1;
  applyOrder(route, ordered, result, [], 'manual_reorder', [`人工调序：${input.rationale}`], actorId, version);
  return { version };
}

export interface ConfirmResult {
  applied: boolean;
  stale: boolean;
  currentVersion: number;
  conflictId?: string;
  order?: { stopId: string; seq: number }[];
}

function currentOrderDetails(routeId: string, version: number): Record<string, unknown> {
  const rows = getDb()
    .prepare('SELECT id, seq FROM route_stop WHERE route_id = ? ORDER BY seq ASC')
    .all(routeId) as { id: string; seq: number }[];
  return { currentVersion: version, order: rows.map((r) => ({ stopId: r.id, seq: r.seq })) };
}

/**
 * 站点确认（含离线补录通道）。
 * baseVersion 落后于路线当前版本时：**只记录、不应用**——
 * 顺序不会被晚到确认覆盖，确认本身变成一条 stale_confirmation 冲突等待人工取舍。
 */
export function confirmRouteStop(
  routeId: string,
  stopId: string,
  baseVersion: number,
  opts: { libraryId: string; clientOpId?: string; confirmedAt?: string },
): ConfirmResult {
  const db = getDb();
  const route = requireRoute(routeId, opts.libraryId);
  const stop = db.prepare('SELECT id FROM route_stop WHERE id = ? AND route_id = ?').get(stopId, routeId) as
    | { id: string }
    | undefined;
  if (!stop) throw errors.notFound('路线站点');

  if (baseVersion > route.version) {
    throw errors.badRequest(`确认基于的版本（${baseVersion}）超前于服务端版本（${route.version}）`);
  }

  if (baseVersion < route.version) {
    // 晚到确认：不覆盖新顺序，只留痕并开冲突
    const ts = nowIso();
    const attempt: RouteConflictSource = {
      type: 'client_op',
      clientOpId: opts.clientOpId ?? null,
      stopId,
      baseVersion,
      currentVersion: route.version,
      attemptedAt: opts.confirmedAt ?? ts,
    };
    const dedupKey = `stale:${stopId}`;
    const existing = db
      .prepare("SELECT id, sources FROM route_conflict WHERE route_id = ? AND dedup_key = ? AND status = 'open'")
      .get(routeId, dedupKey) as { id: string; sources: string } | undefined;
    let conflictId: string;
    const run = db.transaction(() => {
      if (existing) {
        conflictId = existing.id;
        const sources = [...parseJson<RouteConflictSource[]>(existing.sources, []), attempt].slice(-5);
        db.prepare(
          'UPDATE route_conflict SET sources = ?, summary = ?, updated_at = ? WHERE id = ?',
        ).run(
          toJson(sources),
          `离线确认晚到：基于版本 ${baseVersion}，当前已是版本 ${route.version}，确认未生效（等待人工取舍）`,
          ts,
          existing.id,
        );
      } else {
        conflictId = newId();
        db.prepare(
          `INSERT INTO route_conflict (id, route_id, kind, dedup_key, status, summary, sources, created_at, updated_at)
           VALUES (?,?, 'stale_confirmation', ?, 'open', ?,?,?,?)`,
        ).run(
          conflictId,
          routeId,
          dedupKey,
          `离线确认晚到：基于版本 ${baseVersion}，当前已是版本 ${route.version}，确认未生效（等待人工取舍）`,
          toJson([attempt]),
          ts,
          ts,
        );
      }
    });
    run();
    return {
      applied: false,
      stale: true,
      currentVersion: route.version,
      conflictId: conflictId!,
      order: (currentOrderDetails(routeId, route.version).order as { stopId: string; seq: number }[]),
    };
  }

  const ts = nowIso();
  db.prepare('UPDATE route_stop SET confirmed_at = ?, confirmed_version = ?, updated_at = ? WHERE id = ?').run(
    opts.confirmedAt ?? ts,
    baseVersion,
    ts,
    stopId,
  );
  return { applied: true, stale: false, currentVersion: route.version };
}

/** 冲突人工取舍：resolution + rationale 必填，副作用按取舍动作执行 */
export function resolveRouteConflict(
  routeId: string,
  conflictId: string,
  libraryId: string,
  input: { resolution: string; rationale: string; stopId?: string },
  actorId: string,
): void {
  const db = getDb();
  const route = requireRoute(routeId, libraryId);
  const conflict = db
    .prepare('SELECT * FROM route_conflict WHERE id = ? AND route_id = ?')
    .get(conflictId, routeId) as
    | { id: string; kind: string; status: string; sources: string }
    | undefined;
  if (!conflict) throw errors.notFound('冲突');
  if (conflict.status !== 'open') throw errors.badRequest('该冲突已被处理');

  if (input.resolution === 'drop_stop') {
    if (!input.stopId) throw errors.badRequest('移除站点必须指定 stopId');
    const stop = db
      .prepare(
        `SELECT rs.id, i.title FROM route_stop rs JOIN shoot_plan p ON p.id = rs.plan_id
         JOIN inspiration i ON i.id = p.inspiration_id WHERE rs.id = ? AND rs.route_id = ?`,
      )
      .get(input.stopId, routeId) as { id: string; title: string } | undefined;
    if (!stop) throw errors.badRequest('stopId 不属于该路线');
    db.prepare('DELETE FROM route_stop WHERE id = ?').run(input.stopId);
    // 移除后按剩余站点重排，理由里带上人工依据
    const remaining = loadStopRows(routeId).map(toStopInput).filter((s): s is StopInput => s !== null);
    if (remaining.length > 0) {
      const { best, alternatives } = chooseOrder(remaining);
      applyOrder(
        route,
        best.order,
        best.result,
        alternatives,
        'manual_reorder',
        [`冲突取舍：移除「${stop.title}」`, `人工依据：${input.rationale}`],
        actorId,
        route.version + 1,
      );
    }
  } else if (input.resolution === 'apply_stale_confirmation') {
    if (conflict.kind !== 'stale_confirmation') throw errors.badRequest('该取舍只适用于晚到确认冲突');
    const sources = parseJson<RouteConflictSource[]>(conflict.sources, []);
    const attempt = [...sources].reverse().find((s) => s.type === 'client_op') as
      | Extract<RouteConflictSource, { type: 'client_op' }>
      | undefined;
    if (!attempt) throw errors.badRequest('冲突记录里找不到确认来源');
    // 人工拍板：这条晚到的确认有效 —— 是人决定的，不是离线数据自动覆盖
    db.prepare('UPDATE route_stop SET confirmed_at = ?, confirmed_version = ?, updated_at = ? WHERE id = ?').run(
      attempt.attemptedAt,
      route.version,
      nowIso(),
      attempt.stopId,
    );
  } else if (input.resolution !== 'accept_current') {
    throw errors.badRequest(`未知取舍动作：${input.resolution}`);
  }

  db.prepare(
    `UPDATE route_conflict SET status = 'resolved', resolution = ?, rationale = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.resolution, input.rationale, actorId, nowIso(), nowIso(), conflictId);
}

/** 窗口判定变化（气象/天文重算）的钩子：受影响路线自动重排并留下来源 */
export function handleWindowVerdictChange(
  inspirationId: string,
  changes: { date: string; from: string; to: string }[],
): void {
  if (changes.length === 0) return;
  const db = getDb();
  const routes = db
    .prepare(
      `SELECT DISTINCT r.id, r.library_id FROM route r
       JOIN route_stop rs ON rs.route_id = r.id
       JOIN shoot_plan p ON p.id = rs.plan_id
       WHERE p.inspiration_id = ? AND r.status = 'active'`,
    )
    .all(inspirationId) as { id: string; library_id: string }[];
  if (routes.length === 0) return;

  const title = (
    db.prepare('SELECT title FROM inspiration WHERE id = ?').get(inspirationId) as { title: string } | undefined
  )?.title ?? inspirationId;
  const verdictLabel = (v: string) => (v === 'good' ? '可拍' : v === 'marginal' ? '勉强' : '不可拍');
  const reasons = changes.map(
    (c) => `「${title}」${c.date} 窗口判定由「${verdictLabel(c.from)}」变为「${verdictLabel(c.to)}」，触发重排`,
  );

  for (const r of routes) {
    try {
      resequenceRoute(r.id, r.library_id, 'weather_change', null, reasons);
    } catch {
      // 单条路线重排失败不阻塞窗口计算主流程（如下一站窗口被删）
    }
  }
}

// ---------------------------------------------------------------- 查询与 DTO

function toRouteDto(route: RouteRow, stops: StopRow[], openConflicts: number): RouteDto {
  return {
    id: route.id,
    title: route.title,
    date: route.date,
    version: route.version,
    status: route.status as RouteDto['status'],
    originText: route.origin_text,
    stops: stops.map(
      (r): RouteStopDto => ({
        id: r.stop_id,
        planId: r.plan_id,
        inspirationId: r.inspiration_id,
        inspirationTitle: r.inspiration_title,
        seq: r.seq,
        arriveAt: r.arrive_at,
        departAt: r.depart_at,
        dwellMin: r.dwell_min,
        commuteFromPrevMin: r.commute_from_prev_min,
        commuteSource: (r.commute_source as RouteStopDto['commuteSource']) ?? null,
        confirmedAt: r.confirmed_at,
        confirmedVersion: r.confirmed_version,
        window:
          r.win_start && r.win_end
            ? {
                id: r.window_id,
                startAt: r.win_start,
                endAt: r.win_end,
                verdict: (r.win_verdict ?? 'bad') as WindowVerdict,
                weatherDegraded: r.win_degraded === 1,
                computedAt: r.win_computed_at,
              }
            : null,
      }),
    ),
    openConflicts,
    createdAt: route.created_at,
    updatedAt: route.updated_at,
  };
}

export function listRoutes(libraryId: string): RouteDto[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM route WHERE library_id = ? ORDER BY date DESC, created_at DESC LIMIT 100')
    .all(libraryId) as RouteRow[];
  return rows.map((r) => {
    const stops = loadStopRows(r.id);
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM route_conflict WHERE route_id = ? AND status = 'open'")
      .get(r.id) as { n: number };
    return toRouteDto(r, stops, open.n);
  });
}

export function getRouteDetail(
  routeId: string,
  libraryId: string,
): { item: RouteDto; conflicts: RouteConflictDto[]; revisions: RouteRevisionDto[] } {
  const db = getDb();
  const route = requireRoute(routeId, libraryId);
  const stops = loadStopRows(routeId);
  const conflicts = db
    .prepare(
      `SELECT * FROM route_conflict WHERE route_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC`,
    )
    .all(routeId) as Record<string, unknown>[];
  const openCount = conflicts.filter((c) => c.status === 'open').length;
  const revisions = db
    .prepare('SELECT * FROM route_revision WHERE route_id = ? ORDER BY version DESC')
    .all(routeId) as Record<string, unknown>[];

  return {
    item: toRouteDto(route, stops, openCount),
    conflicts: conflicts.map(
      (c): RouteConflictDto => ({
        id: c.id as string,
        routeId,
        kind: c.kind as RouteConflictDto['kind'],
        status: c.status as RouteConflictDto['status'],
        summary: c.summary as string,
        sources: parseJson<RouteConflictSource[]>(c.sources, []),
        resolution: (c.resolution as string | null) ?? null,
        rationale: (c.rationale as string | null) ?? null,
        resolvedBy: (c.resolved_by as string | null) ?? null,
        resolvedAt: (c.resolved_at as string | null) ?? null,
        createdAt: c.created_at as string,
      }),
    ),
    revisions: revisions.map(
      (r): RouteRevisionDto => ({
        version: r.version as number,
        trigger: r.trigger as RouteTrigger,
        reasons: parseJson<string[]>(r.reasons, []),
        inputs: parseJson<RouteRevisionDto['inputs']>(r.inputs, null),
        createdBy: (r.created_by as string | null) ?? null,
        createdAt: r.created_at as string,
      }),
    ),
  };
}
