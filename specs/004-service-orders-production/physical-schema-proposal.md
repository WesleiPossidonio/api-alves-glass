# Proposta de schema físico — Feature 004

> Contexto histórico de planejamento/proposta. Para o contrato vigente, consultar `spec.md`, `product-corrections.md`, `rf31-client-tracking.md` e `final-validation.md`. Trechos legados sobre contador, FIFO numérico ou workflows removidos não autorizam sua reativação.

**Estado:** proposta técnica aditiva para revisão. Não executar migration em qualquer banco antes de autorização G6/G9. Nenhuma regra de retenção, anonimização ou expurgo foi introduzida (G8).

## Princípios

- PostgreSQL permanece fonte canônica. `service_orders` é agregado separado de `order` e não tem FK para estoque.
- Produtos OS são filhos do agregado e guardam especificações dimensionais como JSONB versionado dentro do produto; itens diferentes não são consolidados.
- Fatos confirmados são append-only em `service_order_events`; versão é BIGINT contíguo por agregado. Cabeçalho/produtos são estado operacional corrente, transacional, sem substituir o event stream.
- Outbox é específica de OS e grava envelope versionado na mesma transação do evento que deve ser publicado.
- Contador por setor é bloqueado com `FOR UPDATE`; números são strings e constraint única `(sector_id, external_number)`. Contador avança na mesma transação e jamais decrementa após cancelamento.
- FIFO é aplicado estritamente dentro do setor: `queue_entered_at ASC`, seguido da sequência numérica setorial (`external_number` convertida para inteiro) ASC. Cursor da fila deve reter setor e a tupla `(queue_entered_at, numeric_sequence, id)`; o UUID é desempate defensivo se dados legados/corrompidos duplicarem a sequência. Não comparar sequências entre setores.
- Permissões operacionais são grants por `(user_id, sector_id, operation)`, concedidos/revogados somente por admin e auditados em fatos append-only.
- Atribuições, execuções, qualidade, revisão e ciclo são registrados como fatos canônicos no stream; projeção de leitura contém o estado detalhado.

## Tabelas propostas

1. `service_order_counters(sector_id PK/FK, next_number BIGINT CHECK > 0)`.
2. `service_orders(id UUID PK, external_number VARCHAR, client_id FK client, sector_id FK sectors, due_at, public_status, administrative_state, operational_version BIGINT, queue_entered_at, production_completed BOOLEAN, created_by FK users, timestamps)`, unique `(sector_id, external_number)`, índices de fila por setor/estado/entrada e cliente/setor.
3. `service_order_products(id UUID PK, service_order_id FK, name, description, quantity INTEGER CHECK > 0, unit_code CHECK = UN, measurements JSONB, specification_revision INTEGER, completed_quantity INTEGER, blocked_quantity INTEGER, created_at)`, índices por agregado.
4. `service_order_events(event_id UUID PK, aggregate_id FK service_orders, aggregate_version BIGINT CHECK > 0, schema_version INTEGER, event_type VARCHAR, actor_user_id FK users nullable apenas para evento de sistema explicitamente definido, sector_id FK sectors, product_item_id FK products nullable, revision/cycle, correlation_id UUID, payload JSONB, occurred_at TIMESTAMPTZ)`, unique `(aggregate_id, aggregate_version)`, índice causal e triggers append-only UPDATE/DELETE/TRUNCATE.
5. `service_order_outbox(event_id PK/FK events, aggregate_id, aggregate_version, event_type, schema_version, payload JSONB, status, attempts, available_at, locked_until, locked_by, last_error, created_at)`, índices parciais de claim concorrente por status/horário.
6. `service_order_operation_grants(user_id FK users, sector_id FK sectors, operation VARCHAR allowlisted, granted_by FK users, created_at, revoked_at, revoked_by FK users nullable, reason)`. Unique parcial para grant ativo e audit trail append-only separado `service_order_grant_events` contendo grant/revoke, ator, alvo, setor, operação, justificativa e instante.

## Controle de versão e transação

O caso de uso inicia transação; bloqueia a linha de `service_orders`, verifica grant corrente dentro da mesma transação, valida expected version quando fornecida, aloca `operational_version + 1`, persiste fatos e estado corrente, e grava outbox. Falha em qualquer passo reverte integralmente. Índice único do event stream é última defesa concorrente. Repositórios exigem transação explícita.

## Limites/proteções

- Não criar triggers de retenção nem jobs de limpeza. Restrição append-only protege fatos e auditoria.
- `down` remove somente objetos próprios da Feature 004, na ordem inversa; só seria utilizado em banco descartável vazio e após autorização explícita.
- Payload dimensional JSONB precisa validador de domínio e limite máximo de bytes de transporte definido em configuração; não arredondar decimal. A representação decimal deve permanecer string no JSON para evitar perda IEEE-754.
- A tabela de grants usa revogação temporal, evitando apagar o histórico de autorização. A checagem do grant considera `revoked_at IS NULL` dentro da transação.

## Pontos técnicos a revisar antes da ativação

- Aprovar limite de tamanho para dimensões/payload e nomes de constraints/índices.
- Confirmar se `operational_version` no cabeçalho é incrementado para todo evento do agregado (proposta: sim).
- Confirmar comportamento de `actor_user_id` em eventos automáticos; proposta é identidade de sistema explícita, sem inventar usuário humano.
- A decisão funcional de FIFO foi aprovada: `queuedAt ASC`, desempate por sequência numérica setorial ASC dentro do setor, sem mistura de setores; paginação usa a mesma ordenação total.
- Confirmar o contrato técnico de caminhos HTTP e cursor, sem modificar regras públicas já aprovadas.
