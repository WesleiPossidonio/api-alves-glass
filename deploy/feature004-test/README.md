# Feature 004 — infraestrutura de integração isolada

O Compose usa nomes próprios, bind ports em loopback, rede exclusiva e volumes
nomeados exclusivos; não referencia containers,
networks ou volumes de `docker-compose.yml`, `docker-compose.persistence.yml` ou
`deploy/feature003-test/compose.integration.yml`.

## Recursos propostos

| Serviço               | Container                         | Porta host → container                                | Banco/recurso                                         | Volume                     |
| --------------------- | --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | -------------------------- |
| PostgreSQL 17         | `feature004-integration-postgres` | `127.0.0.1:55444 → 5432`                              | `feature004_integration`, usuário `feature004_test`   | `feature004_it_pgdata`     |
| MongoDB 8 replica set | `feature004-integration-mongodb`  | `127.0.0.1:27029 → 27017`                             | `feature004_integration`, replica set `feature004-rs` | `feature004_it_mongodata`  |
| RabbitMQ 4 Management | `feature004-integration-rabbitmq` | `127.0.0.1:5679 → 5672`, UI `127.0.0.1:15679 → 15672` | vhost `/`                                             | `feature004_it_rabbitdata` |

Rede dedicada: `feature004-integration-network` (bridge). Os ports de host são
exclusivos e ligados a loopback.

## Inicialização autorizada pelo operador

No diretório do worktree:

```sh
docker compose -p feature004-integration -f deploy/feature004-test/compose.integration.yml config
docker compose -p feature004-integration -f deploy/feature004-test/compose.integration.yml up -d --wait
```

O nome do projeto, containers, volumes e rede é intencionalmente distinto dos
projetos/recursos da Feature 003 e do stack compartilhado. O healthcheck do MongoDB
somente testa ping; ele **não** inicializa nem altera replica set. Após verificar
container and volume `feature004-integration-mongodb` / `feature004_it_mongodata`,
initialize manually only on the new target using the exact member advertised by
that container (`localhost:27017` in this configuration):

```sh
docker exec feature004-integration-mongodb mongosh --quiet --eval 'rs.initiate({_id:"feature004-rs",members:[{_id:0,host:"localhost:27017"}]})'
```

Host-side driver validation found that this advertised address is not reachable via
the published port, including with `directConnection=true`. Do not run Node consumers
or tests against Mongo until a separately reviewed, host-reachable replica-set
configuration is prepared and its identity verified.

Se já houver replica set, somente confirmar `_id` e membro; não reconfigurar. Se o
volume existir com estado não identificado, parar e investigar em vez de inicializar.

Somente após containers saudáveis, revisão da migration e confirmação do banco
`feature004_integration`, definir variáveis locais temporárias não versionadas e
aplicar migrations por allowlist. **Não use `yarn db:migrate --to` como allowlist:**
esse comando executou todas as migrations pendentes na tentativa realizada. A
configuração aceita `SEQUELIZE_MIGRATION_ALLOWLIST` com nomes de arquivos separados
por vírgula; defina exatamente os cinco arquivos listados abaixo, confira
`yarn db:migrate:status` com a mesma variável e confirme que nenhum nome de migration
de estoque/Feature 003 será selecionado antes de executar. O catálogo contém
migrations de autenticação, estoque e Feature 003; **não** executar `yarn db:migrate`
sem filtro, pois alteraria esses domínios. Baseline OS mínimo: `create-users`,
`create-client`, `create-sectors-and-warehouses`, `create-sector-authorization` e,
por último, `create-service-orders`; cada migration deve ser inspecionada e marcada
em `SequelizeMeta` somente após sucesso. DB target: `DB_HOST=127.0.0.1`,
`DB_PORT=55444`, `DB_DATABASE=feature004_integration`, `DB_USERNAME=feature004_test`.
Mongo/Rabbit usam exclusivamente portas deste Compose. Ao fim, parar sem remover volumes:

```sh
docker compose -p feature004-integration -f deploy/feature004-test/compose.integration.yml stop
```

Não executar `down -v`, limpeza de Docker ou `compose down`; `stop` preserva recursos.
Antes de cada operação, conferir alvo. Não executar `yarn db:migrate` irrestrito;
nenhuma migration de estoque/Feature 003 é permitida neste ambiente da Feature 004.

## Credenciais

As credenciais presentes no Compose são sentinelas descartáveis locais, não
segredos de produção. Não reutilizar nem publicar esse ambiente fora do host.
