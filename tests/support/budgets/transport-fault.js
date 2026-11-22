import http from 'node:http';
import { once } from 'node:events';
import { createBudgetMinioClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { barrier } from './matrix-fixture.js';

// Real HTTP forwarding, preserving signed Host/path. Faults target only the next
// matching operation. No fake SDK response or fabricated storage success.
export async function transportFault() {
  const sockets = new Set(),
    upstreams = new Set();
  let fault;
  const server = http.createServer((req, res) => {
    const active = fault && fault.method === req.method ? fault : null;
    if (active) fault = null;
    if (active?.mode === 'before') {
      req.resume();
      req.once('end', () => {
        active.hit.release();
        req.socket.destroy();
      });
      return;
    }
    const upstream = http.request(
      {
        hostname: process.env.MINIO_ENDPOINT,
        port: Number(process.env.MINIO_PORT),
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (response) => {
        if (active?.mode === 'after') {
          response.resume();
          response.once('end', () => {
            active.hit.release();
            res.socket?.destroy();
          });
          return;
        }
        if (active?.mode === 'hold') {
          response.resume();
          active.hit.release();
          active.release.promise.then(() => res.socket?.destroy());
          return;
        }
        res.writeHead(response.statusCode, response.headers);
        if (active?.mode === 'stream') {
          response.once('data', (chunk) => {
            res.write(chunk.subarray(0, Math.min(1024, chunk.length)));
            active.hit.release();
            active.release.promise.then(() => {
              response.destroy();
              res.socket?.destroy();
            });
          });
          return;
        }
        response.pipe(res);
      },
    );
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => res.socket?.destroy());
    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createBudgetMinioClient(process.env),
    transport = client.transport;
  client.transport = {
    request(options, callback) {
      return transport.request(
        {
          ...options,
          hostname: '127.0.0.1',
          host: '127.0.0.1',
          port: server.address().port,
          headers: {
            ...options.headers,
            host: `${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`,
          },
        },
        callback,
      );
    },
  };
  return {
    client,
    arm(method, mode) {
      const hit = barrier(),
        release = barrier();
      fault = { method, mode, hit, release };
      return { hit: hit.promise, release: release.release };
    },
    async close() {
      const closed = [...sockets].map((socket) => once(socket, 'close'));
      for (const request of upstreams) request.destroy();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        ...closed,
      ]);
    },
    get openSockets() {
      return sockets.size;
    },
  };
}
