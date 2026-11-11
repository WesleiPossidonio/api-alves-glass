# Contrato de persistência local

O procedimento de baseline customizado registrado anteriormente foi abandonado. O único fluxo
operacional atual é o Sequelize CLI convencional: `src/database/migrations/`, metadata
`public.SequelizeMeta`, configuração `src/config/sequelize-cli.cjs` e scripts Yarn declarados em
`package.json`.

## Banco local descartável

1. Configure as variáveis PostgreSQL locais via `.env` não versionado.
2. Crie/escolha explicitamente um banco de desenvolvimento descartável e vazio.
3. Consulte `yarn db:migrate:status`.
4. Aplique com `yarn db:migrate`.
5. Para desfazer a última migration de desenvolvimento, revise o impacto e use
   `yarn db:migrate:undo`.

A API não executa migrations no startup. Não usar banco/volume compartilhado ou de produção; não
editar migration já aplicada. DDL novo deve entrar em migration aditiva nova e ser validado com
testes em PostgreSQL local descartável. Este documento não autoriza provisionamento destrutivo nem
criação de infraestrutura paralela.