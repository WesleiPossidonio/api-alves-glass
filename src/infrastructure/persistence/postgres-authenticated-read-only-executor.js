import { Client } from 'pg'
import { authorizeTargetIdentity, identitiesMatchExactly, normalizeIdentity } from './target-identity.js'
import { verifyLocalDockerSessionIdentity, verifyTestEndpointAttestation } from './test-endpoint-attestation.js'
import { validateSchemaManifest } from './schema-manifest-validator.js'

const SESSION_SQL = `SELECT current_database() AS "currentDatabase", current_user AS "currentUser", current_setting('transaction_read_only', true) AS "transactionReadOnly", host(inet_server_addr()) AS "serverAddress", inet_server_port() AS "serverPort"`
const PRIVILEGES_SQL = `SELECT has_database_privilege(current_database(), 'CREATE') AS "canCreateDatabase", has_schema_privilege('baseline_meta', 'CREATE') AS "canCreateSchema", has_table_privilege('baseline_meta."SequelizeMetaBaseline"', 'INSERT, UPDATE, DELETE, TRUNCATE') AS "canWriteMetadata"`
const DATABASE_STATE_SQL = `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = current_database()) AS "exists", NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS "isEmpty"`
const METADATA_SQL = `SELECT json_build_object('resolvedRelation', 'baseline_meta.SequelizeMetaBaseline', 'resolution', json_build_object('qualified', true, 'searchPathUsed', false), 'schema', json_build_object('name', 'baseline_meta', 'exists', schema_row.schema_exists), 'table', json_build_object('schema', 'baseline_meta', 'name', 'SequelizeMetaBaseline', 'exists', table_row.table_exists), 'nameColumn', json_build_object('exists', column_row.name_exists, 'nullable', column_row.nullable), 'constraints', constraint_row.constraints) AS evidence FROM (SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'baseline_meta') AS schema_exists) AS schema_row CROSS JOIN (SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND c.relkind = 'r') AS table_exists) AS table_row CROSS JOIN (SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped) AS name_exists, COALESCE((SELECT NOT a.attnotnull FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'baseline_meta' AND c.relname = 'SequelizeMetaBaseline' AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped), true) AS nullable) AS column_row CROSS JOIN (SELECT COALESCE(json_agg(json_build_object('type', CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' END, 'columns', con.columns) ORDER BY con.contype), '[]'::json) AS constraints FROM (SELECT con.contype, array_agg(att.attname ORDER BY key_columns.ordinality) AS columns FROM pg_catalog.pg_constraint AS con JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid JOIN pg_catalog.pg_namespace AS ns ON ns.oid = rel.relnamespace JOIN unnest(con.conkey) WITH ORDINALITY AS key_columns(attnum, ordinality) ON true JOIN pg_catalog.pg_attribute AS att ON att.attrelid = rel.oid AND att.attnum = key_columns.attnum WHERE ns.nspname = 'baseline_meta' AND rel.relname = 'SequelizeMetaBaseline' AND con.contype IN ('p', 'u') GROUP BY con.oid, con.contype) AS con) AS constraint_row`
const RECORDED_MIGRATIONS_SQL = 'SELECT name FROM baseline_meta."SequelizeMetaBaseline" ORDER BY name ASC'
const SCHEMA_OBJECTS_SQL = `SELECT n.nspname AS schema, c.relname AS name, CASE WHEN c.relkind IN ('r', 'p') THEN 'table' WHEN c.relkind = 'v' THEN 'view' WHEN c.relkind = 'm' THEN 'materialized-view' WHEN c.relkind = 'S' THEN 'sequence' ELSE c.relkind::text END AS kind, md5(concat_ws('|', n.nspname, c.relname, c.relkind::text, c.relpersistence::text, c.relrowsecurity::text, c.relforcerowsecurity::text)) AS fingerprint FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function firstRow(result, label) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 || !result.rows[0] || typeof result.rows[0] !== 'object') {
    throw new Error(`Consulta fixa de ${label} não retornou uma única evidência estruturada`)
  }
  return result.rows[0]
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`Evidência de ${label} é inválida`)
  return value
}

function buildObservedObjects(rows, canonicalMigrations, schemaManifest) {
  const expectedByObject = new Map()
  for (const migration of schemaManifest.migrations ?? []) {
    if (!canonicalMigrations.includes(migration.name)) continue
    for (const object of migration.objects ?? []) expectedByObject.set(`${object.schema}\u0000${object.name}\u0000${object.kind}`, migration.name)
  }
  const result = Object.fromEntries(canonicalMigrations.map(name => [name, []]))
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') {
      throw new Error('Consulta fixa de objetos de schema retornou evidência inválida')
    }
    const migrationName = expectedByObject.get(`${row.schema}\u0000${row.name}\u0000${row.kind}`)
    if (migrationName) result[migrationName].push({ schema: row.schema, name: row.name, kind: row.kind, fingerprint: row.fingerprint })
  }
  return result
}

function validateFactoryInput(input) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) errors.push('Configuração do executor read-only deve ser um objeto')
  if (!input?.connectionConfig || typeof input.connectionConfig !== 'object' || Array.isArray(input.connectionConfig)) errors.push('Configuração de conexão explícita é obrigatória')
  if (!input?.authorizationConfig || typeof input.authorizationConfig !== 'object') errors.push('Configuração de autorização T006 é obrigatória')
  const hasSignedAttestation = input?.trustedPublicKeys && typeof input.trustedPublicKeys === 'object' && typeof input?.getAttestation === 'function' && typeof input?.getNonce === 'function'
  const hasLocalDockerEvidence = input?.localDockerEvidence && typeof input.localDockerEvidence === 'object' && !Array.isArray(input.localDockerEvidence)
  if (!hasSignedAttestation && !hasLocalDockerEvidence) errors.push('Atestado Ed25519 completo ou evidência Docker+sessõo local aprovada é obrigatório')
  if (!input?.schemaManifest || typeof input.schemaManifest !== 'object') errors.push('Manifesto canônico de schema é obrigatório')
  if (input?.createClient !== undefined && typeof input.createClient !== 'function') errors.push('createClient deve ser uma função quando informado')
  return errors
}

/**
 * Cria executor de observação PostgreSQL com consultas fixas, transação READ ONLY e atestado externo.
 * A fábrica não abre conexão. Não expõe SQL arbitrário, escrita, CLI, bootstrap ou cleanup.
 *
 * @param {{ connectionConfig?: object, authorizationConfig?: object, trustedPublicKeys?: Record<string, string|object>, getAttestation?: (input: object) => Promise<object>|object, getNonce?: () => string, localDockerEvidence?: object, schemaManifest?: object, createClient?: (config: object) => { connect: () => Promise<void>, query: (query: string|{ text: string, values?: unknown[] }) => Promise<{ rows?: object[] }>, end: () => Promise<void> } }} input Dependências operacionais explicitamente injetadas.
 * @returns {{ observeBaselineState: (request: { declaredTarget: object, metadataRelation: string, canonicalMigrations: readonly string[] }) => Promise<object> }} Executor compatível com postgres-status-observer.
 */
export function createPostgresAuthenticatedReadOnlyExecutor(input = {}) {
  const factoryErrors = validateFactoryInput(input)
  const createClient = input.createClient ?? (config => new Client(config))

  return Object.freeze({
    async observeBaselineState(request = {}) {
      if (factoryErrors.length > 0) throw new Error(factoryErrors.join('; '))
      if (request.metadataRelation !== 'baseline_meta.SequelizeMetaBaseline') throw new Error('Executor aceita exclusivamente a metadata canônica baseline_meta.SequelizeMetaBaseline')
      if (!Array.isArray(request.canonicalMigrations) || request.canonicalMigrations.length === 0) throw new Error('Executor exige migrations canônicas não vazias')

      const declared = normalizeIdentity(request.declaredTarget)
      const authorized = authorizeTargetIdentity(request.declaredTarget, input.authorizationConfig)
      if (!declared.valid || !authorized.authorized || !identitiesMatchExactly(declared.identity, authorized.identity).matches) {
        throw new Error('Destino declarado não é autorizado pela configuração T006')
      }
      if (authorized.identity.profile !== 'test') throw new Error('Executor autenticado desta fase aceita exclusivamente o perfil test')
      if (input.connectionConfig.host !== authorized.identity.host || Number(input.connectionConfig.port) !== authorized.identity.port || input.connectionConfig.database !== authorized.identity.database) {
        throw new Error('Configuração de conexão diverge do destino autorizado')
      }

      let client
      let transactionStarted = false
      let primaryError
      try {
        client = createClient(Object.freeze({ ...input.connectionConfig }))
        if (!client || typeof client.connect !== 'function' || typeof client.query !== 'function' || typeof client.end !== 'function') throw new Error('Cliente PostgreSQL injetado é inválido')
        await client.connect()
        await client.query('BEGIN READ ONLY')
        transactionStarted = true

        const session = firstRow(await client.query(SESSION_SQL), 'sessão')
        if (session.transactionReadOnly !== 'on') throw new Error('Servidor PostgreSQL não confirmou transação READ ONLY')
        if (session.currentDatabase !== authorized.identity.database) throw new Error('Database autenticado pela sessão diverge do destino autorizado')
        if (typeof session.currentUser !== 'string' || session.currentUser.trim().length === 0) throw new Error('Sessão PostgreSQL não informou principal autenticado')

        const privileges = firstRow(await client.query(PRIVILEGES_SQL), 'privilégios')
        const localTestMode = Boolean(input.localDockerEvidence)
        if (!localTestMode && (requireBoolean(privileges.canCreateDatabase, 'privilégio CREATE DATABASE') || requireBoolean(privileges.canCreateSchema, 'privilégio CREATE schema') || requireBoolean(privileges.canWriteMetadata, 'privilégio de escrita na metadata'))) {
          throw new Error('Principal PostgreSQL possui privilégios efetivos excessivos para observação read-only')
        }

        const sessionEndpoint = { serverAddress: session.serverAddress, serverPort: session.serverPort }
        let physicalValidation
        if (input.localDockerEvidence) {
          physicalValidation = verifyLocalDockerSessionIdentity({
            dockerEvidence: input.localDockerEvidence,
            expectedTarget: authorized.identity,
            serverSession: sessionEndpoint,
          })
        } else {
          const nonce = input.getNonce()
          if (typeof nonce !== 'string' || nonce.trim().length === 0) throw new Error('Nonce de execução confiável é obrigatório')
          const attestation = await input.getAttestation(Object.freeze({ declaredTarget: authorized.identity, nonce }))
          physicalValidation = verifyTestEndpointAttestation({
            attestation,
            trustedPublicKeys: input.trustedPublicKeys,
            expectedTarget: authorized.identity,
            expectedNonce: nonce,
            serverSession: sessionEndpoint,
          })
        }
        if (!physicalValidation.verified) throw new Error(`Identidade física do endpoint não verificável: ${physicalValidation.errors.join('; ')}`)

        const databaseState = firstRow(await client.query(DATABASE_STATE_SQL), 'estado do database')
        if (!requireBoolean(databaseState.exists, 'existência do database')) throw new Error('Database autenticado não existe')
        if (requireBoolean(databaseState.isEmpty, 'vazio do database')) throw new Error('Status requer database inicializado e não vazio')

        const metadataRow = firstRow(await client.query(METADATA_SQL), 'metadata')
        if (!metadataRow.evidence || typeof metadataRow.evidence !== 'object') throw new Error('Consulta fixa de metadata não retornou evidência qualificada')
        const recordedRows = await client.query(RECORDED_MIGRATIONS_SQL)
        if (!recordedRows || !Array.isArray(recordedRows.rows) || recordedRows.rows.some(row => typeof row?.name !== 'string')) throw new Error('Consulta fixa de histórico retornou evidência inválida')
        const metadataEvidence = { ...metadataRow.evidence, recordedMigrations: recordedRows.rows.map(row => row.name) }

        const schemaRows = await client.query(SCHEMA_OBJECTS_SQL)
        const manifest = validateSchemaManifest({ manifest: input.schemaManifest, canonicalMigrations: request.canonicalMigrations, observedObjects: buildObservedObjects(schemaRows?.rows, request.canonicalMigrations, input.schemaManifest) })
        if (!manifest.valid) throw new Error(`Manifesto de schema inválido: ${manifest.errors.join('; ')}`)

        await client.query('COMMIT')
        transactionStarted = false
        return Object.freeze({
          authentication: Object.freeze({ authenticated: true, readOnly: true, principal: session.currentUser }),
          connectedEndpoint: Object.freeze({ verified: true, host: authorized.identity.host, port: authorized.identity.port }),
          physicalInstance: physicalValidation.physicalInstance,
          observedIdentity: authorized.identity,
          databaseState: Object.freeze({ exists: true, isEmpty: false }),
          serverSession: Object.freeze({ currentDatabase: session.currentDatabase, currentUser: session.currentUser, serverAddress: session.serverAddress, serverPort: session.serverPort }),
          metadataEvidence: Object.freeze(metadataEvidence),
          observedMigrations: manifest.observedMigrations,
          legacyHistory: Object.freeze({ observed: false }),
        })
      } catch (error) {
        primaryError = error instanceof Error ? error : new Error('Falha desconhecida no executor read-only')
        if (transactionStarted && client) {
          try { await client.query('ROLLBACK') } catch {}
        }
        throw new Error(`Observação PostgreSQL read-only bloqueada: ${sanitizeDiagnostic(primaryError.message)}`)
      } finally {
        if (client) {
          try { await client.end() } catch (endError) {
            if (!primaryError) throw new Error(`Encerramento da conexão PostgreSQL falhou: ${sanitizeDiagnostic(endError instanceof Error ? endError.message : 'erro desconhecido')}`)
          }
        }
      }
    },
  })
}

export const POSTGRES_READ_ONLY_QUERIES = Object.freeze({ SESSION_SQL, PRIVILEGES_SQL, DATABASE_STATE_SQL, METADATA_SQL, RECORDED_MIGRATIONS_SQL, SCHEMA_OBJECTS_SQL })
