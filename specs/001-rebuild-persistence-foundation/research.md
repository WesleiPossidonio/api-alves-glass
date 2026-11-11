# Feature 001 — Registro breve de decisões

A proposta original de baseline customizado foi substituída pela decisão vigente: PostgreSQL 16,
Sequelize 6 e Sequelize CLI convencional, com migrations em `src/database/migrations/` e metadata
`public.SequelizeMeta`. Não há manifest customizado, preflight ou metadata paralela ativos.

O projeto usa arquitetura Controller → Service → Repository → Model. Services controlam transações e
passam a transação aos Repositories. Migrations já aplicadas permanecem imutáveis; novos schemas
devem ser introduzidos por migrations novas e validados em banco local descartável.

As propostas anteriores estão preservadas no histórico Git; este arquivo não é um requisito de
baseline nem uma autorização para acessar banco compartilhado/produção.