import { Router } from 'express';
import {
  confirmRouteStopSchema,
  createRouteSchema,
  manualReorderRouteSchema,
  resolveRouteConflictSchema,
  resequenceRouteSchema,
} from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate, currentUser } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import {
  confirmRouteStop,
  createRoute,
  getRouteDetail,
  listRoutes,
  manualReorderRoute,
  resolveRouteConflict,
  resequenceRoute,
} from '../services/routes.js';

export const routeRouter = Router();
routeRouter.use(authenticate());

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
    const user = currentUser(req);
    const input = createRouteSchema.parse(req.body);
    const id = createRoute(ctx.libraryId, input, user.id);
    ok(res, { id, ...getRouteDetail(id, ctx.libraryId) }, 201);
  }),
);

routeRouter.get(
  '/routes/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, getRouteDetail(req.params.id, ctx.libraryId));
  }),
);

/** 系统重排：按当前窗口判定 + 通勤估算重新选序，版本 +1 并留下来源 */
routeRouter.post(
  '/routes/:id/resequence',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    const input = resequenceRouteSchema.parse(req.body ?? {});
    const reasons = input.reason ? [`手动触发重排：${input.reason}`] : [];
    const result = resequenceRoute(req.params.id, ctx.libraryId, 'system_resequence', user.id, reasons);
    ok(res, { ...result, ...getRouteDetail(req.params.id, ctx.libraryId) });
  }),
);

/** 人工调序：顺序 + 取舍依据 + 当前版本，三者缺一不可 */
routeRouter.post(
  '/routes/:id/reorder',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    const input = manualReorderRouteSchema.parse(req.body);
    const result = manualReorderRoute(req.params.id, ctx.libraryId, input, user.id);
    ok(res, { ...result, ...getRouteDetail(req.params.id, ctx.libraryId) });
  }),
);

/**
 * 站点确认：baseVersion 落后于当前版本时返回 409，
 * 确认不会覆盖新顺序，只记录为 stale_confirmation 冲突。
 */
routeRouter.post(
  '/routes/:id/stops/:stopId/confirm',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = confirmRouteStopSchema.parse(req.body);
    const result = confirmRouteStop(req.params.id, req.params.stopId, input.baseVersion, {
      libraryId: ctx.libraryId,
      clientOpId: input.clientOpId,
      confirmedAt: input.confirmedAt,
    });
    if (result.stale) {
      throw errors.routeVersionStale({
        currentVersion: result.currentVersion,
        order: result.order,
        conflictId: result.conflictId,
      });
    }
    ok(res, result);
  }),
);

/** 冲突人工取舍：resolution + rationale（依据）必填 */
routeRouter.post(
  '/routes/:id/conflicts/:conflictId/resolve',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    const input = resolveRouteConflictSchema.parse(req.body);
    resolveRouteConflict(req.params.id, req.params.conflictId, ctx.libraryId, input, user.id);
    ok(res, { resolved: true, ...getRouteDetail(req.params.id, ctx.libraryId) });
  }),
);
