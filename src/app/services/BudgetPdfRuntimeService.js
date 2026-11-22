import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBudgetPdfValidationService } from './BudgetPdfValidationService.js';
import { budgetError } from './BudgetContractService.js';

// Synthetic blank PDF, constructed with exact byte offsets; no external fixture dependency.
export function runtimeSmokePdf() {
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << >> >>',
  ].entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(body);
  return Buffer.from(
    `${body}xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
  );
}
export function createBudgetPdfRuntimeService({
  execute = promisify(execFile),
  validator = createBudgetPdfValidationService(),
} = {}) {
  let pending;
  async function check() {
    try {
      const { stdout } = await execute('/usr/bin/qpdf', ['--version'], {
        shell: false,
        timeout: 10000,
        maxBuffer: 65536,
        env: { LANG: 'C', LC_ALL: 'C' },
      });
      if (!/^qpdf version 12\.3\.2(?:\r?\n|$)/.test(stdout)) throw new Error();
      await validator.validate(runtimeSmokePdf());
      return { ready: true, version: '12.3.2' };
    } catch {
      throw budgetError('validatorUnavailable');
    }
  }
  return {
    // Called only by Feature 005 upload path. Never imported into global server startup.
    ensureUploadsReady() {
      pending ??= check().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
  };
}
