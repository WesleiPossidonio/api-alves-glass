import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectLocalDockerEvidence } from './run-local-test-status.js'

const execute = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const networkName = 'api-alves-glass-clone_persistence-test-network'

/** Executa T020–T025 em runner efêmero, sem Docker socket, no endpoint interno autorizado. */
export async function runLocalTestIntegration(input = {}) {
  const root = input.projectRoot ?? projectRoot
  const run = input.execFileAsync ?? execute
  const evidence = await collectLocalDockerEvidence({ execFileAsync: run })
  if (!fs.existsSync(path.resolve(root, '.env.persistence-api-test')) || !fs.existsSync(path.resolve(root, '.baseline-identity.json'))) {
    throw new Error('Arquivos locais de ambiente e identidade são obrigatórios para a integração test')
  }
  return run('docker', [
    'run', '--rm', '--entrypoint', 'node', '--network', networkName,
    '--env-file', path.resolve(root, '.env.persistence-api-test'),
    '-e', 'PERSISTENCE_PROFILE=test', '-e', 'NODE_ENV=test', '-e', 'PERSISTENCE_INSTANCE_HOST=postgres-test', '-e', 'PERSISTENCE_INSTANCE_PORT=5432', '-e', 'PERSISTENCE_INSTANCE_PROFILE=test',
    '-e', 'BASELINE_DB_HOST=postgres-test', '-e', 'BASELINE_DB_PORT=5432', '-e', 'BASELINE_DB_DATABASE=alvesglass_test', '-e', 'PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE=legacy-development-alvesglass',
    '-e', `BASELINE_LOCAL_DOCKER_EVIDENCE=${JSON.stringify(evidence)}`,
    '-v', `${root}:/app:ro`, '-v', `${path.resolve(root, 'node_modules')}:/app/node_modules:ro`, '--workdir', '/app',
    'alves-glass-api:development', '--test', 'tests/integration/persistence/local-postgres.integration.test.js',
  ])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalTestIntegration().then(({ stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  }).catch(error => {
    process.stderr.write(`Integração local bloqueada: ${error?.stderr || error?.stdout || error?.message || 'erro desconhecido'}\n`)
    process.exitCode = 1
  })
}