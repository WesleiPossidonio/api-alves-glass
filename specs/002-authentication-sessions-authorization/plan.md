# Feature 002 — Plano e contrato técnico vigente

**Estado:** plano substituído por implementação existente; ver `tasks.md` para evidências e pendências.

## Stack e arquitetura

Node.js 22, Express 5, PostgreSQL 16, Sequelize 6, `sequelize-cli` convencional, Yarn Classic e
`node:test`. Persistência: `src/database/migrations/`, metadata `public.SequelizeMeta`; comandos
`yarn db:migrate[:status|:undo]`. Baseline customizado, manifest, preflights e metadata paralela
foram abandonados. Migrations aplicadas não são editadas.

Camadas: Controller → Service → Repository → Model. Services abrem transações e passam `transaction`
aos Repositories; não adicionar Redis ou novas camadas para esta feature.

## Autenticação e sessão

- User senha: `POST /session/user`; Client senha: `POST /session/client`; Client Google vinculado:
  `POST /google-session` com `{ token }`.
- Login emite Access JWT HttpOnly de 15 min, refresh HttpOnly de validade absoluta de 7 dias e
  `csrf_token` acessível ao frontend. JWT não é devolvido no corpo.
- Refresh: `POST /session/refresh`, exige cookies access+refresh, assinatura válida (mesmo expirado
  temporalmente para permitir renovação), `sid` correspondente, Origin permitido e CSRF. Rotação e
  atualização persistente ocorrem na transação; somente SHA-256 do refresh é guardado.
- Logout: `POST /session/logout`; revoga a sessão e limpa access, refresh e CSRF com os paths de
  emissão. Mutação protegida exige Origin allowlisted e `X-CSRF-Token` vinculado à sessão.
- `/check-auth` valida assinatura/expiração e sessão persistida/revogação; em cada requisição
  protegida, papel User é lido do banco. `User` e `Client` não compartilham namespace de identidade.

## Autorização atualmente exposta

A tabela efetiva por endpoint está em `spec.md` e corresponde a `src/routes.js`; `PUT /user/:id`
atualmente exige admin e só admite o próprio ID. Novos endpoints devem
ter papel/tipo definido explicitamente; acesso Client a `/me` deve derivar o filtro de `request.userId`
no Service/query, nunca aceitar ID de titular enviado pelo cliente. `requireOwner` só aceita tipos
de recurso com consulta de propriedade implementada e nega os demais.

## Proteção contra abuso e limitações

Rate limit por IP/15 min: User senha 5, Client senha 5, Google 10, refresh 30; `429` inclui
`Retry-After`. Estado em memória requer instância única. A verificação Google end-to-end com token e
credenciais reais ainda está pendente; cobertura com stub não a substitui. Nenhum teste deve marcar
como validado um provedor externo sem essa evidência.

## Contratos estáveis para features futuras

Preservar `actor_type`, `sid` persistido, separação User/Client, hashes-only de refresh, expiração
absoluta, revogação imediata, Origin+CSRF em mutações por cookie e enforcement server-side. Mudanças
de schema são migrations aditivas convencionais testadas em PostgreSQL local descartável; não editar
migrations aplicadas.