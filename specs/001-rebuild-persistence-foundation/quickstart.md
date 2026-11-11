# Quickstart — Persistência local convencional

Requisitos: Node.js 22, Yarn Classic, PostgreSQL 16 local descartável e configuração local não
versionada em `.env` conforme `src/config/database.js`.

```sh
yarn install --frozen-lockfile
yarn db:migrate:status
yarn db:migrate
yarn test
```

O banco deve estar vazio antes da aplicação inicial. O Sequelize CLI usa migrations de
`src/database/migrations/` e metadata padrão `public.SequelizeMeta`; a API não executa migrations
no startup. `yarn db:migrate:undo` desfaz somente a última migration e é para desenvolvimento
descartável, após revisar impacto.

Não há baseline, manifest, preflight ou metadata paralela ativos. Não executar contra banco de
produção/compartilhado e não editar migrations já aplicadas. Integrações PostgreSQL de auth são
opt-in com `RUN_POSTGRES_AUTH_INTEGRATION=1` e exigem banco local isolado preparado.