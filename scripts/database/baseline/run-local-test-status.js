import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const containerName = 'postgres-alves-glass-test'
const networkName = 'api-alves-glass-clone_persistence-test-network'

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function parseJson(value, label) {
  try { return JSON.parse(value) } catch { throw new Error(`${label} retornou JSON inválido`) }
}

export async function collectLocalDockerEvidence(input = {}) {
  const execute = input.execFileAsync ?? execFileAsync
  const [{ stdout: containerOutput }, { stdout: networkOutput }] = await Promise.all([
    execute('docker', ['inspect', containerName, '--format', '{{json .}}']),
    execute('docker', ['network', 'inspect', networkName, '--format', '{{json .}}']),
  ])
  const container = parseJson(containerOutput, 'docker inspect do container test')
  const network = parseJson(networkOutput, 'docker network inspect test')
  const attachment = container.NetworkSettings?.Networks?.[networkName]
  return Object.freeze({
    containerName: container.Name?.replace(/^\//, ''),
    containerId: container.Id,
    service: container.Config?.Labels?.['com.docker.compose.service'],
    composeProject: container.Config?.Labels?.['com.docker.compose.project'],
    networkName,
    networkId: network.Id,
    networkEndpointId: attachment?.EndpointID,
    networkAddress: attachment?.IPAddress,
  })
}

/**
 * Inspeciona no host confiável somente o container PostgreSQL de teste e executa um runner Node
 * efêmero, sem socket Docker e sem volumes persistentes adicionais, na rede já existente de testes.
 *
 * @param {{ execFileAsync?: typeof execFileAsync, projectRoot?: string }} input Dependências injetáveis para teste.
 * @returns {Promise<{ stdout: string, stderr: string }>} Saída do comando status executado no runner isolado.
 */
export async function runLocalTestStatus(input = {}) {
  const execute = input.execFileAsync ?? execFileAsync
  const root = input.projectRoot ?? projectRoot
  const evidence = await collectLocalDockerEvidence({ execFileAsync: execute })
  if (!fs.existsSync(path.resolve(root, '.env.persistence-api-test')) || !fs.existsSync(path.resolve(root, '.baseline-identity.json'))) {
    throw new Error('Arquivos locais de ambiente e identidade são obrigatórios para o runner test')
  }
  try {
    return await execute('docker', [
    'run', '--rm', '--network', networkName,
    '--env-file', path.resolve(root, '.env.persistence-api-test'),
    '-e', 'PERSISTENCE_PROFILE=test', '-e', 'NODE_ENV=test',
    '-e', 'PERSISTENCE_INSTANCE_HOST=postgres-test', '-e', 'PERSISTENCE_INSTANCE_PORT=5432', '-e', 'PERSISTENCE_INSTANCE_PROFILE=test',
    '-e', 'BASELINE_DB_HOST=postgres-test', '-e', 'BASELINE_DB_PORT=5432', '-e', 'BASELINE_DB_DATABASE=alvesglass_test',
    '-e', 'PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE=legacy-development-alvesglass', '-e', 'BASELINE_IDENTITY_CONFIG_PATH=/app/.baseline-identity.json',
    '-e', `BASELINE_LOCAL_DOCKER_EVIDENCE=${JSON.stringify(evidence)}`,
    '-v', `${root}:/app:ro`, '-v', `${path.resolve(root, 'node_modules')}:/app/node_modules:ro`,
      '--workdir', '/app', 'alves-glass-api:development', 'node', 'scripts/database/baseline/status-baseline.js',
    ])
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim()
    throw new Error(output ? sanitizeDiagnostic(output) : 'Runner local de status falhou sem diagnóstico')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalTestStatus().then(({ stdout, stderr }) => {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  }).catch(error => {
    process.stderr.write(`Status local bloqueado: ${error instanceof Error ? error.message : 'erro desconhecido'}\n`)
    process.exitCode = 1
  })
}