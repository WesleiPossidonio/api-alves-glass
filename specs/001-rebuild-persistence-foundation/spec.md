# Feature 001 — Fundação de Persistência (decisão substituída)

**Estado:** proposta original abandonada; não é especificação operacional vigente.

A proposta inicial descrevia baseline PostgreSQL customizado, manifest de schema, preflights,
metadata `baseline_meta.SequelizeMetaBaseline` e fluxo de recovery próprio. Essa abordagem foi
substituída por decisão posterior: o projeto usa PostgreSQL 16, Sequelize 6 e Sequelize CLI
convencional, com migrations em `src/database/migrations/` e metadata padrão
`public.SequelizeMeta`.

## Contrato atual

- Criar bancos locais descartáveis vazios e aplicar migrations com `yarn db:migrate`.
- Consultar estado com `yarn db:migrate:status`; desfazer a última migration de desenvolvimento
  com `yarn db:migrate:undo` somente quando seguro.
- Não executar DDL em banco/volume compartilhado ou de produção.
- Não editar migrations já aplicadas; evoluções futuras são migrations novas.
- Manter Controller → Service → Repository → Model e transações controladas por Service.

## Histórico preservado

O baseline customizado foi uma decisão de planejamento anterior, posteriormente revogada antes de
ser adotada como arquitetura vigente. Menções a baseline, manifest, preflight e metadata paralela
em artefatos históricos não são instruções. A revisão da Feature 002 atualiza os documentos ativos
de referência para esta decisão.