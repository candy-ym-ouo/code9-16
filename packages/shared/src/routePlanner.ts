/**
 * 取景路线规划器（纯函数，无 IO、无三方依赖）。
 *
 * 输入：候选窗口（每张灵感卡可给多个窗口）+ 每个机位的坐标 + 出发点 + 通勤速度。
 * 输出：按"先拍质量、再少跑路"的顺序排好的当日停靠序列，以及**每一处**时段冲突。
 *
 * 设计原则（对应需求）：
 *  1) 多窗口：同一张卡的多个候选窗口分别作为可选项，规划器逐停靠挑"来得及的最优窗口"。
 *  2) 通勤：相邻机位间用 Haversine 距离 / 平均速度估通勤分钟数；赶不到即冲突，绝不静默改点。
 *  3) 气象变化：换窗（一张卡从旧窗口换到另一个窗口）记录 weather_shift 冲突并附旧/新判定理由。
 *  4) 任何冲突都带来源（auto_plan / weather_rescan / manual / offline）与可人工取舍的依据。
 */
import { distanceKm, type LatLng } from './geo.js';
import type {
  RouteConflictKind,
  RouteConflictSource,
  RouteStopStatus,
  WindowVerdict,
} from './enums.js';

export type RouteVerdict = WindowVerdict;

/** 到达状态（落库时取 arrived / late / skipped） */
export type { RouteStopStatus };

/** 一个可选拍摄窗口（来自 repro_window，已裁剪为规划需要的字段） */
export interface RouteWindowOption {
  windowId: string;
  inspirationId: string;
  date: string;
  startAt: string; // ISO
  endAt: string; // ISO
  verdict: RouteVerdict;
  /** 窗口判定理由（实际值 vs 目标值），冲突取舍时作为依据展示 */
  reasons: { code: string; level: 'ok' | 'warn' | 'bad' | 'info'; text: string }[];
  weatherDegraded: boolean;
}

export interface RouteStopCandidate {
  inspirationId: string;
  title: string;
  spotId: string;
  location: LatLng;
  options: RouteWindowOption[];
  /** 该点拍摄需要占用的缓冲分钟（窗口结束前要完成），默认取窗口自身长度 */
  dwellMin?: number;
}

export interface RoutePlanInput {
  /** 出发点（家 / 集合点），用于第一段通勤 */
  origin: LatLng | null;
  /** 最早可出发时刻（ISO）。第一段通勤若需要在此之前出发，则判为赶不到；不给则不约束首段 */
  earliestDepartAt?: string | null;
  /** 平均通勤速度 km/h，默认 25（市区混合） */
  speedKmh?: number;
  /** 起点到第一个机位的额外固定准备时间（取器材等），分钟 */
  initialBufferMin?: number;
  /** 同一天内相邻停靠间允许的最小间隔冗余，分钟 */
  slackMin?: number;
  candidates: RouteStopCandidate[];
  /** 只规划这一天（local date key YYYY-MM-DD） */
  date: string;
}

export type RouteConflict = {
  kind: RouteConflictKind;
  source: RouteConflictSource;
  /** 涉及的两张卡（首尾衔接处）；单点冲突时第二个为 null */
  between: { fromInspirationId: string | null; toInspirationId: string };
  message: string;
  /** 取舍依据：实际值 vs 限制值，可人工复算 */
  evidence: Record<string, unknown>;
  /** 涉及窗口，便于人工直接选"保留哪一个" */
  windowIds: string[];
}

export interface PlannedStop {
  seq: number;
  inspirationId: string;
  title: string;
  spotId: string;
  windowId: string;
  date: string;
  startAt: string;
  endAt: string;
  verdict: RouteVerdict;
  /** 从上一个机位（或出发点）到这里的通勤 */
  leg: {
    fromInspirationId: string | null;
    distanceKm: number;
    commuteMin: number;
    departAt: string; // 最晚出发时刻
    arriveAt: string; // 预计到达时刻
    feasible: boolean;
  };
  /** 该停靠自身可用但被规划器放弃的其它窗口（供人工换窗） */
  alternateOptionWindowIds: string[];
}

