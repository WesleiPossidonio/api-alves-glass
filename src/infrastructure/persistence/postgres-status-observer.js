import { BASELINE_METADATA_RELATION } from './metadata-config.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'
import { authorizeTargetIdentity, identitiesMatchExactly, normalizeIdentity } from './target-identity.js'

const STAGE = 'postgres-status-observer'
const PHYSICAL_INSTANCE_SOURCES = new Set(['approved-endpoint-attestation', 'local-docker-session-verification'])
const SCHEMA_STATES = new Set(['consistent', 'absent', 'partial'])
const authenticatedObservationResults = new WeakSet()

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateCanonicalMigrations(canonicalMigrations) {
  if (!Array.isArray(canonicalMigrations) || canonicalMigrations.length === 0) {
    return ['A observação de status exige a lista completa e não vazia de migrations canônicas']
  }

  if (canonicalMigrations.some(name => !isNonEmptyString(name))) {
    return ['Cada migration canônica deve ter nome não vazio']
  }

  if (new Set(canonicalMigrations).size !== canonicalMigrations.length) {
    return ['A lista de migrations canônicas não pode conter nomes duplicados']
  }

  return []
}

function validateExecutor(executor) {
  return executor && typeof executor.observeBaselineState === 'function'
    ? []
    : ['Executor autenticado e estritamente read-only com observeBaselineState é obrigatório']
}

function hasNameConstraint(constraints) {
  return Array.isArray(constraints) && constraints.some(constraint => (
    constraint &&
    typeof constraint === 'object' &&
    (constraint.type === 'PRIMARY KEY' || constraint.type === 'UNIQUE') &&
    Array.isArray(constraint.columns) &&
    constraint.columns.length === 1 &&
    constraint.columns[0] === 'name'
  ))
}

function validateMetadataEvidence(evidence) {
  const errors = []
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['Snapshot deve incluir evidência estruturada da metadata canônica']
  }

  if (evidence.resolvedRelation !== BASELINE_METADATA_RELATION) {
    errors.push(`Snapshot deve observar exclusivamente ${BASELINE_METADATA_RELATION}`)
  }
  if (evidence.resolution?.qualified !== true || evidence.resolution?.searchPathUsed !== false) {
    errors.push('Snapshot deve comprovar metadata por relação qualificada sem search_path')
  }
  if (evidence.schema?.name !== 'baseline_meta' || evidence.schema?.exists !== true) {
    errors.push('Snapshot deve comprovar existência explícita do schema baseline_meta')
  }
  if (evidence.table?.schema !== 'baseline_meta' || evidence.table?.name !== 'SequelizeMetaBaseline' || evidence.table?.exists !== true) {
    errors.push(`Snapshot deve comprovar tabela ${BASELINE_METADATA_RELATION} no schema canônico`)
  }
  if (evidence.nameColumn?.exists !== true || evidence.nameColumn?.nullable !== false) {
    errors.push('Snapshot deve comprovar coluna name NOT NULL na metadata canônica')
  }
  if (!hasNameConstraint(evidence.constraints)) {
    errors.push('Snapshot deve comprovar PRIMARY KEY ou UNIQUE exclusiva para a coluna name')
  }
  if (!Array.isArray(evidence.recordedMigrations) || evidence.recordedMigrations.some(name => !isNonEmptyString(name))) {
    errors.push('Snapshot deve informar histórico completo de migrations registradas na metadata')
  } else if (new Set(evidence.recordedMigrations).size !== evidence.recordedMigrations.length) {
    errors.push('Histórico registrado na metadata não pode conter migrations duplicadas')
  }

  return errors
}

