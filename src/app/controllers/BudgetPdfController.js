import { randomUUID } from 'node:crypto';
import createService from '../services/BudgetPdfCreateService.js';
import { BudgetPdfReadService } from '../services/BudgetPdfReadService.js';
import publishService from '../services/BudgetPdfPublishService.js';
import streamService from '../services/BudgetPdfStreamService.js';
import editService from '../services/BudgetPdfEditService.js';
import replacementService from '../services/BudgetPdfReplacementService.js';
import deleteService from '../services/BudgetPdfDeleteService.js';
import {
  budgetEtag,
  publicBudgetError,
  strictInput,
} from '../services/BudgetContractService.js';

export function budgetHttpError(response, error) {
  if (response.headersSent || response.destroyed) return;
  const safe = publicBudgetError(error);
  const code =
    { validation: 'invalidInput', notFound: 'budgetNotFound' }[
      safe.body.error
    ] ?? safe.body.error;
  return response.status(safe.status).json({
    error: {
      code,
      message: code,
      requestId: response.locals.budgetRequestId ?? randomUUID(),
    },
  });
}
export async function streamBudgetHttp(
  service,
  request,
  response,
  actor,
  client = false,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!response.writableFinished) abort();
  };
  request.once('aborted', abort);
  response.once('close', close);
  try {
    strictInput(request.query, client ? [] : ['slot']);
    await service.stream(
      {
        id: request.params.id,
        actor,
        ...(!client ? { slot: request.query.slot } : {}),
        ...(request.get('range') !== undefined
          ? { range: request.get('range') }
          : {}),
      },
      response,
      {
        signal: controller.signal,
        onReady(meta) {
          // The service currently supplies a UUID-derived name. Validate the
          // descriptor anyway: it is an HTTP header boundary and must fail closed.
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i.test(
              meta.filename,
            )
          ) {
            throw Object.assign(new Error('invalid delivery filename'), {
              code: 'storageUnavailable',
            });
          }
          response.status(meta.status);
          response.set({
            'Content-Type': 'application/pdf',
            'Content-Length': String(meta.length),
            'Accept-Ranges': meta.acceptRanges,
            'Content-Disposition': `attachment; filename="${meta.filename}"`,
            'Cache-Control': meta.cacheControl,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': meta.contentSecurityPolicy,
          });
          response.vary('Cookie');
          if (meta.contentRange)
            response.set('Content-Range', meta.contentRange);
          // Do not flush: pre-byte errors must still permit sanitized JSON503.
        },
      },
    );
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (!response.destroyed) {
      for (const header of [
        'Content-Length',
        'Content-Range',
        'Content-Disposition',
        'Accept-Ranges',
        'Content-Type',
      ])
        response.removeHeader(header);
      return budgetHttpError(response, error);
    }
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', close);
  }
}
export class BudgetPdfController {
  constructor({
    create = createService,
    read,
    publish = publishService,
    edit = editService,
    replace = replacementService,
    delete: deletion = deleteService,
    stream = streamService,
    env = process.env,
  } = {}) {
    this.create = create;
    this.publishService = publish;
    this.editService = edit;
    this.replacementService = replace;
    this.deleteService = deletion;
    this.stream = stream;
    this.read =
      read ??
      new BudgetPdfReadService({ cursorSecret: env.BUDGETS_CURSOR_SECRET });
  }
  actor(request) {
    return { id: request.userId, type: request.actorType };
  }
  async delete(request, response) {
    try {
      strictInput(request.query, []);
      const body = await this.deleteService.delete(
        request.params.id,
        request.body,
        this.actor(request),
        { ifMatch: request.get('if-match') },
      );
      return response.status(202).json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async edit(request, response) {
    try {
      strictInput(request.query, []);
      const body = await this.editService.edit(
        request.params.id,
        request.body,
        this.actor(request),
        { ifMatch: request.get('if-match') },
      );
      return response
        .set('ETag', budgetEtag(body.id, body.revision))
        .json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async replace(request, response) {
    try {
      strictInput(request.query, []);
      const body = await this.replacementService.replace(
        request.params.id,
        request.body,
        this.actor(request),
        request.file?.buffer,
        { ifMatch: request.get('if-match'), signal: request.budgetSignal },
      );
      if (request.budgetSignal?.aborted) return;
      return response
        .set('ETag', budgetEtag(body.id, body.revision))
        .json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async publish(request, response) {
    try {
      strictInput(request.query, []);
      const body = await this.publishService.publish(
        request.params.id,
        request.body,
        this.actor(request),
        { ifMatch: request.get('if-match') },
      );
      return response
        .set('ETag', budgetEtag(body.id, body.revision))
        .json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async pdf(request, response) {
    return streamBudgetHttp(
      this.stream,
      request,
      response,
      this.actor(request),
    );
  }
  async store(request, response) {
    try {
      const body = await this.create.create(
        request.body,
        this.actor(request),
        request.file?.buffer,
        { signal: request.budgetSignal },
      );
      if (request.budgetSignal?.aborted) return;
      return response
        .status(201)
        .location(`/budgets/${body.id}`)
        .set('ETag', budgetEtag(body.id, body.revision))
        .json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async index(request, response) {
    try {
      // Missing/invalid configuration is an operational failure, never a
      // session/MinIO secret fallback or a client validation error.
      if (
        !this.read.cursors &&
        (typeof this.read.cursorSecret !== 'string' ||
          Buffer.byteLength(this.read.cursorSecret) < 32)
      )
        return budgetHttpError(response, { code: 'storageUnavailable' });
      return response.json(
        await this.read.list(request.query, this.actor(request)),
      );
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
  async show(request, response) {
    try {
      strictInput(request.query, []);
      const body = await this.read.detail(
        request.params.id,
        this.actor(request),
      );
      return response
        .set('ETag', budgetEtag(body.id, body.revision))
        .json(body);
    } catch (error) {
      return budgetHttpError(response, error);
    }
  }
}
export default new BudgetPdfController();
