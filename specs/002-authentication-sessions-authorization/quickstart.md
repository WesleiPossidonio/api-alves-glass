# Quickstart — Autenticação e sessão local

Use somente PostgreSQL local descartável configurado no `.env` privado. Comandos existentes:

```sh
yarn install --frozen-lockfile
yarn db:migrate:status
yarn db:migrate
yarn test
```

Integrações locais de sessão/RBAC sobem servidor HTTP de teste e conectam ao PostgreSQL configurado;
execute-as apenas no banco local isolado:

```sh
RUN_POSTGRES_AUTH_INTEGRATION=1 node --test tests/integration/session-lifecycle.postgres.test.js tests/integration/authorization-api.postgres.test.js
```

Para login, use `POST /session/user`, `POST /session/client` ou `POST /google-session` (`{ token }`);
para `/check-auth`, envie cookies; refresh/logout exigem Origin allowlisted e `X-CSRF-Token` igual
ao cookie CSRF vinculado à sessão. Origens locais padrão vêm de `sessionSecurity.js`; deployment deve
definir `AUTH_ALLOWED_ORIGINS`. Google real exige credenciais/ID token válidos e não é coberto por
stubs.

Autorização e rate limits atuais estão em `spec.md`. `yarn test` não inclui automaticamente integrações
PostgreSQL. A API não aplica migrations no startup.