export const OPERATION_STATES = Object.freeze([
  'validated',
  'blocked',
  'instance-validated',
  'database-created',
  'rebuild-complete',
  'already-current',
  'migration-already-recorded',
  'recovery-required',
])

const SUCCESS_STATES = new Set([
  'validated',
  'instance-validated',
  'database-created',
  'rebuild-complete',
  'already-current',
  'migration-already-recorded',
])

const BLOCKED_STATES = new Set(['blocked', 'recovery-required'])

function normalizeMessages(messages, field) {
  if (messages === undefined) {
    return []
  }

  if (!Array.isArray(messages) || messages.some(message => typeof message !== 'string' || message.trim().length === 0)) {
    throw new TypeError(`${field} deve ser uma lista de mensagens não vazias`)
  }

  return Object.freeze(messages.map(message => message.trim()))
}

function normalizeStage(stage) {
  if (typeof stage !== 'string' || stage.trim().length === 0) {
    throw new TypeError('stage é obrigatório')
  }

  return stage.trim()
}

/**
 * Cria resultado operacional imutável sem acionar recursos externos. `outcome` classifica o
 * resultado; `state` preserva apenas os estados aprovados para a feature.
 *
 * @param {{ stage: string, state: string, outcome?: 'success'|'blocked'|'error', errors?: string[], warnings?: string[], details?: object }} input Dados do resultado.
 * @returns {{ stage: string, state: string, outcome: string, blocked: boolean, errors: readonly string[], warnings: readonly string[], details: object }} Resultado padronizado.
 */
export function createOperationResult(input) {
  const stage = normalizeStage(input?.stage)
  const state = input?.state
  if (!OPERATION_STATES.includes(state)) {
    throw new TypeError(`Estado operacional não aprovado: ${String(state)}`)
  }

  const outcome = input?.outcome ?? (SUCCESS_STATES.has(state) ? 'success' : 'blocked')
  if (!['success', 'blocked', 'error'].includes(outcome)) {
    throw new TypeError(`Outcome operacional inválido: ${String(outcome)}`)
  }

  if (SUCCESS_STATES.has(state) && outcome !== 'success') {
    throw new TypeError(`O estado ${state} exige outcome success`)
  }

  if (BLOCKED_STATES.has(state) && outcome === 'success') {
    throw new TypeError(`O estado ${state} não pode ter outcome success`)
  }

  const errors = normalizeMessages(input?.errors, 'errors')
  const warnings = normalizeMessages(input?.warnings, 'warnings')
  if (outcome === 'error' && errors.length === 0) {
    throw new TypeError('Outcome error exige ao menos uma mensagem em errors')
  }

  return Object.freeze({
    stage,
    state,
    outcome,
    blocked: outcome !== 'success',
    errors,
    warnings,
    details: Object.freeze({ ...(input?.details ?? {}) }),
  })
}

export function createSuccessResult(stage, state, details = {}, warnings = []) {
  return createOperationResult({ stage, state, outcome: 'success', details, warnings })
}

export function createBlockedResult(stage, errors, details = {}, warnings = [], state = 'blocked') {
  return createOperationResult({ stage, state, outcome: 'blocked', errors, details, warnings })
}

export function createErrorResult(stage, errors, details = {}, warnings = []) {
  return createOperationResult({ stage, state: 'blocked', outcome: 'error', errors, details, warnings })
}