import { BASELINE_METADATA_RELATION } from './metadata-config.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'

const STAGE = 'migration-recovery'
const ALLOWED_INPUT_FIELDS = new Set(['metadataValidation', 'recoveryEvidence', 'requestedMigrationName'])
const METADATA_RECOVERY_CONDITIONS = new Set(['absent', 'unexpected-schema', 'divergent'])
const SCHEMA_STATES = new Set(['consistent', 'absent', 'partial'])

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function validateInputShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['A entrada do diagnóstico de recovery deve ser um objeto']
  }

  return Object.keys(input)
    .filter(field => !ALLOWED_INPUT_FIELDS.has(field))
    .map(field => `Campo não permitido para o diagnóstico de recovery: ${field}`)
}

function isMigrationName(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateMetadataValidation(metadataValidation) {
  if (!metadataValidation || typeof metadataValidation !== 'object' || Array.isArray(metadataValidation)) {
    return ['Resultado da validação pós-CLI de metadata é obrigatório']
  }

  if (metadataValidation.stage !== 'metadata-validator') {
    return ['O diagnóstico de recovery exige resultado do metadata-validator da T028']
  }

  if (metadataValidation.details?.metadataRelation !== BASELINE_METADATA_RELATION) {
    return ['O resultado de metadata não identifica a relação canônica do baseline']
  }

  if (metadataValidation.state !== 'validated' && metadataValidation.state !== 'blocked') {
    return ['O resultado de metadata deve estar validated ou blocked para diagnóstico pós-CLI']
  }

  return []
}

function validateEvidenceShape(evidence) {
  const errors = []
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['Evidência estruturada de recovery é obrigatória']
  }

  if (!evidence.resolution || evidence.resolution.relation !== BASELINE_METADATA_RELATION || evidence.resolution.qualified !== true || evidence.resolution.searchPathUsed !== false) {
    errors.push('A evidência deve comprovar a relação canônica qualificada sem fallback por search_path')
  }

  if (!evidence.metadata || !['valid', ...METADATA_RECOVERY_CONDITIONS].includes(evidence.metadata.condition)) {
    errors.push('A evidência deve informar condição observada da metadata canônica')
  }

  if (!Array.isArray(evidence.canonicalMigrations) || evidence.canonicalMigrations.some(name => !isMigrationName(name))) {
    errors.push('A evidência deve informar a lista completa de migrations canônicas não vazias')
  } else if (new Set(evidence.canonicalMigrations).size !== evidence.canonicalMigrations.length) {
    errors.push('A lista de migrations canônicas não pode conter nomes duplicados')
  }

  if (!Array.isArray(evidence.observedMigrations)) {
    errors.push('A evidência deve informar migrations e estado observado para diagnóstico')
  } else {
    const names = new Set()
    for (const migration of evidence.observedMigrations) {
      if (!migration || typeof migration !== 'object' || !isMigrationName(migration.name)) {
        errors.push('Cada migration observada deve ter nome não vazio')
        continue
      }
      if (names.has(migration.name)) {
        errors.push('A evidência não pode conter migrations observadas duplicadas')
      }
      names.add(migration.name)
      if (typeof migration.metadataRecorded !== 'boolean' || !SCHEMA_STATES.has(migration.schemaState)) {
        errors.push(`A migration observada ${sanitizeDiagnostic(migration.name)} deve informar registro booleano e estado de schema reconhecido`)
      }
    }
  }

  if (!evidence.legacyHistory || typeof evidence.legacyHistory.observed !== 'boolean') {
    errors.push('A evidência deve informar explicitamente a presença de histórico legado')
  } else if (evidence.legacyHistory.observed === true && (
    typeof evidence.legacyHistory.inventoryProvided !== 'boolean' ||
    typeof evidence.legacyHistory.strategyApproved !== 'boolean'
  )) {
    errors.push('Histórico legado observado exige evidência explícita de inventário e estratégia')
  }

  return errors
}

function validateEvidenceCompleteness(evidence) {
  const expected = new Set(evidence.canonicalMigrations)
  const observed = new Set(evidence.observedMigrations.map(migration => migration.name))
  const errors = []

  for (const name of expected) {
    if (!observed.has(name)) {
      errors.push(`Evidência de migration canônica está incompleta para ${sanitizeDiagnostic(name)}`)
    }
  }

  return errors
}

function collectRecoveryReasons(evidence) {
  const reasons = []
  const expected = new Set(evidence.canonicalMigrations)

  if (METADATA_RECOVERY_CONDITIONS.has(evidence.metadata.condition)) {
    reasons.push(`Metadata canônica está ${evidence.metadata.condition} após tentativa controlada`)
  }

  for (const migration of evidence.observedMigrations) {
    if (!expected.has(migration.name)) {
      reasons.push('Metadata contém nome de migration incompatível com o conjunto canônico')
      continue
    }

    if (migration.schemaState === 'partial') {
      reasons.push('Migration apresenta evidência de aplicação parcial')
    } else if (migration.metadataRecorded && migration.schemaState !== 'consistent') {
      reasons.push('Migration registrada não possui evidência de schema consistente')
    } else if (!migration.metadataRecorded && migration.schemaState === 'consistent') {
      reasons.push('Objeto de migration existe sem registro correspondente na metadata')
    } else if (!migration.metadataRecorded && migration.schemaState === 'absent') {
      reasons.push('Migration canônica permanece sem registro e sem evidência de aplicação após tentativa controlada')
    }
  }

  if (evidence.legacyHistory.observed && (!evidence.legacyHistory.inventoryProvided || !evidence.legacyHistory.strategyApproved)) {
    reasons.push('Histórico legado exige inventário e estratégia explícita; não equivale ao baseline canônico')
  }

  return [...new Set(reasons)]
}

