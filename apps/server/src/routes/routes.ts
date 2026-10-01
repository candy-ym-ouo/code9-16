import { Router } from 'express';
import { z } from 'zod';
import {
  acceptWeatherRescan,
  changeStopWindow,
  createRoute,
  getRoute,
  listPendingConfirmations,
  listRoutes,
  markArrived,
  previewPlan,
  reorderRoute,
  rescanWeather,
  resolveConflict,
  resolvePendingConfirmation,
} from '../services/routes.js';
import {
  arriveStopSchema,
  changeStopWindowSchema,
  createRouteSchema,
  previewRouteSchema,
  reorderRouteSchema,
  rescanRouteWeatherSchema,
  resolvePendingConfirmationSchema,
  resolveRouteConflictSchema,
} from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { currentUser } from '../http/middleware.js';
import type { WindowVerdict } from '@flil/shared';

export const routeRouter = Router();
routeRouter.use(authenticate());

function specFrom(body: z.infer<typeof previewRouteSchema>) {
  return {
    date: body.date,
    inspirationIds: body.inspirationIds ?? [],
    origin: body.origin ?? null,
    earliestDepartAt: body.earliestDepartAt ?? null,
    speedKmh: body.speedKmh ?? 25,
    slackMin: body.slackMin ?? 0,
    initialBufferMin: body.initialBufferMin ?? 0,
    minVerdict: (body.minVerdict ?? 'marginal') as WindowVerdict,
  };
}

/** 预览：不落库，返回排好的顺序 + 全部时段/通勤冲突 */
routeRouter.post(
  '/routes/preview',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = previewRouteSchema.parse(req.body);
    const { result, candidateCount } = previewPlan(ctx.libraryId, specFrom(body));
    ok(res, { ...result, candidateCount });
  }),
);

routeRouter.get(
  '/routes',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, { items: listRoutes(ctx.libraryId) });
  }),
);

routeRouter.post(
  '/routes',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = createRouteSchema.parse(req.body);
    const { id, version } = createRoute(ctx.libraryId, { ...specFrom(body), title: body.title });
    ok(res, { id, version, item: getRoute(ctx.libraryId, id) }, 201);
  }),
);

routeRouter.get(
  '/routes/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, { item: getRoute(ctx.libraryId, req.params.id) });
  }),
);

/** 人工改序（baseVersion 乐观锁；通勤冲突留痕且必须写取舍依据） */
routeRouter.post(
  '/routes/:id/reorder',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = reorderRouteSchema.parse(req.body);
    const item = reorderRoute(ctx.libraryId, req.params.id, currentUser(req).id, body);
    ok(res, { item });
  }),
);

routeRouter.post(
  '/routes/:id/stops/:stopId/window',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = changeStopWindowSchema.parse(req.body);
    const item = changeStopWindow(ctx.libraryId, req.params.id, currentUser(req).id, {
      ...body,
      stopId: req.params.stopId,
    });
    ok(res, { item });
  }),
);

/** 气象重算 + 重排：换窗则 needs_review，等人确认后才视为接受新顺序 */
routeRouter.post(
  '/routes/:id/rescan-weather',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = rescanRouteWeatherSchema.parse(req.body);
    const { changed, route } = await rescanWeather(ctx.libraryId, req.params.id, body.baseVersion);
    ok(res, { changed, item: route });
  }),
);

routeRouter.post(
  '/routes/:id/accept-rescan',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const { basis } = z.object({ basis: z.string().min(1).max(500) }).parse(req.body);
    const item = acceptWeatherRescan(ctx.libraryId, req.params.id, currentUser(req).id, basis);
    ok(res, { item });
  }),
);

/** 到达确认：在线带 baseVersion 走乐观锁；离线带 clientOpId 过期则挂起 */
routeRouter.post(
  '/routes/:id/stops/:stopId/arrive',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = arriveStopSchema.parse(req.body ?? {});
    const result = markArrived(ctx.libraryId, req.params.id, currentUser(req).id, req.params.stopId, body);
    ok(res, result);
  }),
);

/** 解决单条冲突（保留自动顺序 / 采纳人工顺序 / 忽略），必须给取舍依据 */
routeRouter.post(
  '/routes/:id/conflicts/:conflictId/resolve',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = resolveRouteConflictSchema.parse(req.body);
    const item = resolveConflict(ctx.libraryId, req.params.id, req.params.conflictId, currentUser(req).id, body);
    ok(res, { item });
  }),
);

routeRouter.get(
  '/routes-pending',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const routeId = req.query.routeId as string | undefined;
    ok(res, { items: listPendingConfirmations(ctx.libraryId, routeId) });
  }),
);

routeRouter.post(
  '/routes-pending/:pendingId/resolve',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const body = resolvePendingConfirmationSchema.parse(req.body);
    const item = resolvePendingConfirmation(ctx.libraryId, req.params.pendingId, currentUser(req).id, body);
    ok(res, { item });
  }),
);
