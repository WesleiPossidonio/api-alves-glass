export const BASELINE_METADATA_CONFIG = Object.freeze({
  migrationStorage: 'sequelize',
  migrationStorageTableName: 'SequelizeMetaBaseline',
  migrationStorageTableSchema: 'baseline_meta',
})

export const BASELINE_METADATA_RELATION = 'baseline_meta.SequelizeMetaBaseline'

/**
 * Produz a configuração declarativa e exclusiva da metadata do baseline. Não cria schema/tabela,
 * não consulta PostgreSQL e não lê metadata legada.
 *
 * @returns {{ migrationStorage: 'sequelize', migrationStorageTableName: 'SequelizeMetaBaseline', migrationStorageTableSchema: 'baseline_meta' }} Configuração imutável compatível com sequelize-cli.
 */
export function createBaselineMetadataConfig() {
  return Object.freeze({ ...BASELINE_METADATA_CONFIG })
}

/**
 * Rejeita qualquer configuração que se afaste da única relação de metadata aprovada. Em especial,
 * não aceita `search_path`, schema `public`, `SequelizeMeta` legado ou fallback implícito.
 *
 * @param {Record<string, unknown>} config Configuração declarativa a validar.
 * @returns {{ valid: boolean, errors: string[], config: object | null, relation: string }} Resultado sem efeitos externos.
 */
export function validateBaselineMetadataConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('A configuração de metadata do baseline deve ser um objeto')
  } else {
    for (const [field, expected] of Object.entries(BASELINE_METADATA_CONFIG)) {
      if (config[field] !== expected) {
        errors.push(`${field} deve ser exatamente ${JSON.stringify(expected)}`)
      }
    }

    if (Object.hasOwn(config, 'searchPath') || Object.hasOwn(config, 'search_path')) {
      errors.push('A configuração de metadata não pode declarar search_path ou searchPath')
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    config: errors.length === 0 ? createBaselineMetadataConfig() : null,
    relation: BASELINE_METADATA_RELATION,
  })
}