function metadataValidationMatchesEvidence(metadataValidation, evidence) {
  if (evidence.metadata.condition === 'valid') {
    return metadataValidation.state === 'validated' && metadataValidation.blocked === false
  }

  return metadataValidation.state === 'blocked' && metadataValidation.blocked === true
}

/**
 * Diagnostica, sem corrigir, divergências entre a metadata canônica e o schema efetivamente
 * observado depois do CLI. A evidência é declarativa e deve ser coletada por uma camada
 * operacional futura: este módulo não abre conexão, não executa SQL/DDL e não marca/reaplica
 * migrations. Histórico legado somente é sinal de recovery até existir inventário e estratégia
 * explícita; nunca é tratado como prova de equivalência ao baseline.
 *
 * @param {{ metadataValidation?: object, recoveryEvidence?: { resolution?: { relation?: string, qualified?: boolean, searchPathUsed?: boolean }, metadata?: { condition?: 'valid'|'absent'|'unexpected-schema'|'divergent' }, canonicalMigrations?: string[], observedMigrations?: Array<{ name: string, metadataRecorded: boolean, schemaState: 'consistent'|'absent'|'partial' }>, legacyHistory?: { observed: boolean, inventoryProvided?: boolean, strategyApproved?: boolean } }, requestedMigrationName?: string }} input Resultado T028 e evidência declarativa pós-CLI.
 * @returns {object} Resultado `already-current`, `migration-already-recorded`, `recovery-required` ou `blocked`.
 */
export function diagnoseMigrationRecovery(input = {}) {
  const shapeErrors = validateInputShape(input)
  if (shapeErrors.length > 0) {
    return createBlockedResult(STAGE, shapeErrors)
  }

  const metadataErrors = validateMetadataValidation(input.metadataValidation)
  if (metadataErrors.length > 0) {
    return createBlockedResult(STAGE, metadataErrors, { metadataRelation: BASELINE_METADATA_RELATION })
  }

  const evidenceErrors = validateEvidenceShape(input.recoveryEvidence)
  if (evidenceErrors.length > 0) {
    return createBlockedResult(STAGE, evidenceErrors, { metadataRelation: BASELINE_METADATA_RELATION })
  }

  const completenessErrors = validateEvidenceCompleteness(input.recoveryEvidence)
  if (completenessErrors.length > 0) {
    return createBlockedResult(STAGE, completenessErrors, { metadataRelation: BASELINE_METADATA_RELATION })
  }

  if (!metadataValidationMatchesEvidence(input.metadataValidation, input.recoveryEvidence)) {
    return createBlockedResult(STAGE, [
      'Resultado da validação de metadata contradiz a condição observada para o diagnóstico de recovery',
    ], { metadataRelation: BASELINE_METADATA_RELATION })
  }

  if (input.requestedMigrationName !== undefined && !isMigrationName(input.requestedMigrationName)) {
    return createBlockedResult(STAGE, ['requestedMigrationName deve ser uma string não vazia quando informado'], {
      metadataRelation: BASELINE_METADATA_RELATION,
    })
  }

  const recoveryReasons = collectRecoveryReasons(input.recoveryEvidence)
  if (recoveryReasons.length > 0) {
    return createBlockedResult(STAGE, recoveryReasons, {
      metadataRelation: BASELINE_METADATA_RELATION,
      diagnosis: 'manual-recovery-required',
      canonicalMigrationCount: input.recoveryEvidence.canonicalMigrations.length,
      observedMigrationCount: input.recoveryEvidence.observedMigrations.length,
      automaticRecovery: false,
    }, [], 'recovery-required')
  }

  if (input.requestedMigrationName !== undefined) {
    const requested = input.recoveryEvidence.observedMigrations.find(migration => migration.name === input.requestedMigrationName)
    if (!requested || !requested.metadataRecorded || requested.schemaState !== 'consistent') {
      return createBlockedResult(STAGE, [
        'Migration solicitada não possui registro e schema consistente para classificação segura',
      ], { metadataRelation: BASELINE_METADATA_RELATION })
    }

    return createSuccessResult(STAGE, 'migration-already-recorded', {
      metadataRelation: BASELINE_METADATA_RELATION,
      diagnosis: 'registered-migration-consistent',
      automaticRecovery: false,
    })
  }

  return createSuccessResult(STAGE, 'already-current', {
    metadataRelation: BASELINE_METADATA_RELATION,
    diagnosis: 'canonical-history-and-schema-consistent',
    automaticRecovery: false,
  })
}