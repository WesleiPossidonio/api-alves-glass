// Test-only process: real authentication, repositories and private storage.
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { once } from 'node:events';
import { matrixFixture } from './matrix-fixture.js';
import AuthSession from '../../../src/app/models/AuthSession.js';
import User from '../../../src/app/models/User.js';
import { ClientBudgetPdfController } from '../../../src/app/controllers/ClientBudgetPdfController.js';
import { ClientBudgetPdfService } from '../../../src/app/services/ClientBudgetPdfService.js';
import { BudgetPdfStreamService } from '../../../src/app/services/BudgetPdfStreamService.js';
import { createBudgetPdfRouter } from '../../../src/app/meddleawares/budgetPdfHttp.js';

const f = await matrixFixture();
f.db.options.define.underscored = true;
AuthSession.init(f.db);
User.init(f.db);
const deps = {
  budgets: f.budgets,
  objects: f.objects,
  authorization: f.authorization,
  storage: f.storage,
};
const app = express();
app.use(cookieParser());
app.use(
  '/client/budgets',
  createBudgetPdfRouter({
    client: true,
    transport: new ClientBudgetPdfController({
      read: new ClientBudgetPdfService({
        ...deps,
        cursorSecret: 'isolated-http-restart-cursor-secret-32-bytes',
      }),
      stream: new BudgetPdfStreamService(deps),
    }),
  }),
);
const server = http.createServer(app).listen(0, '127.0.0.1');
await once(server, 'listening');
process.send({ port: server.address().port, pid: process.pid });
process.on('SIGTERM', async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await f.db.close();
  process.disconnect();
});
