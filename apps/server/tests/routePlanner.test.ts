import { describe, expect, it } from 'vitest';
import {
  diffWindowAssignment,
  estimateCommuteMin,
  planRoute,
  validateManualOrder,
  type RoutePlanInput,
  type RouteStopCandidate,
} from '@flil/shared';

// 上海附近两个相距约 2km 的机位
const A = { lat: 31.2471, lng: 121.4726 };
const B = { lat: 31.265, lng: 121.4726 };
const C = { lat: 31.4, lng: 121.6 }; // 远，约 20km

function win(
  inspirationId: string,
  windowId: string,
  start: string,
  end: string,
  verdict: 'good' | 'marginal' | 'bad' = 'good',
  date = '2026-10-03',
) {
  return {
    windowId,
    inspirationId,
    date,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    verdict,
    reasons: [{ code: 'X', level: 'ok' as const, text: 't' }],
    weatherDegraded: false,
  };
}

function candidate(
  inspirationId: string,
  title: string,
  location: { lat: number; lng: number },
  options: RouteStopCandidate['options'],
): RouteStopCandidate {
  return { inspirationId, title, spotId: `spot-${inspirationId}`, location, options };
}

describe('routePlanner.planRoute', () => {
  it('good 窗口优先于 marginal，并按时间排成可行序列', () => {
    const input: RoutePlanInput = {
      date: '2026-10-03',
      origin: A,
      speedKmh: 30,
      candidates: [
        candidate('card-b', 'B卡', B, [win('card-b', 'w-b', '2026-10-03T10:00:00+08:00', '2026-10-03T10:30:00+08:00', 'marginal')]),
        candidate('card-a', 'A卡', A, [win('card-a', 'w-a', '2026-10-03T08:00:00+08:00', '2026-10-03T08:30:00+08:00', 'good')]),
      ],
    };
    const r = planRoute(input);
    expect(r.stops.map((s) => s.inspirationId)).toEqual(['card-a', 'card-b']);
    expect(r.conflicts).toHaveLength(0);
    expect(r.hasBlockingConflict).toBe(false);
  });

  it('同一张卡有多个窗口时，选赶得上的那个，并保留备选', () => {
    const input: RoutePlanInput = {
      date: '2026-10-03',
      origin: A,
      speedKmh: 30,
      initialBufferMin: 0,
      candidates: [
        candidate('card-a', 'A卡', A, [
          win('card-a', 'a-early', '2026-10-03T07:30:00+08:00', '2026-10-03T08:00:00+08:00'),
          win('card-a', 'a-late', '2026-10-03T17:00:00+08:00', '2026-10-03T17:30:00+08:00'),
        ]),
        candidate('card-c', 'C卡', C, [win('card-c', 'c-noon', '2026-10-03T12:00:00+08:00', '2026-10-03T12:20:00+08:00')]),
      ],
    };
    const r = planRoute(input);
    // 先排时间最早且可达的：A 的 07:30 从 A 出发可达
    expect(r.stops[0].windowId).toBe('a-early');
    expect(r.stops[0].alternateOptionWindowIds).toContain('a-late');
  });

  it('通勤赶不到时产生 commute_unreachable 冲突并标记 blocking，不静默丢弃', () => {
    const input: RoutePlanInput = {
      date: '2026-10-03',
      origin: A,
      earliestDepartAt: '2026-10-03T06:00:00+08:00',
      speedKmh: 20,
      candidates: [
        candidate('card-c', 'C卡', C, [win('card-c', 'c1', '2026-10-03T06:05:00+08:00', '2026-10-03T06:20:00+08:00')]),
      ],
    };
    // A→C 约 21km，20km/h 要约 63 分钟；06:05 窗口从出发点赶不到
    const r = planRoute(input);
    expect(r.stops).toHaveLength(1);
    const kinds = r.conflicts.map((c) => c.kind);
    expect(kinds).toContain('commute_unreachable');
    const c = r.conflicts.find((x) => x.kind === 'commute_unreachable')!;
    expect(c.source).toBe('auto_plan');
    expect(c.evidence.distanceKm).toBeGreaterThan(15);
    expect(c.evidence.commuteMin).toBeGreaterThan(30);
    expect(r.hasBlockingConflict).toBe(true);
  });

  it('该日没有窗口的卡进入 dropped 并给原因', () => {
    const r = planRoute({
      date: '2026-10-03',
      origin: A,
      candidates: [
        candidate('card-x', 'X卡', A, [win('card-x', 'x1', '2026-10-04T08:00:00+08:00', '2026-10-04T08:30:00+08:00', 'good', '2026-10-04')]),
      ],
    });
    expect(r.stops).toHaveLength(0);
    expect(r.dropped[0].inspirationId).toBe('card-x');
  });
});

describe('routePlanner.validateManualOrder', () => {
  it('人工顺序通勤不成立时逐条指出，来源标记为 manual', () => {
    const conflicts = validateManualOrder(
      [
        {
          inspirationId: 'c',
          title: 'C卡',
          windowId: 'c1',
          startAt: new Date('2026-10-03T06:05:00+08:00').toISOString(),
          endAt: new Date('2026-10-03T06:20:00+08:00').toISOString(),
          location: C,
        },
      ],
      { origin: A, speedKmh: 20, earliestDepartAt: '2026-10-03T06:00:00+08:00' },
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('commute_unreachable');
    expect(conflicts[0].source).toBe('manual');
  });

  it('合理顺序无冲突', () => {
    const conflicts = validateManualOrder(
      [
        {
          inspirationId: 'a',
          title: 'A',
          windowId: 'a1',
          startAt: new Date('2026-10-03T08:00:00+08:00').toISOString(),
          endAt: new Date('2026-10-03T08:30:00+08:00').toISOString(),
          location: A,
        },
        {
          inspirationId: 'b',
          title: 'B',
          windowId: 'b1',
          startAt: new Date('2026-10-03T10:00:00+08:00').toISOString(),
          endAt: new Date('2026-10-03T10:30:00+08:00').toISOString(),
          location: B,
        },
      ],
      { origin: A, speedKmh: 30 },
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('routePlanner.diffWindowAssignment', () => {
  it('窗口因气象变化而换窗时产出 weather_shift 冲突并附旧/新依据', () => {
    const conflicts = diffWindowAssignment(
      [{ inspirationId: 'a', windowId: 'old', verdict: 'good' }],
      new Map([
        [
          'a',
          {
            windowId: 'new',
            verdict: 'marginal',
            reasons: [{ code: 'PRECIP_FAIL', text: '降水概率 70%（上限 30%）' }],
          },
        ],
      ]),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('weather_shift');
    expect(conflicts[0].source).toBe('weather_rescan');
    expect(conflicts[0].evidence.oldWindowId).toBe('old');
    expect(conflicts[0].evidence.newWindowId).toBe('new');
  });

  it('estimateCommuteMin 速度非法时给无穷大（保守，不当成可达）', () => {
    expect(estimateCommuteMin(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateCommuteMin(10, 30)).toBe(20);
  });
});
