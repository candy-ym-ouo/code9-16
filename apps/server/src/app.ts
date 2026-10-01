import express, { type Express } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { fail } from './http/respond.js';
import { requestId, requestLog } from './http/middleware.js';
import { ApiError } from './http/errors.js';
import { authRouter } from './routes/auth.js';
import { libraryRouter } from './routes/library.js';
import { inspirationRouter } from './routes/inspirations.js';
import { timingRouter } from './routes/timing.js';
import { workflowRouter } from './routes/workflow.js';
import { albumRouter } from './routes/albums.js';
import { searchRouter } from './routes/search.js';
import { shareRouter, publicShareRouter } from './routes/share.js';
import { opsRouter } from './routes/ops.js';
import { routeRouter } from './routes/routes.js';

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: [config.webOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);
  app.use(requestLog);

  app.use('/api', authRouter);
  // 公开分享必须排在带全局鉴权的 opsRouter 之前，否则会被鉴权拦死
  app.use('/api', publicShareRouter);
  app.use('/api', opsRouter);
  app.use('/api', libraryRouter);
  app.use('/api', inspirationRouter);
  app.use('/api', timingRouter);
  app.use('/api', workflowRouter);
  app.use('/api', albumRouter);
  app.use('/api', searchRouter);
  app.use('/api', routeRouter);
  app.use('/api', shareRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在', details: {} } });
  });

  // 生产：同端口托管前端构建产物（SPA fallback）
  const webDist = path.resolve(config.repoRoot, 'apps/web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('电影取景灵感库 API 已启动。前端开发服务器：http://localhost:5173');
    });
  }

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ApiError) {
        fail(res, err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ZodError') || (err as { name?: string })?.name === 'ZodError') {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: '请求参数校验失败', details: { raw: message } },
        });
        return;
      }
      fail(res, err);
    },
  );

  return app;
}