function validateSnapshot(snapshot, declaredTarget, canonicalMigrations) {
  const errors = []
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return ['Snapshot autenticado de observação é obrigatório']
  }

  if (snapshot.authentication?.authenticated !== true || snapshot.authentication?.readOnly !== true || !isNonEmptyString(snapshot.authentication?.principal)) {
    errors.push('Snapshot deve comprovar autenticação, principal não vazio e sessão estritamente read-only')
  }

  if (snapshot.connectedEndpoint?.verified !== true) {
    errors.push('Snapshot deve comprovar endpoint conectado e verificado')
  }

  const endpoint = normalizeIdentity({
    ...declaredTarget,
    host: snapshot.connectedEndpoint?.host,
    port: snapshot.connectedEndpoint?.port,
  })
  if (!endpoint.valid) {
    errors.push(...endpoint.errors.map(error => `Endpoint conectado: ${error}`))
  } else {
    const endpointComparison = identitiesMatchExactly(declaredTarget, endpoint.identity)
    if (!endpointComparison.matches) {
      errors.push('Endpoint conectado diverge da identidade de destino declarada')
    }
  }

  if (
    snapshot.physicalInstance?.verified !== true ||
    !PHYSICAL_INSTANCE_SOURCES.has(snapshot.physicalInstance?.source) ||
    !isNonEmptyString(snapshot.physicalInstance?.fingerprint)
  ) {
    errors.push('A identidade física da instância exige atestado Ed25519 aprovado ou verificação local Docker+sessõo; PostgreSQL isoladamente não a prova')
  }

  const observedIdentity = normalizeIdentity(snapshot.observedIdentity)
  if (!observedIdentity.valid) {
    errors.push(...observedIdentity.errors.map(error => `Identidade observada: ${error}`))
  } else {
    const identityComparison = identitiesMatchExactly(declaredTarget, observedIdentity.identity)
    if (!identityComparison.matches) {
      errors.push('Identidade observada diverge do destino declarado')
    }
  }

  if (snapshot.databaseState?.exists !== true || typeof snapshot.databaseState?.isEmpty !== 'boolean') {
    errors.push('Snapshot deve informar existência do database e estado vazio explicitamente')
  } else if (snapshot.databaseState.isEmpty === true) {
    errors.push('Status autenticado classifica somente database já inicializado; database vazio não comprova baseline atual')
  }

  if (snapshot.serverSession?.currentDatabase !== declaredTarget.database || !isNonEmptyString(snapshot.serverSession?.currentUser)) {
    errors.push('Sessão observada deve comprovar currentDatabase canônico e usuário autenticado')
  }

  errors.push(...validateMetadataEvidence(snapshot.metadataEvidence))

  if (!Array.isArray(snapshot.observedMigrations) || snapshot.observedMigrations.some(migration => (
    !migration || typeof migration !== 'object' || !isNonEmptyString(migration.name) || !SCHEMA_STATES.has(migration.schemaState)
  ))) {
    errors.push('Snapshot deve informar migrations observadas com nome e estado de schema reconhecido')
  } else if (new Set(snapshot.observedMigrations.map(migration => migration.name)).size !== snapshot.observedMigrations.length) {
    errors.push('Snapshot não pode informar migrations observadas duplicadas')
  }

  if (!snapshot.legacyHistory || typeof snapshot.legacyHistory.observed !== 'boolean') {
    errors.push('Snapshot deve informar explicitamente a presença de histórico legado')
  }

  const canonicalSet = new Set(canonicalMigrations)
  const observedSet = new Set((snapshot.observedMigrations ?? []).map(migration => migration.name))
  for (const migration of canonicalSet) {
    if (!observedSet.has(migration)) {
      errors.push(`Snapshot de migrations está incompleto para ${sanitizeDiagnostic(migration)}`)
    }
  }
  for (const migration of snapshot.observedMigrations ?? []) {
    if (!canonicalSet.has(migration.name)) {
      errors.push(`Snapshot contém migration fora do conjunto canônico: ${sanitizeDiagnostic(migration.name)}`)
    }
  }

  return errors
}

function createRecoveryEvidence(snapshot, canonicalMigrations) {
  const recorded = new Set(snapshot.metadataEvidence.recordedMigrations ?? [])
  return Object.freeze({
    resolution: Object.freeze({
      relation: BASELINE_METADATA_RELATION,
      qualified: true,
      searchPathUsed: false,
    }),
    metadata: Object.freeze({ condition: 'valid' }),
    canonicalMigrations: Object.freeze([...canonicalMigrations]),
    observedMigrations: Object.freeze(snapshot.observedMigrations.map(migration => Object.freeze({
      name: migration.name,
      metadataRecorded: recorded.has(migration.name),
      schemaState: migration.schemaState,
    }))),
    legacyHistory: Object.freeze({ ...snapshot.legacyHistory }),
  })
}

/**
 * Cria um adaptador de observação autenticada sem abrir conexão no import ou na fábrica. O executor
 * injetado é o único componente autorizado a conectar futuramente e deve implementar somente
 * `observeBaselineState`; esta camada não expõe operações de escrita, CLI, bootstrap ou cleanup.
 *
 * `current_database()` prova apenas o database da sessão. Host/porta da conexão e a identidade
 * física da instância/container exigem atestado independente do endpoint conectado. Portanto,
 * ausência de `physicalInstance` com fonte aprovada bloqueia a observação em vez de inferir prova
 * física a partir de PostgreSQL.
 *
 * @param {{ readOnlyExecutor?: { observeBaselineState?: (request: { declaredTarget: object, metadataRelation: string, canonicalMigrations: readonly string[] }) => Promise<object> } }} input Dependência operacional explicitamente injetada.
 * @returns {{ observeBaselineStatus: (input: { declaredTarget?: object, authorizationConfig?: object, canonicalMigrations?: string[] }) => Promise<object> }} Adaptador de status read-only.
 */
