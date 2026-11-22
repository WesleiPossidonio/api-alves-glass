import multer from 'multer';
import { Transform } from 'node:stream';
import { budgetHttpError } from '../controllers/BudgetPdfController.js';

let active = 0;
const fields = new Set([
  'sectorId',
  'clientId',
  'commercialNumber',
  'administrativeName',
  'validityDate',
]);
// Bounded memory storage: no upload files on disk; qpdf owns its separate
// private temporary lifecycle. Two requests reserve at most 22MiB wire buffers.
export function createBudgetPdfUpload({ timeoutMs = 30000 } = {}) {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024 + 1,
      files: 1,
      fields: 5,
      parts: 7,
      fieldNameSize: 64,
      fieldSize: 4096,
      headerPairs: 100,
    },
  }).single('file');
  return (request, response, next) => {
    if (!request.is('multipart/form-data'))
      return budgetHttpError(response, { code: 'validation' });
    if (Number(request.headers['content-length']) > 11 * 1024 * 1024)
      return budgetHttpError(response, { code: 'fileTooLarge' });
    if (active >= 2)
      return budgetHttpError(response, { code: 'resourceLimit' });
    active++;
    const controller = new AbortController();
    request.budgetSignal = controller.signal;
    let total = 0,
      finished = false;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        total += chunk.length;
        if (total > 11 * 1024 * 1024)
          callback(
            Object.assign(new Error('fileTooLarge'), { code: 'fileTooLarge' }),
          );
        else callback(null, chunk);
      },
    });
    counter.headers = request.headers;
    counter.method = request.method;
    const clear = () => {
      if (finished) return;
      finished = true;
      active--;
      clearTimeout(timer);
      request.off('aborted', abort);
      response.off('close', close);
      request.unpipe(counter);
      counter.destroy();
      if (request.file) request.file.buffer = undefined;
      if (counter.file) counter.file.buffer = undefined;
      counter.body = undefined;
      request.body = undefined;
    };
    const fail = (code) => {
      if (finished) return;
      controller.abort();
      budgetHttpError(response, { code });
      clear();
      request.resume();
    };
    const abort = () => {
      controller.abort();
      counter.destroy();
      clear();
    };
    const close = () => {
      if (!response.writableFinished) controller.abort();
      clear();
    };
    const timer = setTimeout(() => fail('storageUnavailable'), timeoutMs);
    request.once('aborted', abort);
    response.once('close', close);
    response.once('finish', clear);
    counter.on('error', (error) =>
      fail(error.code === 'fileTooLarge' ? 'fileTooLarge' : 'validation'),
    );
    parse(counter, response, (error) => {
      if (finished) return;
      if (error)
        return fail(
          error.code === 'LIMIT_FILE_SIZE' ? 'fileTooLarge' : 'validation',
        );
      request.body = counter.body;
      request.file = counter.file;
      if (request.file?.size > 10 * 1024 * 1024) return fail('fileTooLarge');
      if (
        !request.body ||
        Object.entries(request.body).some(
          ([key, value]) => !fields.has(key) || typeof value !== 'string',
        )
      )
        return fail('validation');
      next();
    });
    request.pipe(counter);
  };
}
export default createBudgetPdfUpload();
