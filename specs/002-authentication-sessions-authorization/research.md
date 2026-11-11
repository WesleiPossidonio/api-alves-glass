# Feature 002 — Decisões técnicas registradas

- Persistência de sessão/refresh em PostgreSQL via Sequelize 6; Service controla transação e
  Repository a recebe. Sem Redis.
- User e Client são atores distintos; access JWT carrega `actor_type`/`sid`; papel corrente de User
  é consultado no banco nas requisições protegidas.
- Access JWT: 15 minutos. Sessão/refresh: sete dias absolutos. Refresh aleatório, hash SHA-256
  persistido, rotação sob lock PostgreSQL e reuse revoga somente a sessão afetada.
- Cookies: access `HttpOnly Path=/`, refresh `HttpOnly Path=/session`, CSRF `Path=/`; `Secure` em
  produção, `SameSite=Lax`. Mutações autenticadas exigem Origin allowlisted e CSRF de sessão.
- Rate limit em memória por IP e rota: 5 senha User, 5 senha Client, 10 Google e 30 refresh a cada
  15 minutos; 429 com `Retry-After`. Pressupõe uma instância Node.
- Google autentica Client ativo com vínculo prévio ao `sub`; email coincidente não vincula conta.
  Integração externa com credencial real permanece não verificada.
- Persistência atual é Sequelize CLI convencional em `src/database/migrations/`, metadata
  `public.SequelizeMeta`. A decisão anterior de baseline, manifest, preflights e metadata separada
  foi abandonada; ver Feature 001 para o breve histórico.
- Matriz efetiva é a publicada em `spec.md`/`src/routes.js`; não inferir permissões para rotas de
  domínio não registradas. Regras futuras de ownership devem filtrar por ID autenticado no backend.