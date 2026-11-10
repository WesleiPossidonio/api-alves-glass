import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const readProjectFile = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')

test('T006 mantém Compose legado separado do Compose complementar de rebuild e test', () => {
  const legacyCompose = readProjectFile('docker-compose.yml')
  const isolatedCompose = readProjectFile('docker-compose.persistence.yml')

  assert.match(legacyCompose, /container_name:\s*postgres-alves-glass/)
  assert.match(legacyCompose, /postgres_data:\/var\/lib\/postgresql\/data/)
  assert.match(legacyCompose, /"5432:5432"/)

  assert.match(isolatedCompose, /image:\s*postgres:17/g)
  assert.match(isolatedCompose, /api-dev:/)
  assert.match(isolatedCompose, /api-test:/)
  assert.match(isolatedCompose, /container_name:\s*postgres-alves-glass-rebuild/)
  assert.match(isolatedCompose, /container_name:\s*postgres-alves-glass-test/)
  assert.match(isolatedCompose, /postgres_rebuild_data:\/var\/lib\/postgresql\/data/)
  assert.match(isolatedCompose, /postgres_test_data:\/var\/lib\/postgresql\/data/)
  assert.match(isolatedCompose, /REBUILD_POSTGRES_HOST_PORT:-5433/)
  assert.match(isolatedCompose, /TEST_POSTGRES_HOST_PORT:-5434/)
  assert.match(isolatedCompose, /persistence-rebuild-network/)
  assert.match(isolatedCompose, /persistence-test-network/)
  assert.doesNotMatch(isolatedCompose, /^\s*container_name:\s*postgres-alves-glass\s*$/m)
  assert.doesNotMatch(isolatedCompose, /postgres_data|app-network|src\/database\/migrations|sequelize-cli|db:migrate|bootstrap|down -v/i)
})

test('T006 usa credenciais somente por variáveis locais e não cria autorização operacional por template', () => {
  const compose = readProjectFile('docker-compose.persistence.yml')
  const environmentTemplate = readProjectFile('.env.persistence-containers.example')
  const identityDocumentation = readProjectFile('docs/architecture/persistence-container-isolation.md')

  const passwordLines = compose.split('\n').filter(line => line.includes('POSTGRES_PASSWORD:'))
  assert.deepEqual(passwordLines, [
    '      POSTGRES_PASSWORD: ${REBUILD_POSTGRES_PASSWORD:?Configure REBUILD_POSTGRES_PASSWORD in .env.persistence-containers}',
    '      POSTGRES_PASSWORD: ${TEST_POSTGRES_PASSWORD:?Configure TEST_POSTGRES_PASSWORD in .env.persistence-containers}',
  ])
  assert.match(environmentTemplate, /REBUILD_POSTGRES_PASSWORD=\s*$/m)
  assert.match(environmentTemplate, /TEST_POSTGRES_PASSWORD=\s*$/m)
  assert.match(identityDocumentation, /"host": "postgres-rebuild"/)
  assert.match(identityDocumentation, /"host": "postgres-test"/)
  assert.match(identityDocumentation, /"environment": "<AMBIENTE_LEGADO_APROVADO>"/)
  assert.match(identityDocumentation, /legado\s+continuam deliberadamente incompletos/i)
  assert.match(identityDocumentation, /nem autorizações operacionais/i)
})

test('T006 isola api-dev e api-test em networks PostgreSQL distintas com uma única imagem Node 22', () => {
  const compose = readProjectFile('docker-compose.persistence.yml')
  const dockerfile = readProjectFile('docker/dockerfile')
  const apiDev = compose.split('  api-dev:\n', 2)[1].split('  api-test:\n', 2)[0]
  const apiTest = compose.split('  api-test:\n', 2)[1].split('  postgres-rebuild:\n', 2)[0]

  assert.match(dockerfile, /^FROM node:22-alpine$/m)
  assert.match(dockerfile, /^RUN yarn install --frozen-lockfile$/m)
  assert.match(dockerfile, /^CMD \["yarn", "dev"\]$/m)
  assert.match(compose, /x-api-image: &api-image\n  image: alves-glass-api:development\n  build:\n    context: \.\n    dockerfile: docker\/dockerfile/)
  assert.match(apiDev, /<<: \*api-image/)
  assert.match(apiDev, /DB_HOST: postgres-rebuild/)
  assert.match(apiDev, /persistence-rebuild-network/)
  assert.match(apiTest, /<<: \*api-image/)
  assert.match(apiTest, /profiles: \["test"\]/)
  assert.match(apiTest, /command: \["yarn", "test"\]/)
  assert.match(apiTest, /DB_HOST: postgres-test/)
  assert.match(apiTest, /persistence-test-network/)
  assert.doesNotMatch(apiTest, /ports:/)
})