export interface RoutePlanResult {
  date: string;
  stops: PlannedStop[];
  conflicts: RouteConflict[];
  /** 因排不进而被完全放弃的卡（连同放弃原因） */
  dropped: { inspirationId: string; title: string; reason: string; evidence: Record<string, unknown> }[];
  totalCommuteMin: number;
  totalDistanceKm: number;
  /** 是否存在未被消解的硬冲突（true 时不建议直接执行，需要人工取舍） */
  hasBlockingConflict: boolean;
}

const VERDICT_RANK: Record<RouteVerdict, number> = { good: 0, marginal: 1, bad: 2 };

/** 距离 → 通勤分钟（匀速模型，速度非法时给一个保守上限） */
export function estimateCommuteMin(distance: number, speedKmh: number): number {
  if (!(speedKmh > 0)) return Number.POSITIVE_INFINITY;
  return Math.round((distance / speedKmh) * 60);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 贪心序列规划（单日）：
 *  每一轮从"还没排"的卡里，找一个从前置机位出发**赶得上其某个窗口**的最优停靠。
 *  "最优"按 ① 窗口判定（good 优先）② 通勤更短 ③ 窗口更早 排序，保证结果确定性。
 *
 *  不追求全局 TSP 最优——取景顺序首先要服从光线窗口（时间不可逆），通勤只在同档窗口里作为次级键。
 */
export function planRoute(input: RoutePlanInput): RoutePlanResult {
  const speed = input.speedKmh ?? 25;
  const slack = input.slackMin ?? 0;
  const initialBuffer = input.initialBufferMin ?? 0;

  const conflicts: RouteConflict[] = [];
  const dropped: RoutePlanResult['dropped'] = [];
  const stops: PlannedStop[] = [];

  // 起点"最早可出发"时刻：首段通勤的硬约束；不给则首段不约束（可任意早出发）
  const earliestDepartMs = input.earliestDepartAt ? new Date(input.earliestDepartAt).getTime() : Number.NEGATIVE_INFINITY;
  let prev: { inspirationId: string | null; location: LatLng; endMs: number; departReadyMs: number } = {
    inspirationId: null,
    location: input.origin ?? { lat: 0, lng: 0 },
    endMs: Number.NEGATIVE_INFINITY,
    departReadyMs: earliestDepartMs,
  };
  // 没有出发点时，第一段不做可达性约束（视为已在该片区）
  let hasOrigin = Boolean(input.origin);

  const remaining = new Map<string, RouteStopCandidate>();
  for (const c of input.candidates) {
    const dayOptions = c.options
      .filter((o) => o.date === input.date)
      .sort(
        (a, b) =>
          VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
          new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
      );
    if (dayOptions.length === 0) {
      dropped.push({
        inspirationId: c.inspirationId,
        title: c.title,
        reason: '该日没有可用窗口',
        evidence: { date: input.date },
      });
      continue;
    }
    remaining.set(c.inspirationId, { ...c, options: dayOptions });
  }

  let totalCommuteMin = 0;
  let totalDistanceKm = 0;

  while (remaining.size > 0) {
    type Pick = {
      candidate: RouteStopCandidate;
      option: RouteWindowOption;
      distance: number;
      commute: number;
      feasible: boolean;
      score: number;
    };
    const choices: Pick[] = [];

    for (const candidate of remaining.values()) {
      const distance = hasOrigin ? distanceKm(prev.location, candidate.location) : 0;
      const commute = hasOrigin ? estimateCommuteMin(distance, speed) + (stops.length === 0 ? initialBuffer : 0) : 0;
      // 选该卡"赶得上"的最优窗口；若都赶不上，则取其最优窗口并标记不可行
      let feasibleOption: RouteWindowOption | null = null;
      for (const o of candidate.options) {
        const startMs = new Date(o.startAt).getTime();
        const latestDepart = startMs - commute * 60000 - slack * 60000;
        // 无出发点时不做可达性约束；有出发点时，第一段对 earliestDepart、后续对上一站结束时刻
        if (!hasOrigin || latestDepart >= prev.departReadyMs) {
          feasibleOption = o;
          break;
        }
      }
      const option = feasibleOption ?? candidate.options[0];
      choices.push({
        candidate,
        option,
        distance,
        commute,
        feasible: feasibleOption !== null,
        score:
          VERDICT_RANK[option.verdict] * 1_000_000 +
          (feasibleOption ? 0 : 500_000) +
          Math.round(distance * 1000) +
          Math.round(new Date(option.startAt).getTime() / 60000),
      });
    }

    choices.sort((a, b) => a.score - b.score);
    const pick = choices[0];
    const { candidate, option, distance, commute, feasible } = pick;

    const startMs = new Date(option.startAt).getTime();
    const endMs = new Date(option.endAt).getTime();
    const departAtMs = startMs - commute * 60000 - slack * 60000;
    const arriveAtMs = departAtMs + commute * 60000;

    // ---- 与上一停靠的时段重叠 / 通勤不可达，必须留痕 ----
    if (stops.length > 0 || hasOrigin) {
      if (!feasible) {
        conflicts.push({
          kind: 'commute_unreachable',
          source: 'auto_plan',
          between: { fromInspirationId: prev.inspirationId, toInspirationId: candidate.inspirationId },
          message: `从「${stops[stops.length - 1]?.title ?? '出发点'}」赶不到「${candidate.title}」的${
            option.verdict === 'good' ? '最佳' : ''
          }窗口（窗口 ${new Date(option.startAt).toISOString()} 开始）`,
          evidence: {
            distanceKm: Number(distance.toFixed(2)),
            speedKmh: speed,
            commuteMin: commute,
            prevReadyAt: iso(prev.departReadyMs),
            windowStartAt: option.startAt,
            slackMin: slack,
          },
          windowIds: [stops[stops.length - 1]?.windowId, option.windowId].filter(Boolean) as string[],
        });
      } else if (arriveAtMs > startMs) {
        conflicts.push({
          kind: 'overlap',
          source: 'auto_plan',
          between: { fromInspirationId: prev.inspirationId, toInspirationId: candidate.inspirationId },
          message: `「${candidate.title}」窗口开始时仍在前一停靠的通勤路上，时段冲突`,
          evidence: {
            arriveAt: iso(arriveAtMs),
            windowStartAt: option.startAt,
            overlapMin: Math.round((arriveAtMs - startMs) / 60000),
          },
          windowIds: [stops[stops.length - 1]?.windowId, option.windowId].filter(Boolean) as string[],
        });
      }
    }

    const alternates = candidate.options.filter((o) => o.windowId !== option.windowId).map((o) => o.windowId);

    stops.push({
      seq: stops.length + 1,
      inspirationId: candidate.inspirationId,
      title: candidate.title,
      spotId: candidate.spotId,
      windowId: option.windowId,
      date: option.date,
      startAt: option.startAt,
      endAt: option.endAt,
      verdict: option.verdict,
      leg: {
        fromInspirationId: prev.inspirationId,
        distanceKm: Number(distance.toFixed(2)),
        commuteMin: commute,
        departAt: iso(departAtMs),
        arriveAt: iso(arriveAtMs),
        feasible,
      },
      alternateOptionWindowIds: alternates,
    });

    if (hasOrigin) {
      totalCommuteMin += commute;
      totalDistanceKm += distance;
    }
    prev = {
      inspirationId: candidate.inspirationId,
      location: candidate.location,
      endMs,
      departReadyMs: endMs,
    };
    hasOrigin = true; // 第一个停靠之后，后续都按真实机位计算
    remaining.delete(candidate.inspirationId);
  }

  const hasBlockingConflict = conflicts.some(
    (c) => c.kind === 'commute_unreachable' || (c.kind === 'overlap' && (c.evidence.overlapMin as number) > 0),
  );

  return {
    date: input.date,
    stops,
    conflicts,
    dropped,
    totalCommuteMin,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    hasBlockingConflict,
  };
}

// ------------------------------------------------------------- 顺序校验

export interface StoredStopLike {
  inspirationId: string;
  title: string;
  windowId: string;
  startAt: string;
  endAt: string;
  location: LatLng;
}

/**
 * 校验一份"人工给定的顺序"在通勤上是否成立。
 * 与 planRoute 不同：顺序不被自动纠正，只**指出**冲突，由人工取舍（对应需求 3）。
 */
export function validateManualOrder(
  stops: StoredStopLike[],
  opts: {
    origin: LatLng | null;
    speedKmh?: number;
    slackMin?: number;
    initialBufferMin?: number;
    earliestDepartAt?: string | null;
  },
): RouteConflict[] {
  const speed = opts.speedKmh ?? 25;
  const slack = opts.slackMin ?? 0;
  const initialBuffer = opts.initialBufferMin ?? 0;
  const conflicts: RouteConflict[] = [];
  let prevLoc: LatLng | null = opts.origin;
  let prevReadyMs = opts.earliestDepartAt ? new Date(opts.earliestDepartAt).getTime() : Number.NEGATIVE_INFINITY;
  let prevId: string | null = null;
  let prevTitle: string | null = null;
  let prevWindowId: string | null = null;

  stops.forEach((s, i) => {
    const startMs = new Date(s.startAt).getTime();
    if (prevLoc) {
      const distance = distanceKm(prevLoc, s.location);
      const commute = estimateCommuteMin(distance, speed) + (i === 0 ? initialBuffer : 0);
      const departAt = startMs - commute * 60000 - slack * 60000;
      const arriveAt = departAt + commute * 60000;
      if (departAt < prevReadyMs || arriveAt > startMs) {
        conflicts.push({
          kind: 'commute_unreachable',
          source: 'manual',
          between: { fromInspirationId: prevId, toInspirationId: s.inspirationId },
          message: `人工顺序第 ${i + 1} 站「${s.title}」无法从「${prevTitle ?? '出发点'}」赶到`,
          evidence: {
            distanceKm: Number(distance.toFixed(2)),
            speedKmh: speed,
            commuteMin: commute,
            prevReadyAt: prevReadyMs === Number.NEGATIVE_INFINITY ? null : iso(prevReadyMs),
            windowStartAt: s.startAt,
            slackMin: slack,
          },
          windowIds: [prevWindowId, s.windowId].filter(Boolean) as string[],
        });
      }
    }
    prevLoc = s.location;
    prevReadyMs = new Date(s.endAt).getTime();
    prevId = s.inspirationId;
    prevTitle = s.title;
    prevWindowId = s.windowId;
  });

  return conflicts;
}

/** 检测两份顺序之间的窗口变更（气象重算后调用） */
export function diffWindowAssignment(
  before: { inspirationId: string; windowId: string; verdict: RouteVerdict }[],
  after: Map<string, { windowId: string; verdict: RouteVerdict; reasons: { code: string; text: string }[] }>,
  source: RouteConflictSource = 'weather_rescan',
): RouteConflict[] {
  const out: RouteConflict[] = [];
  for (const b of before) {
    const now = after.get(b.inspirationId);
    if (now && now.windowId !== b.windowId) {
      out.push({
        kind: 'weather_shift',
        source,
        between: { fromInspirationId: null, toInspirationId: b.inspirationId },
        message: `气象变化导致该停靠改用另一窗口（${b.verdict} → ${now.verdict}），需人工确认是否接受新顺序`,
        evidence: {
          oldWindowId: b.windowId,
          oldVerdict: b.verdict,
          newWindowId: now.windowId,
          newVerdict: now.verdict,
          newReasons: now.reasons,
        },
        windowIds: [b.windowId, now.windowId],
      });
    }
  }
  return out;
}
