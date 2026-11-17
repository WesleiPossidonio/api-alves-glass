# Ambiente novo de integração — Feature 004

Esta configuração não reutiliza nenhum recurso `feature004-integration` anterior.
Não iniciar neste estágio: o preflight precisa de autorização operacional depois
da revisão dos comandos de migrations e da validação Mongo dentro da rede.

## Recursos reservados

| Recurso               | Identidade                                                   | Endpoint/relação                                                                           |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Projeto Compose       | `feature004-recovery-20261113`                               | independente do projeto anterior                                                           |
| PostgreSQL 17         | `feature004-recovery-20261113-postgres`                      | `127.0.0.1:55445`, DB `feature004_recovery_integration`, usuário `feature004_recovery_dev` |
| MongoDB 8             | `feature004-recovery-20261113-mongodb`                       | `127.0.0.1:27030`, RS `feature004-recovery-rs`                                             |
| RabbitMQ 4 Management | `feature004-recovery-20261113-rabbitmq`                      | AMQP `127.0.0.1:5680`, UI `127.0.0.1:15680`                                                |
| Rede                  | `feature004-recovery-20261113-network`                       | bridge dedicada                                                                            |
| Volumes               | `feature004_recovery_20261113_{pgdata,mongodata,rabbitdata}` | novos, sem compartilhamento                                                                |

As senhas são exclusivamente locais e descartáveis. Nenhuma operação está autorizada
nesta etapa: não iniciar containers, não conectar serviços e não executar migrations.
`SEQUELIZE_MIGRATION_ALLOWLIST` não é filtro efetivo do Sequelize CLI 6.6.3 nesta
configuração. A opção `--name` existe na CLI instalada, mas não substitui a validação
do destino, do status e das dependências.

## Estratégia Mongo

Executar Node, publisher, consumer e testes integrados num runner conectado somente
à rede deste Compose. Inicializar o RS com membro `feature004-recovery-mongodb:27017`
e usar URI `mongodb://feature004-recovery-mongodb:27017/feature004_recovery_integration?replicaSet=feature004-recovery-rs`.
Antes de consumers/testes, confirmar `_id`, PRIMARY, membro anunciado e conexão Mongo
do próprio runner. Conexão do host via porta publicada não é o critério de acesso.

## Sequência candidata de migrations (não executar sem autorização expressa)

Arquivos em ordem cronológica/dependência:

1. `20261110000000-create-users.cjs` — cria `users`, referenciada por autorização
   setorial e por `service_orders.created_by`/registros relacionados.
2. `20261110000100-create-client.cjs` — cria `client`, referenciada por
   `service_orders.client_id`.
3. `20261111000000-create-sectors-and-warehouses.cjs` — cria `sectors`, referenciada
   por autorização setorial e por `service_orders.sector_id`/contador.
4. `20261111000100-create-sector-authorization.cjs` — cria `user_sectors` e auditoria,
   dependentes de `users` e `sectors`.
5. `20261119000000-create-service-orders.cjs` — baseline da Feature 004, depende de
   `users`, `client` e `sectors`.
6. `20261120000000-extend-service-order-schema.cjs` — extensão da Feature 004; sua
   validação pressupõe o baseline e objetos criados por 190.
7. `20261121000000-repair-service-order-schema-extension.cjs` — requer ambas as
   entradas anteriores em `SequelizeMeta`, valida o schema resultante de 200 e instala
   a função/trigger de hash que 200 não completou.
8. `20261122000000-service-orders-text-number-fifo-index.cjs` — requer o índice
   `service_orders_fifo_idx` criado por 190 e sua forma original; substitui somente
   esse índice após validar schema e constraint. Deve ser a última migration da lista.
   `20261119000000-create-service-orders.cjs`.

Dependências: `service_orders.created_by` e eventos/qualidade referenciam `users`;
`service_orders.client_id` referencia `client`; `sector_id` e o contador referenciam
`sectors`; `user_sectors` e sua auditoria referenciam `users` e `sectors`. Nenhuma
FK da migration Feature 004 aponta para `user_sectors`; a associação operacional é
verificada no caso de uso. Migrations de autenticação, estoque, pedidos legados e
Sequelize CLI 6.6.3 foi consultado localmente: `db:migrate --help` confirma `--name`,
`--to` e `--migrations-path`; o código do migrator usa o diretório configurado por
`--migrations-path`, não `migrations.migrationPaths`. O staging com exatamente os
oito arquivos acima, na ordem, é candidato para avaliação operacional, não uma
allowlist automática. A CLI pode encontrar outras migrations se o caminho estiver
errado. O status e qualquer execução futura precisariam usar exatamente o caminho
revisado, com `NODE_ENV=test`, `DB_HOST=127.0.0.1`,
conteúdo e a ordem desse diretório antes de qualquer comando. O status e a execução
O comando `--name` não deve ser considerado proteção suficiente: conferir antes e
depois cada status e confirmar o nome pendente. Não usar `--to`, rollback ou migrations
fora da sequência aprovada. As migrations anteriores à 190 podem estar pendentes;
nunca presumir que estão aplicadas: obter e revisar `db:migrate:status` e `SequelizeMeta`
no alvo isolado antes de propor execução.

## Preflights e aprovação operacional (ainda não autorizados)

1. Antes de qualquer conexão, obter autorização separada para inspeção somente leitura
   e confirmar projeto/container/rede/volumes reservados, versão PostgreSQL 17, host,
   porta, banco, usuário e configuração efetiva da CLI/teste. Parar diante de qualquer
   divergência, ambiguidade ou indício de staging/produção.
2. Com autorização de inspeção, consultar migrations aplicadas e pendentes, conferir
   que o recovery está no estado documentado e que 190–220 têm pré-condições coerentes.
   Não inferir aplicação pela presença dos arquivos nem presumir a lista de cinco ou
   sete do estado anterior.
3. Inspecionar somente leitura o índice completo, a constraint única
   `(sector_id, external_number)` e existência de números não numéricos. Parar caso
   índice, constraint ou estado dos dados seja inesperado. A reversão 220 não é
   procedimento de limpeza e recusará números textuais.
4. O teste `node --test tests/integration/service-orders/service-order-postgres.recovery.integration.test.js`
   é integração e exige isolamento/serviços; não executá-lo como preflight local.
   Consultas específicas de catálogo e dados continuam necessárias, pois o teste não
   valida a definição completa do índice.
5. Apresentar os resultados e obter aprovação operacional explícita antes de iniciar
   containers ou executar qualquer migration. Esta documentação não concede essa
   aprovação.
   Não usar `--to`, `db:migrate` sem `--migrations-path`, rollback ou migrations fora
   da lista.

## Depois de autorização específica

Nenhuma etapa abaixo está aprovada. Após os preflights e autorização operacional
específica, avaliar o procedimento de inicialização no README principal; só então
considerar a sequência candidata acima, com confirmação independente do destino e
do status imediatamente antes de cada migration.

Não usar `down -v`, `DROP`, rollback nem limpeza automática. Os containers/volumes
antigos permanecem intocados.
