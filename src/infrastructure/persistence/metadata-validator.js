import { BASELINE_METADATA_RELATION } from './metadata-config.js'
import { createBlockedResult, createSuccessResult } from './operation-result.js'

const STAGE = 'metadata-validator'
const EXPECTED_SCHEMA = 'baseline_meta'
const EXPECTED_TABLE = 'SequelizeMetaBaseline'
const ALLOWED_INPUT_FIELDS = new Set(['cliExecution', 'metadataObserver'])

function sanitizeObservationFailure(error) {
  const message = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : 'erro desconhecido'

  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[DATABASE_URL_REDACTED]')
    .replace(/\b(password|pwd|BASELINE_DB_PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(username|user|BASELINE_DB_USERNAME)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

function validateInputShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['A entrada do validador de metadata deve ser um objeto']
  }

  return Object.keys(input)
    .filter(field => !ALLOWED_INPUT_FIELDS.has(field))
    .map(field => `Campo não permitido para o validador de metadata: ${field}`)
}

function validateCliExecution(cliExecution) {
  if (!cliExecution || typeof cliExecution !== 'object' || Array.isArray(cliExecution)) {
    return ['Resultado validado do CLI controlado é obrigatório antes da validação pós-CLI']
  }

  if (cliExecution.stage !== 'baseline-cli-runner' || cliExecution.state !== 'validated' || cliExecution.blocked !== false) {
    return ['Validação de metadata exige resultado validated e não bloqueado do baseline-cli-runner']
  }

  if (cliExecution.details?.metadataRelation !== BASELINE_METADATA_RELATION) {
    return ['Resultado do CLI não comprova a relação canônica de metadata do baseline']
  }

  return []
}

function hasNameConstraint(constraints) {
  if (!Array.isArray(constraints)) {
    return false
  }

  return constraints.some(constraint => (
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
    return ['Observação de catálogo da metadata é obrigatória e deve ser estruturada']
  }

  if (evidence.resolvedRelation !== BASELINE_METADATA_RELATION) {
    errors.push(`A relação observada deve ser exclusivamente ${BASELINE_METADATA_RELATION}`)
  }

  if (!evidence.resolution || evidence.resolution.qualified !== true || evidence.resolution.searchPathUsed !== false) {
    errors.push('A observação deve comprovar resolução qualificada sem fallback por search_path')
  }

  if (!evidence.schema || evidence.schema.name !== EXPECTED_SCHEMA || evidence.schema.exists !== true) {
    errors.push(`Schema ${EXPECTED_SCHEMA} deve existir e ser explicitamente observado`)
  }

  if (!evidence.table || evidence.table.schema !== EXPECTED_SCHEMA || evidence.table.name !== EXPECTED_TABLE || evidence.table.exists !== true) {
    errors.push(`Tabela ${BASELINE_METADATA_RELATION} deve existir no schema canônico`)
  }

  if (!evidence.nameColumn || evidence.nameColumn.exists !== true || evidence.nameColumn.nullable !== false) {
    errors.push(`Coluna name de ${BASELINE_METADATA_RELATION} deve existir e ser NOT NULL`)
  }

  if (!hasNameConstraint(evidence.constraints)) {
    errors.push(`Coluna name de ${BASELINE_METADATA_RELATION} deve possuir PRIMARY KEY ou UNIQUE exclusiva`)
  }

  return errors
}

/**
 * Valida exclusivamente a metadata qualificada criada pelo sequelize-cli controlado. O adaptador
 * injetado deve ser somente de observação e expor `observeMetadata(relation)`, retornando a prova
 * completa do catálogo: `resolvedRelation`, `resolution`, `schema`, `table`, `nameColumn` e
 * `constraints`. Este módulo não cria conexões, não executa SQL/DDL e não corrige metadata.
 *
 * @param {{ cliExecution?: object, metadataObserver?: { observeMetadata?: (relation: 'baseline_meta.SequelizeMetaBaseline') => Promise<object> } }} input Resultado pós-CLI e adaptador de leitura explícito.
 * @returns {Promise<object>} Resultado `validated` ou `blocked` compatível com operation-result.
 */
export async function validateBaselineMetadata(input = {}) {
  const shapeErrors = validateInputShape(input)
  if (shapeErrors.length > 0) {
    return createBlockedResult(STAGE, shapeErrors)
  }

  const cliErrors = validateCliExecution(input.cliExecution)
  if (cliErrors.length > 0) {
    return createBlockedResult(STAGE, cliErrors, { metadataRelation: BASELINE_METADATA_RELATION })
  }

  if (!input.metadataObserver || typeof input.metadataObserver.observeMetadata !== 'function') {
    return createBlockedResult(STAGE, [
      'Adaptador explícito e somente de observação de catálogo é obrigatório após o CLI controlado',
    ], { metadataRelation: BASELINE_METADATA_RELATION })
  }

  try {
    const evidence = await input.metadataObserver.observeMetadata(BASELINE_METADATA_RELATION)
    const evidenceErrors = validateMetadataEvidence(evidence)
    if (evidenceErrors.length > 0) {
      return createBlockedResult(STAGE, evidenceErrors, { metadataRelation: BASELINE_METADATA_RELATION })
    }

    return createSuccessResult(STAGE, 'validated', {
      metadataRelation: BASELINE_METADATA_RELATION,
      observation: 'injected-read-only-catalog-evidence',
      nameConstraint: evidence.constraints.find(constraint => (
        (constraint.type === 'PRIMARY KEY' || constraint.type === 'UNIQUE') &&
        Array.isArray(constraint.columns) &&
        constraint.columns.length === 1 &&
        constraint.columns[0] === 'name'
      )).type,
    })
  } catch (error) {
    return createBlockedResult(STAGE, [
      `Adaptador de observação de metadata falhou: ${sanitizeObservationFailure(error)}`,
    ], { metadataRelation: BASELINE_METADATA_RELATION })
  }
}