import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 取景路线：重排来源 / 离线晚到确认防覆盖 / 时段冲突人工取舍。
 * 场景：两个机位相距约 100km，窗口分别为 16:00±30min 与 17:00±30min（本地时间），
 * 通勤估算约 3.8 小时 → 必然产生时段冲突，用于验证冲突来源与取舍留痕。
 */

let app: Express;
let token = '';
let tmpDir = '';
let routeId = '';
let stopAId = ''; // 16:00 窗口的站
let stopBId = ''; // 17:00 窗口的站
let inspirationA = '';
let inspirationB = '';
let windowBId = '';
let routeDate = '';
let commuteConflictId = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function makeCard(title: string, lat: number, lng: number, clockMin: number): Promise<string> {
  const place = await call('post', '/api/places', { name: `${title}地点`, city: '上海' });
  const spot = await call('post', '/api/spots', {
    placeId: place.body.id,
    lat,
    lng,
    cameraBearing: 270,
  });
  const card = await call('post', '/api/inspirations', { title });
  await call('post', `/api/inspirations/${card.body.id}/spot`, { spotId: spot.body.id });
  await call('put', `/api/inspirations/${card.body.id}/timing`, {
    timeAnchor: 'fixed_clock',
    anchorOffsetMin: clockMin,
    elevationRange: [-90, 90],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 30,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
  });
  const wins = await call('post', `/api/inspirations/${card.body.id}/windows/recompute`, { days: 3 });
  expect(wins.status).toBe(200);
  return card.body.id;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-routes-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const reg = await call('post', '/api/auth/register', {
    email: 'router@test.local',
    password: 'password123',
    displayName: '路线测试',
  });
  token = reg.body.token;

  // 两个机位相距约 100km（经度差 1.1°）
  inspirationA = await makeCard('西岸连廊', 31.2, 121.4, 16 * 60);
  inspirationB = await makeCard('东滩芦苇', 31.2, 122.5, 17 * 60);
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function goodWindowOf(inspirationId: string): Promise<{ id: string; date: string }> {
  const res = await call('get', `/api/inspirations/${inspirationId}/windows?days=3`);
  const win = (res.body.items as { id: string; date: string; verdict: string }[]).find(
    (w) => w.verdict === 'good',
  );
  expect(win).toBeTruthy();
  return win!;
}

describe('R1 建路线即重排：顺序、通勤与来源快照', () => {
  it('把同日两个计划组成路线，按窗口先后排序并记录来源', async () => {
    const wa = await goodWindowOf(inspirationA);
    const wb = await goodWindowOf(inspirationB);
    expect(wa.date).toBe(wb.date);
    routeDate = wa.date;
    windowBId = wb.id;

    const planA = await call('post', '/api/plans', { windowId: wa.id, commuteMin: 30 });
    const planB = await call('post', '/api/plans', { windowId: wb.id, commuteMin: 30 });
    expect(planA.status).toBe(201);

    const created = await call('post', '/api/routes', {
      title: '周六双机位',
      date: routeDate,
      planIds: [planB.body.id, planA.body.id], // 故意乱序传入
      originText: '家',
    });
    expect(created.status).toBe(201);
    routeId = created.body.id;

    const detail = created.body;
    expect(detail.item.version).toBe(1);
    expect(detail.item.stops).toHaveLength(2);
    // 16:00 的站应排在 17:00 之前
    expect(detail.item.stops[0].inspirationTitle).toBe('西岸连廊');
    expect(detail.item.stops[1].inspirationTitle).toBe('东滩芦苇');
    stopAId = detail.item.stops[0].id;
    stopBId = detail.item.stops[1].id;

    // 通勤来源：首站用计划通勤，第二站用距离估算（约 100km → 200+ 分钟）
    expect(detail.item.stops[0].commuteSource).toBe('plan');
    expect(detail.item.stops[1].commuteSource).toBe('estimate');
    expect(detail.item.stops[1].commuteFromPrevMin).toBeGreaterThan(180);

    // 版本记录必须带来源快照：窗口判定 + 通勤段 + 触发源
    expect(detail.revisions).toHaveLength(1);
    const rev = detail.revisions[0];
    expect(rev.trigger).toBe('create');
    expect(rev.inputs.windows).toHaveLength(2);
    expect(rev.inputs.windows.every((w: { verdict: string }) => w.verdict === 'good')).toBe(true);
    expect(rev.inputs.legs.length).toBe(2);
    expect(rev.reasons.some((r: string) => r.includes('通勤'))).toBe(true);
  });

  it('100km 通勤赶不上 17:00 窗口 → 开出时段冲突并带来源', async () => {
    const detail = await call('get', `/api/routes/${routeId}`);
    const open = (detail.body.conflicts as { id: string; kind: string; status: string; summary: string; sources: { type: string; minutes?: number; verdict?: string }[] }[]).filter(
      (c) => c.status === 'open',
    );
    expect(open.length).toBeGreaterThan(0);
    const c = open[0];
    commuteConflictId = c.id;
    expect(c.kind).toBe('commute_insufficient');
    // 来源：两个窗口 + 一段通勤，缺一不可
    expect(c.sources.filter((s) => s.type === 'window')).toHaveLength(2);
    const leg = c.sources.find((s) => s.type === 'commute');
    expect(leg?.minutes).toBeGreaterThan(180);
    expect(c.summary).toContain('东滩芦苇');
  });
});

describe('R2 冲突必须人工取舍（依据必填）', () => {
  it('缺少依据 → 400', async () => {
    const res = await call('post', `/api/routes/${routeId}/conflicts/${commuteConflictId}/resolve`, {
      resolution: 'accept_current',
      rationale: '',
    });
    expect(res.status).toBe(400);
  });

  it('给出依据后关闭，依据留痕', async () => {
    const res = await call('post', `/api/routes/${routeId}/conflicts/${commuteConflictId}/resolve`, {
      resolution: 'accept_current',
      rationale: '东滩日落前景色可放弃，保西岸黄金时刻',
    });
    expect(res.status).toBe(200);
    const c = (res.body.conflicts as { id: string; status: string; rationale: string | null }[]).find(
      (x) => x.id === commuteConflictId,
    );
    expect(c?.status).toBe('resolved');
    expect(c?.rationale).toContain('保西岸');
  });
});

describe('R3 离线晚到确认不得覆盖新顺序', () => {
  it('当前版本确认 → 生效', async () => {
    const res = await call('post', `/api/routes/${routeId}/stops/${stopAId}/confirm`, { baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });

  it('人工调序（带依据）→ 版本 +1，顺序交换', async () => {
    const res = await call('post', `/api/routes/${routeId}/reorder`, {
      stopIds: [stopBId, stopAId],
      rationale: '东滩潮汐只在傍晚前可进，宁可压缩西岸',
      baseVersion: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.item.version).toBe(2);
    expect(res.body.item.stops[0].id).toBe(stopBId);
    const rev = (res.body.revisions as { trigger: string; reasons: string[] }[])[0];
    expect(rev.trigger).toBe('manual_reorder');
    expect(rev.reasons.join('')).toContain('东滩潮汐');
  });

  it('旧版本的调序请求 → 409，顺序不变', async () => {
    const res = await call('post', `/api/routes/${routeId}/reorder`, {
      stopIds: [stopAId, stopBId],
      rationale: '基于过期页面提交的调序',
      baseVersion: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROUTE_VERSION_STALE');
    const detail = await call('get', `/api/routes/${routeId}`);
    expect(detail.body.item.stops[0].id).toBe(stopBId);
  });

  it('旧版本的确认 → 409 + 晚到确认冲突，顺序不被覆盖', async () => {
    const res = await call('post', `/api/routes/${routeId}/stops/${stopBId}/confirm`, {
      baseVersion: 1,
      clientOpId: 'offline-confirm-0001',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROUTE_VERSION_STALE');
    expect(res.body.error.details.currentVersion).toBe(2);

    const detail = await call('get', `/api/routes/${routeId}`);
    // 顺序未被覆盖
    expect(detail.body.item.stops[0].id).toBe(stopBId);
    // 站点未被确认
    const stopB = (detail.body.item.stops as { id: string; confirmedAt: string | null }[]).find(
      (s) => s.id === stopBId,
    );
    expect(stopB?.confirmedAt).toBeNull();
    // 冲突已开单，来源指向客户端操作与两个版本号
    const stale = (detail.body.conflicts as { kind: string; status: string; sources: { type: string; baseVersion?: number; currentVersion?: number; clientOpId?: string }[] }[]).find(
      (c) => c.kind === 'stale_confirmation' && c.status === 'open',
    );
    expect(stale).toBeTruthy();
    const src = stale!.sources.find((s) => s.type === 'client_op');
    expect(src?.baseVersion).toBe(1);
    expect(src?.currentVersion).toBe(2);
    expect(src?.clientOpId).toBe('offline-confirm-0001');
  });

  it('离线补录通道同样走版本闸门，且幂等', async () => {
    const op = {
      clientOpId: 'offline-confirm-0002',
      opType: 'confirm_route_stop',
      payload: { routeId, stopId: stopBId, baseVersion: 1 },
    };
    const first = await call('post', '/api/offline/apply', op);
    expect(first.status).toBe(201);
    expect(first.body.result.applied).toBe(false);
    expect(first.body.result.stale).toBe(true);
    expect(first.body.result.currentVersion).toBe(2);

    const dup = await call('post', '/api/offline/apply', op);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);

    // 顺序仍未被覆盖
    const detail = await call('get', `/api/routes/${routeId}`);
    expect(detail.body.item.stops[0].id).toBe(stopBId);
  });

  it('人工取舍：接受晚到确认 → 站点被确认，冲突关闭', async () => {
    const detail = await call('get', `/api/routes/${routeId}`);
    const stale = (detail.body.conflicts as { id: string; kind: string; status: string }[]).find(
      (c) => c.kind === 'stale_confirmation' && c.status === 'open',
    );
    const res = await call('post', `/api/routes/${routeId}/conflicts/${stale!.id}/resolve`, {
      resolution: 'apply_stale_confirmation',
      rationale: '电话核实：人确实 16:50 到过东滩，只是当时离线',
    });
    expect(res.status).toBe(200);
    const stopB = (res.body.item.stops as { id: string; confirmedAt: string | null }[]).find(
      (s) => s.id === stopBId,
    );
    expect(stopB?.confirmedAt).toBeTruthy();
  });
});

describe('R4 气象变化触发重排并留来源', () => {
  it('窗口判定转差 → 路线自动重排 + 气象冲突开单', async () => {
    const { getDb } = await import('../src/db.js');
    const { handleWindowVerdictChange } = await import('../src/services/routes.js');
    // 模拟下一次窗口重算的结果：东滩窗口因降水转差
    getDb()
      .prepare('UPDATE repro_window SET verdict = ?, reasons = ? WHERE id = ?')
      .run(
        'bad',
        JSON.stringify([{ code: 'PRECIP_FAIL', level: 'bad', text: '降水概率 70%（上限 20%）' }]),
        windowBId,
      );
    const before = await call('get', `/api/routes/${routeId}`);
    handleWindowVerdictChange(inspirationB, [{ date: routeDate, from: 'good', to: 'bad' }]);

    const after = await call('get', `/api/routes/${routeId}`);
    expect(after.body.item.version).toBe(before.body.item.version + 1);
    const rev = (after.body.revisions as { trigger: string; reasons: string[] }[])[0];
    expect(rev.trigger).toBe('weather_change');
    expect(rev.reasons.join('')).toContain('东滩芦苇');
    expect(rev.reasons.join('')).toContain('不可拍');

    const weather = (after.body.conflicts as { kind: string; status: string; summary: string; sources: { type: string; verdict?: string }[] }[]).find(
      (c) => c.kind === 'weather_turned_bad' && c.status === 'open',
    );
    expect(weather).toBeTruthy();
    expect(weather!.summary).toContain('降水概率 70%');
    const winSrc = weather!.sources.find((s) => s.type === 'window');
    expect(winSrc?.verdict).toBe('bad');
  });

  it('取舍：移除气象转差的站 → 路线只剩一站，冲突关闭', async () => {
    const detail = await call('get', `/api/routes/${routeId}`);
    const weather = (detail.body.conflicts as { id: string; kind: string; status: string }[]).find(
      (c) => c.kind === 'weather_turned_bad' && c.status === 'open',
    );
    const res = await call('post', `/api/routes/${routeId}/conflicts/${weather!.id}/resolve`, {
      resolution: 'drop_stop',
      stopId: stopBId,
      rationale: '降水概率 70% 超过硬性上限，东滩改期到下周',
    });
    expect(res.status).toBe(200);
    expect(res.body.item.stops).toHaveLength(1);
    expect(res.body.item.stops[0].id).toBe(stopAId);
    const closed = (res.body.conflicts as { id: string; status: string; resolution: string | null }[]).find(
      (c) => c.id === weather!.id,
    );
    expect(closed?.status).toBe('resolved');
    expect(closed?.resolution).toBe('drop_stop');
  });
});
