# Feature 001 — Estado das tarefas de persistência

**Status:** encerrada como proposta de baseline customizado; esse mecanismo foi abandonado.

- [x] Registrar a decisão vigente: PostgreSQL 16, Sequelize 6, Sequelize CLI convencional,
  `src/database/migrations/` e `public.SequelizeMeta`.
- [x] Atualizar spec e plano para não instruírem o uso do executor/manifest/preflights antigos.
- [ ] Não declarar como concluídos gates de produção, benchmark, preservação de dados ou recovery;
  esses itens não foram executados e não pertencem ao procedimento local atual.

Comandos configurados em `package.json`: `yarn db:migrate:status`, `yarn db:migrate` e
`yarn db:migrate:undo`. Testes unitários: `yarn test`. Não rodar migrations contra bancos ou
volumes compartilhados; migrations já aplicadas não devem ser editadas.