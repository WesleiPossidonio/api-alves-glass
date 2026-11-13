import assert from 'node:assert/strict'
import test from 'node:test'
import { createMinioClient } from '../../src/config/minio.js'

const credentials = { MINIO_ACCESS_KEY: 'test-access', MINIO_SECRET_KEY: 'test-secret' }

test('MinIO client reads endpoint, TLS and region from environment without connecting', () => {
  const client = createMinioClient({
    ...credentials,
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: '59000',
    MINIO_USE_SSL: 'false',
    MINIO_REGION: 'us-east-1',
  })
  assert.equal(client.host, '127.0.0.1')
  assert.equal(client.port, 59000)
  assert.equal(client.region, 'us-east-1')
})

test('MinIO TLS settings are strict and CA files require TLS', () => {
  assert.throws(() => createMinioClient({ ...credentials, MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000', MINIO_USE_SSL: 'yes' }), /MINIO_USE_SSL/)
  assert.throws(() => createMinioClient({ ...credentials, MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000', MINIO_CA_CERT_PATH: '/missing-ca.pem' }), /requires MINIO_USE_SSL/)
  assert.throws(() => createMinioClient({ ...credentials, MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000', MINIO_USE_SSL: 'true', MINIO_CA_CERT_PATH: '/missing-ca.pem' }), /ENOENT/)
})

test('MinIO client fails closed when endpoint or credentials are absent', () => {
  assert.throws(() => createMinioClient({ ...credentials, MINIO_PORT: '9000' }), /MINIO_ENDPOINT/)
  assert.throws(() => createMinioClient({ MINIO_ENDPOINT: 'localhost', MINIO_PORT: '9000' }), /MINIO_ACCESS_KEY/)
})