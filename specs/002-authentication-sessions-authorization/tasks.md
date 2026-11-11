# Feature 002 — Estado de implementação e validação

As marcações abaixo refletem verificações efetivamente executadas nesta branch.

## Implementação

- [x] Login User e Client com sessões persistidas, cookies e hash-only de refresh.
- [x] Google apenas para Client com vínculo prévio; contrato de integração externa permanece pendente.
- [x] Refresh rotativo com lock/transação, detecção de reuse e expiração absoluta.
- [x] Logout e revogação imediata de Access Tokens via consulta da sessão.
- [x] CSRF/Origin para mutações por cookie e cookies de sessão.
- [x] RBAC conservador por rota e identidade; `/createUser` protegido por admin e papel público
  nunca eleva para admin.
- [x] Ownership de `/client/me` e `/order/me` deriva do ID autenticado; guard genérico nega tipos
  não suportados.
- [x] Rate limits por IP/15 min: User senha 5, Client senha 5, Google 10 e refresh 30, com
  `Retry-After`; pressupõe uma instância.

## Evidências registradas

- [x] Unitários: `yarn test` passou — 32 testes, 32 aprovados, 0 falhas.
- [x] HTTP/PostgreSQL no container `api-dev`: `authorization-api.postgres.test.js` passou —
  cadastro admin, autorização por papel/ator, ownership, rate limit/`Retry-After`, refresh e logout.
- [x] PostgreSQL: `session-lifecycle.postgres.test.js` passou — concorrência de refresh, reuse,
  revogação e isolamento de sessões.
- [x] Migrations convencionais aplicadas em banco temporário vazio no container isolado
  `postgres-alves-glass-test`: seis migrations em ordem; 13 tabelas, 11 FKs, 3 CHECKs e seis
  entradas em `public.SequelizeMeta`. Modelos Sequelize carregaram/associaram e 12 tabelas foram
  comparadas por colunas; persistência User/Client/session/refresh round-trip passou.
- [x] Banco temporário `alvesglass_feature001_002_tmp_20261111_4f31c2` removido após confirmar
  container/volume/owner e zero conexões; `alvesglass_rebuild` não foi usado.
- [x] `yarn db:migrate:status` dentro de `api-dev`: seis migrations exibidas como `up`; nenhum DDL
  foi executado nesta validação.
- [x] `git diff --check` e `node --check` nos arquivos JS corrigidos passaram.
- [ ] Login Google end-to-end com ID token/credencial de provedor real.
- [ ] Benchmark Argon2id em container/ambiente de produção; parâmetros atuais não constituem
  benchmark aprovado.

## Persistência e operação

- [x] Decisão atual registrada: PostgreSQL 16, Sequelize 6, Sequelize CLI convencional,
  `src/database/migrations/`, `public.SequelizeMeta`; sem baseline customizado.
- [ ] Validar aplicação desde banco totalmente vazio por `yarn db:migrate` em volume descartável
  novo com PostgreSQL 16. A execução em banco descartável ocorreu em PostgreSQL 17 porque a imagem
  `postgres:16` não está disponível localmente; compatibilidade específica de PG16 permanece aberta.
  Não editar migrations já aplicadas nem tocar em outros volumes.
- [ ] Revisar mudanças de persistência preexistentes nesta branch e separar qualquer alteração fora
  do escopo antes de commit.

**Limitações desta execução:** integração Google real não executada; benchmark Argon2id/container
pendente; não foi criado banco vazio nem aplicado DDL nesta rodada. A execução de `yarn
db:migrate:status` diretamente no host falhou porque o hostname Docker `postgres` não resolve fora
da rede Compose; o mesmo comando passou dentro do serviço `api-dev`.