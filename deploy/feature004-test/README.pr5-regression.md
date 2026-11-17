# PR #5 — regressões isoladas

Este ambiente é exclusivo das correções da Feature 004. Não referencia nem altera
o recovery existente. Credenciais são sentinelas locais de teste, não de produção.

Antes de iniciar, conferir que os containers `feature004-pr5-regression-postgres`
e `feature004-pr5-regression-rabbitmq` ainda não existem, e que as portas loopback
55446/5681 estão livres. Não reutilizar um alvo com dados desconhecidos.

```sh
docker compose -p feature004-pr5-regression -f deploy/feature004-test/compose.pr5-regression.yml up -d --wait
```

O teste exige PostgreSQL 17, identidade exata do banco/usuário, banco público
vazio, flag explícita, `NODE_ENV=test` e RabbitMQ no vhost exclusivo. Não usa
MongoDB: a entrega real passa pelo consumer com projeção injetada; o reducer é
verificado separadamente com eventos canônicos reais de duas atribuições.

```sh
yarn install --frozen-lockfile
NODE_ENV=test RUN_FEATURE004_PR5_REGRESSION=1 \
DB_HOST=127.0.0.1 DB_PORT=55446 DB_DATABASE=feature004_pr5_regression \
DB_USERNAME=feature004_pr5_test DB_PASSWORD=feature004_pr5_local_only \
RABBITMQ_URL=amqp://feature004_pr5_test:feature004_pr5_local_only@127.0.0.1:5681/feature004_pr5_regression \
yarn node --test tests/integration/service-orders/service-order-pr5-regression.integration.test.js
yarn test
```

O bootstrap aplica somente quatro migrations pré-requisito existentes
(`create-users`, `create-client`, `create-sectors-and-warehouses` e
`create-sector-authorization`) e as oito migrations da Feature 004, registrando
cada sucesso em `SequelizeMeta`. Não utiliza `sync` nem migration global.

A topologia deve estar ausente no início. O publisher declara a fila durável e o
binding antes de publicar, sem consumer ativo. Depois o consumer recebe o evento.
Uma retirada controlada do binding nesse vhost força `basic.return`; o evento
canônico permanece e a Outbox volta a `PENDING`. Probes de schema divergente são
revertidos apenas na transação de teste.

O teste preserva dados e evidências, inclusive em falha. Para repetir, criar um
**novo** banco e um **novo** vhost no mesmo ambiente exclusivo, com sufixo numérico
(`feature004_pr5_regression_2`, por exemplo), autorizando o usuário de teste nesse
vhost; ajustar as duas variáveis correspondentes. Não limpar/recriar recovery,
não usar `down -v` e não executar rollback destrutivo. Ao terminar:

```sh
docker compose -p feature004-pr5-regression -f deploy/feature004-test/compose.pr5-regression.yml stop
```