export function createAuthenticatedPostgresStatusObserver(input = {}) {
  const executorErrors = validateExecutor(input.readOnlyExecutor)

  return Object.freeze({
    async observeBaselineStatus(observationInput = {}) {
      if (executorErrors.length > 0) {
        return createBlockedResult(STAGE, executorErrors)
      }

      const declared = normalizeIdentity(observationInput.declaredTarget)
      if (!declared.valid) {
        return createBlockedResult(STAGE, declared.errors.map(error => `Destino declarado: ${error}`))
      }

      const authorization = authorizeTargetIdentity(declared.identity, observationInput.authorizationConfig)
      if (!authorization.authorized) {
        return createBlockedResult(STAGE, authorization.errors, { declaredTarget: declared.identity })
      }

      const migrationErrors = validateCanonicalMigrations(observationInput.canonicalMigrations)
      if (migrationErrors.length > 0) {
        return createBlockedResult(STAGE, migrationErrors, { declaredTarget: declared.identity })
      }

      let snapshot
      try {
        snapshot = await input.readOnlyExecutor.observeBaselineState(Object.freeze({
          declaredTarget: declared.identity,
          metadataRelation: BASELINE_METADATA_RELATION,
          canonicalMigrations: Object.freeze([...observationInput.canonicalMigrations]),
        }))
      } catch (error) {
        return createBlockedResult(STAGE, [
          `Observação autenticada do PostgreSQL falhou: ${sanitizeDiagnostic(error instanceof Error ? error.message : 'erro desconhecido')}`,
        ], { declaredTarget: declared.identity })
      }

      const snapshotErrors = validateSnapshot(snapshot, declared.identity, observationInput.canonicalMigrations)
      if (snapshotErrors.length > 0) {
        return createBlockedResult(STAGE, snapshotErrors, { declaredTarget: declared.identity })
      }

      const observedAuthorization = authorizeTargetIdentity(snapshot.observedIdentity, observationInput.authorizationConfig)
      if (!observedAuthorization.authorized) {
        return createBlockedResult(STAGE, observedAuthorization.errors, { declaredTarget: declared.identity })
      }

      const result = createSuccessResult(STAGE, 'validated', {
        observation: 'authenticated-read-only-postgres-snapshot',
        declaredTarget: declared.identity,
        connectedEndpoint: Object.freeze({ host: snapshot.connectedEndpoint.host, port: snapshot.connectedEndpoint.port }),
        effectiveIdentity: observedAuthorization.identity,
        matchedDestination: observedAuthorization.matchedDestination,
        databaseState: Object.freeze({ exists: true, isEmpty: snapshot.databaseState.isEmpty }),
        metadataEvidence: snapshot.metadataEvidence,
        metadataValidation: Object.freeze({
          stage: 'metadata-validator',
          state: 'validated',
          blocked: false,
          details: Object.freeze({
            metadataRelation: BASELINE_METADATA_RELATION,
            observation: 'authenticated-read-only-catalog-evidence',
          }),
        }),
        recoveryEvidence: createRecoveryEvidence(snapshot, observationInput.canonicalMigrations),
        physicalInstance: Object.freeze({
          verified: true,
          source: snapshot.physicalInstance.source,
          fingerprint: snapshot.physicalInstance.fingerprint,
          limitation: 'PostgreSQL session data alone does not prove physical host, port, container, or instance identity.',
        }),
      })
      authenticatedObservationResults.add(result)
      return result
    },
  })
}

/**
 * Reconhece somente resultados emitidos nesta execução pela fábrica autenticada. Isso não substitui
 * a prova operacional real do executor, mas impede que T030 trate um objeto declarativo arbitrário
 * como observação autenticada.
 *
 * @param {object} result Resultado recebido pelo orquestrador.
 * @returns {boolean} Se o resultado foi emitido pelo adaptador desta infraestrutura.
 */
export function isAuthenticatedPostgresStatusObservation(result) {
  return Boolean(result && typeof result === 'object' && authenticatedObservationResults.has(result))
}