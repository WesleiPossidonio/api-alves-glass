# Feature 002 — Modelo de sessão implementado

`auth_sessions` guarda um principal por sessão (`user_id` ou `client_id`), `actor_type`, criação,
expiração absoluta, revogação e último uso. Constraint CHECK exige relação coerente entre principal
e ator. `auth_session_refresh_tokens` guarda registros históricos com SHA-256 do token opaco,
timestamps de consumo/revogação e FK para sessão; o token em claro nunca é persistido.

Models: `AuthSession` e `AuthSessionRefreshToken`. Repositories: `AuthSessionRepository` e
`AuthSessionRefreshTokenRepository`. O Service controla transações/locking PostgreSQL e entrega a
transação às consultas/mutações do Repository, inclusive à leitura do User/role durante refresh.

## Contrato de identidade

- `actor_type=user`: `user_id` aponta para `users.id`, `client_id` nulo.
- `actor_type=client`: `client_id` aponta para `client.id`, `user_id` nulo.
- Cada ator pode ter várias sessões independentes; logout/reuse revoga somente a sessão indicada.
- Access JWT referencia sessão via `sid`; cada request protegida confere sessão ativa. Papel User é
  consultado de `users` no middleware, reduzindo dependência de role antiga em token.

## Persistência vigente

PostgreSQL 16 / Sequelize 6 / Sequelize CLI convencional, migration em
`src/database/migrations/20261110000500-create-auth-sessions.cjs`, metadata `public.SequelizeMeta`.
O baseline customizado e a metadata paralela descritos em versões anteriores foram abandonados.
Não editar migrations aplicadas; evoluir schema com nova migration e validar em banco local
descartável.