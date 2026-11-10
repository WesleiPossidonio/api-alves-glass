const SCHEMA_STATES = new Set(['consistent', 'absent', 'partial'])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function objectKey(object) {
  return `${object.schema}\u0000${object.name}\u0000${object.kind}`
}

function validateObject(object, prefix, errors) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    errors.push(`${prefix} deve ser um objeto`)
    return
  }
  for (const field of ['schema', 'name', 'kind', 'fingerprint']) {
    if (!isNonEmptyString(object[field])) errors.push(`${prefix}.${field} deve ser não vazio`)
  }
}

function normalizeManifest(manifest, canonicalMigrations) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.version !== 1 || !Array.isArray(manifest.migrations)) {
    return { errors: ['Manifesto canônico explícito versão 1 é obrigatório'], migrations: [] }
  }
  if (!Array.isArray(canonicalMigrations) || canonicalMigrations.length === 0 || canonicalMigrations.some(name => !isNonEmptyString(name))) {
    return { errors: ['Lista não vazia de migrations canônicas é obrigatória'], migrations: [] }
  }

  const expectedNames = new Set(canonicalMigrations)
  const migrations = []
  const names = new Set()
  for (const migration of manifest.migrations) {
    if (!migration || typeof migration !== 'object' || !isNonEmptyString(migration.name) || !Array.isArray(migration.objects) || migration.objects.length === 0) {
      errors.push('Cada migration do manifesto deve ter nome e objetos explícitos')
      continue
    }
    if (names.has(migration.name)) errors.push('Manifesto contém migrations duplicadas')
    names.add(migration.name)
    if (!expectedNames.has(migration.name)) errors.push('Manifesto contém migration fora do conjunto canônico')
    const objectKeys = new Set()
    for (const object of migration.objects) {
      validateObject(object, `Objeto da migration ${migration.name}`, errors)
      if (object && typeof object === 'object') {
        const key = objectKey(object)
        if (objectKeys.has(key)) errors.push(`Manifesto contém objeto duplicado na migration ${migration.name}`)
        objectKeys.add(key)
      }
    }
    migrations.push(migration)
  }
  for (const name of expectedNames) if (!names.has(name)) errors.push(`Manifesto não cobre a migration canônica ${name}`)
  return { errors, migrations }
}

/**
 * Compara objetos de catálogo previamente observados com um manifesto versionado e explícito.
 * O módulo não consulta PostgreSQL, não cria objetos e não infere manifesto a partir de metadata.
 *
 * @param {{ manifest?: { version?: number, migrations?: Array<{ name: string, objects: Array<{ schema: string, name: string, kind: string, fingerprint: string }> }>, canonicalMigrations?: string[], observedObjects?: Record<string, Array<{ schema: string, name: string, kind: string, fingerprint: string }>> }} input Manifesto, migrations canônicas e catálogo já observado.
 * @returns {{ valid: boolean, errors: readonly string[], observedMigrations: readonly object[] }} Estados por migration para o diagnóstico de recovery.
 */
export function validateSchemaManifest(input = {}) {
  const normalized = normalizeManifest(input.manifest, input.canonicalMigrations)
  const errors = [...normalized.errors]
  if (!input.observedObjects || typeof input.observedObjects !== 'object' || Array.isArray(input.observedObjects)) {
    errors.push('Objetos observados do catálogo são obrigatórios')
  }
  if (errors.length > 0) return Object.freeze({ valid: false, errors: Object.freeze(errors), observedMigrations: Object.freeze([]) })

  const observedMigrations = normalized.migrations.map(migration => {
    const observed = input.observedObjects[migration.name]
    if (!Array.isArray(observed)) {
      return Object.freeze({ name: migration.name, schemaState: 'absent' })
    }
    const observedByKey = new Map()
    let malformed = false
    for (const object of observed) {
      const objectErrors = []
      validateObject(object, `Objeto observado da migration ${migration.name}`, objectErrors)
      if (objectErrors.length > 0) malformed = true
      else observedByKey.set(objectKey(object), object)
    }
    let matched = 0
    let divergent = malformed
    for (const expected of migration.objects) {
      const actual = observedByKey.get(objectKey(expected))
      if (!actual) continue
      if (actual.fingerprint !== expected.fingerprint) divergent = true
      else matched += 1
    }
    const hasUnexpected = [...observedByKey.keys()].some(key => !migration.objects.some(expected => objectKey(expected) === key))
    const schemaState = matched === migration.objects.length && !divergent && !hasUnexpected
      ? 'consistent'
      : matched === 0 && !divergent && !hasUnexpected
        ? 'absent'
        : 'partial'
    return Object.freeze({ name: migration.name, schemaState })
  })

  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    observedMigrations: Object.freeze(observedMigrations),
    states: Object.freeze(observedMigrations.map(item => item.schemaState).filter(state => SCHEMA_STATES.has(state))),
  })
}
