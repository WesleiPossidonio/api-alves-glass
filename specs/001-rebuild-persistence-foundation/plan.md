# Plano de implementação — Fundação de Persistência

**Estado:** substituído pelo procedimento local abaixo. O plano original de baseline personalizado
foi abandonado; não é uma instrução operacional vigente.

## Contrato vigente

- PostgreSQL 16, Sequelize 6, `sequelize-cli` 6 e Yarn Classic.
- Migrations convencionais ficam em `src/database/migrations/`; metadata é `public.SequelizeMeta`.
- O `.sequelizerc` aponta para `src/config/sequelize-cli.cjs`; a configuração CLI usa as variáveis
  de `src/config/database.js` e migrations convencionais.
- Arquitetura: Controller → Service → Repository → Model. Services controlam transações e passam
  a transação aos Repositories.
- A aplicação não roda migrations automaticamente no startup.

## Banco local vazio

Configure PostgreSQL local descartável e variáveis de `.env` a partir dos arquivos locais de exemplo
disponíveis no ambiente. Crie um banco vazio com PostgreSQL e credenciais locais; em seguida:

```sh
yarn db:migrate:status
yarn db:migrate
```

Para desfazer somente a última migration em banco descartável: `yarn db:migrate:undo`. Não editar
migrations já aplicadas; mudanças futuras devem ser novas migrations convencionais. Não apontar os
comandos para produção, staging compartilhado ou qualquer volume que não seja explicitamente
descartável.

## Estado histórico

Esta feature de fundação foi planejada inicialmente com executor de baseline, manifest, preflights e
metadata paralela. Essa arquitetura foi substituída por decisão posterior pelo Sequelize CLI
convencional; os artefatos/instruções antigos não são requisitos para novas features. A situação das
tarefas é registrada em `tasks.md`; esta decisão não afirma que gates de benchmark, auditoria de
produção ou preservação de dados foram executados.

## Validação atual

- Unitários: `yarn test` (`node:test`).
- Integração de autenticação/PostgreSQL, quando o banco local descartável estiver preparado:
  `RUN_POSTGRES_AUTH_INTEGRATION=1 node --test tests/integration/*.postgres.test.js`.
- Verificar migrations e contrato Model/schema em ambiente local antes de integrar alteração de
  persistência.