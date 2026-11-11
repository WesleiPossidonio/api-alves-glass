# Alves Glass API

API backend em Node.js 22/Express, com PostgreSQL 16, Sequelize 6, Sequelize CLI e Yarn Classic.
O fluxo de dados segue Controller → Service → Repository → Model.

## Desenvolvimento local

Instale dependências com `yarn install --frozen-lockfile` e configure as variáveis locais do
ambiente PostgreSQL em `.env` (não versionar segredos). Para iniciar a API: `yarn dev`.

Migrations usam o Sequelize CLI convencional em `src/database/migrations` e metadata padrão
`public.SequelizeMeta`:

```sh
yarn db:migrate:status
yarn db:migrate
yarn db:migrate:undo
```

Use somente o PostgreSQL local descartável configurado para desenvolvimento/teste. A API não
executa migrations automaticamente no startup. `yarn test` executa os testes unitários; as
integrações PostgreSQL são opt-in e exigem o banco isolado já configurado:

```sh
RUN_POSTGRES_AUTH_INTEGRATION=1 node --test tests/integration/*.postgres.test.js
```

## Autenticação e autorização

- `POST /session/user`, `POST /session/client` e `POST /google-session` iniciam sessões de
  User, Client e Client vinculado ao Google, respectivamente.
- Access JWT é cookie HttpOnly de 15 minutos; refresh opaco é cookie HttpOnly com validade
  absoluta de sete dias. Refresh rotaciona hash persistido; logout revoga a sessão. `csrf_token`
  é não HttpOnly para envio em `X-CSRF-Token`; mutações exigem Origin permitido e CSRF vinculado
  à sessão.
- `POST /session/refresh` exige cookies de sessão, Origin e CSRF; `POST /session/logout` revoga
  a sessão apresentada. `GET /check-auth` requer sessão ativa.
- Rate limits por IP: User/Client senha 5/15 min, Google 10/15 min, refresh 30/15 min. São em
  memória e válidos apenas com uma instância Node.js.
- Google usa verificação externa de ID token; o teste end-to-end com credencial real ainda está
  pendente. Conta Google precisa estar vinculada previamente ao Client.
- Matriz atual: `admin` em `/createUser`, `/user/all`, `/budged`, `/client`, `/client/all`,
  `PUT /client/:id`, `/order`, `/order/all`, `PATCH /order/:id` e
  `PATCH /orders/:id/products`; `PUT /user/:id` passa pelo guard atual somente para `admin` e
  somente quando `:id` é o próprio ID (o controller atualiza sempre o usuário autenticado);
  `client` em `/client/me` e `/order/me`, cujos controllers consultam o ID da sessão. Outros
  atores recebem 403. A matriz não concede acesso a endpoints de domínio que não estejam
  registrados em `src/routes.js`.

## Limites atuais

O rate limiting em memória não compartilha estado entre processos. Google real depende de
credenciais/configuração externa. Não há README prévio; este arquivo resume os comandos e
contratos efetivamente existentes.