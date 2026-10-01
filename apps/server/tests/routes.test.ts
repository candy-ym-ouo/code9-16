import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import type { RouteDto } from '@flil/shared';

let app: Express;
let token = '';
let tmpDir = '';
const cards: { id: string; spotId: string }[] = [];

function call(method: 'get' | 'post' | 'put' | 'patch', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

/**
 * 直接造两张带机位 + 窗口的卡（在 beforeAll 内用 db 句柄写入，保证钟点确定性）。
 */
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-route-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'route-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { getDb, migrate, newId, nowIso, toJson } = await import('../src/db.js');
  migrate();
  app = createApp();

  const reg = await call('post', '/api/auth/register', {
    email: 'route@test.local',
    password: 'password123',
    displayName: '路线作者',
  });
  token = reg.body.token;

  // 直接写库构造确定性窗口，避免依赖天文/天气计算的具体钟点
  const db = getDb();
  const lib = db.prepare('SELECT id FROM library LIMIT 1').get() as { id: string };
  const mk = async (title: string, lat: number, lng: number, start: string, end: string, verdict: 'good' | 'marginal') => {
    const now = nowIso();
    const placeId = newId();
    db.prepare('INSERT INTO place (id, library_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').run(
      placeId, lib.id, `${title}地点`, now, now,
    );
    const spotId = newId();
    db.prepare(
      'INSERT INTO spot (id, library_id, place_id, lat, lng, camera_bearing, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(spotId, lib.id, placeId, lat, lng, 0, now, now);
    const inspirationId = newId();
    db.prepare(
      `INSERT INTO inspiration (id, library_id, title, status, spot_id, created_at, updated_at)
       VALUES (?,?,?, 'ready', ?, ?, ?)`,
    ).run(inspirationId, lib.id, title, spotId, now, now);
    const date = start.slice(0, 10);
    db.prepare(
      `INSERT INTO repro_window (id, library_id, inspiration_id, date, start_at, end_at, anchor_at,
         verdict, reasons, weather_degraded, stale, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,?)`,
    ).run(
      newId(), lib.id, inspirationId, date,
      new Date(start).toISOString(), new Date(end).toISOString(), new Date(start).toISOString(),
      verdict, toJson([{ code: 'OK', level: 'ok', text: '可拍' }]), now,
    );
    cards.push({ id: inspirationId, spotId });
  };

  // A 近处 06:00 窗口；B 约 20km 外 06:05 窗口（20km/h 赶不到）
  await mk('清晨连廊', 31.2471, 121.4726, '2026-10-03T06:00:00+08:00', '2026-10-03T06:30:00+08:00', 'good');
  await mk('远处天台', 31.4, 121.6, '2026-10-03T06:05:00+08:00', '2026-10-03T06:25:00+08:00', 'good');
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('R1 取景路线：多窗口 + 通勤重排', () => {
  let routeId = '';
  let version = 1;

  it('规划预览给出顺序与通勤冲突（冲突带来源与依据）', async () => {
    const res = await call('post', '/api/routes/preview', {
      date: '2026-10-03',
      origin: { lat: 31.2471, lng: 121.4726 },
      earliestDepartAt: '2026-10-03T06:00:00+08:00',
      speedKmh: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body.stops).toHaveLength(2);
    expect(res.body.stops[0].inspirationId).toBe(cards[0].id); // 近处先拍
    const commute = res.body.conflicts.find((c: { kind: string }) => c.kind === 'commute_unreachable');
    expect(commute).toBeTruthy();
    expect(commute.source).toBe('auto_plan');
    expect(commute.evidence.distanceKm).toBeGreaterThan(15);
    expect(res.body.hasBlockingConflict).toBe(true);
  });

  it('创建路线落库，冲突同步留痕', async () => {
    const res = await call('post', '/api/routes', {
      title: '10月3日清晨线',
      date: '2026-10-03',
      origin: { lat: 31.2471, lng: 121.4726 },
      earliestDepartAt: '2026-10-03T06:00:00+08:00',
      speedKmh: 20,
    });
    expect(res.status).toBe(201);
    routeId = res.body.id;
    version = res.body.version;
    const item = res.body.item as RouteDto;
    expect(item.stops).toHaveLength(2);
    expect(item.conflicts.filter((c) => c.kind === 'commute_unreachable').length).toBeGreaterThan(0);
  });

  it('人工改序：错误版本号被 409 拒绝（不覆盖）', async () => {
    const res = await call('post', `/api/routes/${routeId}/reorder`, {
      baseVersion: version + 99,
      orderedInspirationIds: [cards[1].id, cards[0].id],
      rationale: '故意拿旧版本改序',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROUTE_VERSION_CONFLICT');
    expect(res.body.error.details.currentVersion).toBe(version);
  });

  it('人工改序：正确版本 + 取舍依据被接受，版本号 +1 并留 manual 痕迹', async () => {
    const res = await call('post', `/api/routes/${routeId}/reorder`, {
      baseVersion: version,
      orderedInspirationIds: [cards[1].id, cards[0].id],
      rationale: '远处天台的光只在 06:05，宁可提前 1 小时出门也要先拍它',
    });
    expect(res.status).toBe(200);
    const item = res.body.item as RouteDto;
    expect(item.version).toBe(version + 1);
    version = item.version;
    expect(item.stops[0].inspirationId).toBe(cards[1].id);
    const manual = item.conflicts.find((c) => c.kind === 'manual_reorder');
    expect(manual).toBeTruthy();
    expect((manual!.evidence as { rationale: string }).rationale).toContain('提前 1 小时');
  });
});

describe('R2 离线晚到确认不得覆盖新顺序', () => {
  let routeId = '';
  let version = 1;
  let stopId = '';

  it('准备一条两站路线', async () => {
    const res = await call('post', '/api/routes', {
      title: '离线线',
      date: '2026-10-03',
      origin: { lat: 31.2471, lng: 121.4726 },
      earliestDepartAt: '2026-10-03T05:00:00+08:00',
      speedKmh: 60,
    });
    expect(res.status).toBe(201);
    routeId = res.body.id;
    version = res.body.version;
    stopId = (res.body.item as RouteDto).stops[0].id;
    // 模拟离线期间路线被重排过一次 → version 前进
    const re = await call('post', `/api/routes/${routeId}/reorder`, {
      baseVersion: version,
      orderedInspirationIds: (res.body.item as RouteDto).stops.map((s) => s.inspirationId),
      rationale: '离线期间人工微调顺序（顺序相同但产生新版本）',
    });
    expect(re.status).toBe(200);
    version = re.body.item.version;
  });

  it('离线晚到确认（无 baseVersion）落在旧顺序上 → 挂起，不写到达、不覆盖', async () => {
    const res = await call('post', `/api/routes/${routeId}/stops/${stopId}/arrive`, {
      clientOpId: 'offline-arrive-0001',
      arrivedAt: '2026-10-03T06:31:00+08:00',
      late: true,
    });
    expect(res.status).toBe(200);
    const pending = await call('get', `/api/routes-pending?routeId=${routeId}`);
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].action).toBe('arrive');
    expect(pending.body.items[0].currentVersion).toBe(version);

    const detail = await call('get', `/api/routes/${routeId}`);
    const stop = (detail.body.item as RouteDto).stops.find((s: { id: string }) => s.id === stopId)!;
    expect(stop.status).toBe('planned'); // 没有被盖成 arrived
    expect(detail.body.item.needsReview).toBe(true);
    const stale = detail.body.item.conflicts.find((c: { kind: string }) => c.kind === 'offline_stale');
    expect(stale).toBeTruthy();
    expect(stale.source).toBe('offline');
  });

  it('同一 clientOpId 重复提交保持幂等（不重复挂起）', async () => {
    await call('post', `/api/routes/${routeId}/stops/${stopId}/arrive`, {
      clientOpId: 'offline-arrive-0001',
      arrivedAt: '2026-10-03T06:31:00+08:00',
      late: true,
    });
    const pending = await call('get', `/api/routes-pending?routeId=${routeId}`);
    expect(pending.body.items).toHaveLength(1);
  });

  it('在线确认携带过期 baseVersion → 直接 409', async () => {
    const res = await call('post', `/api/routes/${routeId}/stops/${stopId}/arrive`, {
      baseVersion: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROUTE_VERSION_CONFLICT');
  });

  it('人工把挂起确认应用到当前顺序中同一张卡的停靠，并写取舍依据', async () => {
    const pending = await call('get', `/api/routes-pending?routeId=${routeId}`);
    const pid = pending.body.items[0].id;
    const res = await call('post', `/api/routes-pending/${pid}/resolve`, {
      decision: 'apply',
      basis: '核对新顺序后，该卡确实已到，确认作用到当前停靠',
    });
    expect(res.status).toBe(200);
    const item = res.body.item as RouteDto;
    const target = item.stops.find((s) => s.id === stopId)!;
    expect(['arrived', 'late']).toContain(target.status);
    const stale = item.conflicts.find((c) => c.kind === 'offline_stale')!;
    expect(stale.status).toBe('resolved');
    expect(stale.resolutionBasis).toContain('核对新顺序');
  });
});

describe('R3 冲突人工取舍必须给依据', () => {
  it('解决冲突时空依据被 400 拒绝', async () => {
    const list = await call('get', '/api/routes');
    const route = (list.body.items as RouteDto[]).find((r) => r.title === '10月3日清晨线')!;
    const open = route.conflicts.find((c) => c.status === 'open');
    if (open) {
      const res = await call('post', `/api/routes/${route.id}/conflicts/${open.id}/resolve`, {
        resolution: 'keep_auto',
        basis: '',
      });
      expect(res.status).toBe(400);
    }
  });
});
