# Feature 003 — operação Outbox/CQRS

## Execução

- `yarn inventory:outbox-worker`: reivindica linhas pendentes com `FOR UPDATE SKIP LOCKED` e lease PostgreSQL; publica em exchange durável com mensagens persistentes e publisher confirms. Só marca `PUBLISHED` depois do confirm. Falhas incrementam attempts, registram `last_error` e aplicam backoff exponencial; leases expiradas são recuperáveis.
- `yarn inventory:projection-consumer`: consome fila quorum durável. O ACK ocorre após transação MongoDB com dedupe por eventId, checkpoint por versão do material e inserção do movimento. Reentrega/versão velha é deduplicada; lacuna de versão causa retry; envelope inválido vai para DLQ.
- Variáveis de conexão: `MONGODB_URI`, `MONGODB_DATABASE`, `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `RABBITMQ_URL`, `RABBITMQ_HEARTBEAT_SECONDS` e `RABBITMQ_CONNECTION_TIMEOUT_MS`.
- MongoDB deve ser replica set para transações. A Compose de testes inclui Mongo replica set; não iniciar em ambiente com volume que não foi aprovado.

## Projeção e consistência

O PostgreSQL permanece autoridade. MongoDB contém `inventory_material_heads`, `inventory_movements` (documento por evento; `movements` é o envelope lógico paginado) e `inventory_event_consumptions`. A leitura é eventualmente consistente até o consumer alcançar a versão do ledger. Consultas devem obter autorização setorial corrente no PostgreSQL antes de ler; não confiar em filtros do cliente como autorização. Responsáveis sem nome histórico permanecem apenas com ID, sem resolver nome cadastral atual.

## Snapshots

`INVENTORY_SNAPSHOT_EVENT_INTERVAL` configura o intervalo em eventos; default técnico 500. Cada snapshot tem material, versão, estado, SHA-256 e timestamp, gravados na transação do evento que fecha o intervalo. Recuperação testa checksum do mais recente válido, inicia pelo snapshot e reexecuta eventos posteriores. Replay completo continua possível a partir da versão zero; nenhum evento é removido.

## Limitações conhecidas

O esquema atual não guarda `operationId`, setor no evento, nem nomes históricos do responsável. A projeção não os fabrica. O endpoint existente de relatório PostgreSQL permanece autoritativo; a integração de consultas Mongo deve validar grants no backend. A reconstrução operacional/testes de integração exige a migration Outbox/snapshot aplicada somente em PostgreSQL isolado e Mongo replica set.