import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('MinIO cleanup job migration, model registration and concurrency/recovery DDL are documented', () => {
  const model = fs.readFileSync(path.join(root, 'src/app/models/MinioCleanupJob.js'), 'utf8')
  const proposal = fs.readFileSync(path.join(root, 'docs/feature-003-minio-cleanup-migration-proposal.md'), 'utf8')
  const initializer = fs.readFileSync(path.join(root, 'src/database/index.js'), 'utf8')
  assert.match(model, /class MinioCleanupJob extends Model/)
  for (const field of ['bucket', 'object_key', 'status', 'attempts', 'last_error', 'next_attempt_at', 'locked_at', 'locked_by', 'created_at', 'updated_at']) assert.ok(model.includes(field))
  assert.match(proposal, /FOR UPDATE SKIP LOCKED/)
  assert.match(proposal, /minio_cleanup_jobs_ready_idx/)
  assert.match(proposal, /minio_upload_intents/)
  assert.match(initializer, /MinioCleanupJob/)
  assert.ok(fs.readdirSync(path.join(root, 'src/database/migrations')).some(name => name === '20261117000000-add-material-images-and-minio-jobs.cjs'))
})