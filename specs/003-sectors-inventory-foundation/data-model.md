# Data Model — Feature 003

Este modelo é conceitual e de planejamento. Nenhum Model, migration ou banco foi alterado. Nomes
físicos são propostas e devem ser normalizados no desenho de migration; migrations existentes não
serão editadas.

## Entidades e relações

```text
Sector 1 ── N Warehouse 1 ── N Material
User N ── N Sector (UserSector)
Warehouse 1 ── N MaterialCategory 1 ── N MaterialSubcategory
Material 1 ── 1 MaterialBalance
Material 1 ── N InventoryEvent
InventoryEvent 1 ── 0..N InventoryEvent (compensation_of)
InventoryEvent 0..1 ── 0..1 InventoryEvent (return_of, quando identificável)
InventoryEvent 1 ── 0..1 OutboxMessage (na mesma transação quando publicado)
PostgreSQL event stream ── replay/rebuild ──> MongoDB read projections
User 1 ── 0..1 InventoryPinCredential
User 1 ── N InventorySecurityAudit
```

## Propostas de tabela/campos

### `sectors`

- `id UUID PK`; `code VARCHAR UNIQUE NOT NULL` (`VIDRACARIA`, `MARCENARIA`); `name`;
  timestamps `TIMESTAMPTZ`.
- Seed inicial dos dois setores via migration aditiva revisável; não criar seeds destrutivos.
- Decidir idempotência/estratégia de seed para múltiplos ambientes na implementação.

### `user_sectors`

- `user_id UUID FK users(id) ON DELETE RESTRICT`; `sector_id UUID FK sectors(id) ON DELETE RESTRICT`;
  `created_at`; `granted_by UUID FK users(id) ON DELETE RESTRICT`; chave primária/unique
  `(user_id, sector_id)`.
- Revogar remove o vínculo atual e mantém evento em `sector_authorization_audits` append-only.
  GRANT/REVOKE registram ator, usuário afetado, setor, ação, motivo obrigatório e timestamp do
  servidor. FKs `RESTRICT`; sem expurgo/anonimização automática enquanto política não for aprovada.
- Escopo atual no backend consulta UserSector a cada comando.

### `warehouses`

- `id UUID PK`; `sector_id UUID FK sectors(id) ON DELETE RESTRICT NOT NULL`; `code`/`name`; status
  `ACTIVE`/`INACTIVE`; timestamps; índice por `sector_id`.
- Nome único por setor, ignorando caixa e espaços externos: aparar o valor no serviço e impor no
  PostgreSQL índice único `(sector_id, lower(btrim(name)))`.
- Almoxarifado com histórico não pode ser excluído fisicamente; inativação preserva histórico e
  impede novas movimentações ordinárias. Não fornecer hard-delete.

### `material_categories` / `material_subcategories`

- Category: `id UUID PK`, `warehouse_id FK RESTRICT`, `name`, normalização definida tecnicamente,
  `active`, timestamps. Unique funcional `(warehouse_id, normalized_name)`.
- Subcategory: `id UUID PK`, `category_id FK RESTRICT`, `name`, `active`, timestamps; unique
  `(category_id, normalized_name)`.
- Impedir subcategoria de categoria/material de outro almoxarifado. Preferir FKs compostas (ou
  triggers/validação transacional se Sequelize/Migration não modelar facilmente) para impor escopo
  também no PostgreSQL.
- Categorias referenciadas não são fisicamente excluídas; inativação não propaga para Material.

### `materials`

- `id UUID PK`; `warehouse_id FK RESTRICT`; `category_id FK RESTRICT`; `subcategory_id NULL FK
  RESTRICT`; `code VARCHAR UNIQUE NOT NULL` e imutável; `name`, `description`; `unit_code`;
  `image_object_key NULL`; `min_quantity NUMERIC`; `location`; `active`; `qr_token_hash` ou token
  opaco persistido com proteção apropriada; timestamps.
- `initialQuantity` é atributo de comando de criação, não coluna mutável de Material: string decimal
  exata, zero ou positiva conforme escala da unidade. Uma transação cria Material, `material_balances`
  com essa quantidade e um evento `OPENING` com delta igual à quantidade, saldo anterior zero, saldo
  posterior igual à quantidade, `reason_code='INITIAL_STOCK'` e `performed_by` do ator autenticado.
  Alterações posteriores são exclusivamente eventos do ledger.
- Unicidade global do código aprovada. QR opaco, estável e revogável: recomendação armazenar digest
  do token aleatório e emitir token uma vez; definir operação de reemissão/expiração. Não embutir
  credenciais ou comandos no QR.
- Material com histórico não recebe DELETE físico. Inativar exige saldo zero; a checagem e mudança
  ocorrem transacionalmente sob lock do saldo, após movimentos autorizados zerarem quantidade.
- Unidade é imutável quando saldo/eventos existem; alterar unidade requer plano de conversão
  explicitamente aprovado, não implícito.

### `material_balances`

- `material_id UUID PK/FK materials(id) ON DELETE RESTRICT`; `quantity NUMERIC NOT NULL` com
  scale validada contra unidade;
  `updated_at TIMESTAMPTZ`; `version BIGINT` opcional se necessário além de row lock.
- `CHECK quantity >= 0`; usar `NUMERIC` exato sem escolher precisão máxima `p` arbitrária. Validar
  escala e finitude no domínio; definir limite técnico de dígitos/request por PostgreSQL 17,
  parser/driver e proteção de payload, sem convertê-lo em regra de negócio de quantidade.
- Cadastro cria a linha inicial dentro da mesma transação Material + OPENING. O índice/PK por
  `material_id` impede saldo duplicado; não usar `Number` no processamento do valor inicial.
- `s=0` para `un`, `s=3` para unidades fracionáveis aprovadas (`kg`, `g`, `m`, `cm`, `L`, `mL`,
  `m²`). Rejeitar casas excedentes; não arredondar. `m³` só após necessidade operacional confirmada.
- Restrições cross-table de scale/unit podem exigir coluna de snapshot/código unidade no saldo ou
  trigger; preferir regra `unit_code` + precisão no catálogo controlado e constraints explícitas.
- Não aceitar float como representação interna de cálculo; NUMERIC PostgreSQL e string decimal no
  driver/API evitam perda via IEEE-754.

### `inventory_events` (append-only)

- `id UUID PK`; `material_id FK RESTRICT`; `warehouse_id FK RESTRICT`; `event_type CHECK IN
  ('OPENING','IN','OUT','RETURN','ADJUSTMENT')`; `quantity/delta NUMERIC(p,s)`;
  `balance_before`, `balance_after NUMERIC(p,s)`; `unit_code_snapshot`; `reason_code`; `description`;
  `occurred_at TIMESTAMPTZ` (server); `sequence BIGINT` por material; `performed_by UUID NULL FK
  users ON DELETE RESTRICT`; `withdrawn_by UUID NULL FK users ON DELETE RESTRICT` (ou tabela de
  colaboradores se aprovada); `received_by UUID NULL FK users ON DELETE RESTRICT`;
  `authorized_by UUID NULL FK users ON DELETE RESTRICT`; `command_origin` controlado;
  `compensates_event_id NULL FK inventory_events ON DELETE RESTRICT`; `return_of_event_id NULL FK
  inventory_events ON DELETE RESTRICT`; `idempotency_request_id FK` quando arquitetura separar
  receipts; referência opcional OS `VARCHAR(64)` sem FK; timestamps somente se semântica acordada.
- Constraints: quantidades/sinais coerentes com tipo; abertura não negativa e única por Material;
  `balance_before + effective_delta = balance_after`; `balance_after >= 0`; uma sequência única por
  Material; compensação não pode referenciar outro Material sem regra aprovada.
- `OPENING` única por Material via índice parcial `UNIQUE(material_id) WHERE event_type='OPENING'`.
- Não conceder rotas de update/delete. Para reforço contra outros writers, considerar privilégios
  SQL/trigger append-only como decisão de implementação e compatibilidade operacional.
- Eventos não guardam PIN, hash de PIN, senha, token QR ou segredo.

### Integração e projeções (arquitetura aprovada; esquema físico pendente)

- Transactional Outbox registra, atomicamente com o evento canônico PostgreSQL destinado à
  publicação, um envelope versionado com `event_id`, tipo, agregado, instante e payload.
  Outbox não substitui `inventory_events` nem é fonte de saldo.
- RabbitMQ transporta envelopes assincronamente com entrega at-least-once. Consumers mantêm dedupe
  durável por `(consumer, event_id)` e só confirmam após persistirem o efeito local; falha/reentrega
  não pode duplicar a projeção.
- MongoDB contém projeções reconstruíveis de saldo, relatórios e consultas de histórico. A projeção
  encapsula o histórico em `movements`, conforme contrato; precisa suportar replay/rebuild e
  reconciliação comparando saldos/contagens com PostgreSQL.
- Requisito incremental de 12/11/2026: snapshots versionados são obrigatórios, recuperáveis e apenas aceleram replay; não são fonte canônica nem substituem/excluem eventos. A política de geração será documentada e testada com base em volume e desempenho medidos, sem limiares funcionais inventados. A projeção lógica encapsula `movements`, mas sua persistência/paginação deve ser escalável, não carregar todo o histórico em memória e respeitar limites físicos MongoDB; manter `operationId` em cada movimento.
- Os nomes físicos/índices das coleções MongoDB e tabelas Outbox/dedupe, política de ordenação,
  versionamento, retry/DLQ e checkpoint de consumer exigem contrato técnico aprovado antes de
  migration ou implementação. Redis não integra esta arquitetura.

### `movement_idempotency`

- Proposta para tabela própria: `id UUID PK`; `warehouse_id FK RESTRICT`; `operation_id UUID NOT NULL`;
  `principal_type CHECK
  ('USER','PIN_AUTHORIZER')`; `principal_id UUID` (FK condicional difícil: validar via Service e/ou
  constraints/trigger); `idempotency_key VARCHAR NOT NULL`; `request_hash CHAR(64) NOT NULL`;
  `response_status`; `response_body JSONB`; `event_id NULL FK inventory_events ON DELETE RESTRICT`;
  `created_at`; `expires_at` somente se política de retenção for aprovada.
- Constraints: `UNIQUE(warehouse_id, principal_type, principal_id, idempotency_key)` (escopo
  aprovado) e `UNIQUE(warehouse_id, operation_id)` (proteção técnica da mesma intenção lógica
  através de retries, inclusive após troca de autorizador).
- Sessão autenticada: principal `USER` + `performedBy`; QR sem sessão: principal
- `authorizedBy` no QR sem sessão. A identidade QR deve ser identificada antes da verificação do
- Retry com o mesmo `operation_id` nunca cria evento novo. Se o autorizador mudar, o comando retorna
  conflito genérico e não revela receipt; a mesma intenção deve ser retomada com o principal/chave
  originais. A autorização atual do principal original é validada antes de devolver resultado.
- Se a autorização original foi revogada, negar leitura/replay do receipt sem reaplicar movimento,
  alterar evento ou saldo. Esta escolha técnica decorre da autorização backend atual e não altera
  a semântica de ledger.
- Canonicalização inclui todos os campos semanticamente mutáveis do comando (material/QR resolvido,
  retirante, quantidade, descrição, motivo, referência OS e tipo) e exclui headers
  transitórios/segredos. Não incluir o PIN em claro nem seu hash individual no digest; incluir
  autorizador identificado. Definir canonical serializer estável e teste de equivalência.
- Hash de request e resultado são persistidos na mesma transação de evento/saldo; mesma chave +
  mesmo hash retorna o mesmo resultado; hash diferente => conflito.
- Retenção/expiração da chave é pendência ligada à política de retenção. Não expirar chave enquanto
  ainda houver risco de retry duplicar evento.

### `inventory_pin_credentials` / `inventory_security_audits`

- Credencial proposta: `user_id UUID PK/FK users(id)`, `pin_hash`, `status`/revoked, timestamps,
  `failed_attempts` e `blocked_until` ou registro separado de tentativas. `pin_hash` fica apenas
  neste armazenamento restrito, nunca em evento.
- Auditoria append-only: ator administrativo, alvo, ação (conceder/trocar/revogar PIN, tentativa,
  bloqueio/desbloqueio, atribuir/revogar responsável), instante UTC, motivo e metadados mínimos;
  sem segredo/hash. Não escolher prazo de retenção sem política aprovada.
- Pin owner é User designado; alcance setorial e regra de designação/revogação dependem de negócio.
- 5 falhas/15 minutos e bloqueio 15 min são regra aprovada. Contagem deve ser atômica sob requests
  concorrentes. Resposta genérica para ID/PIN inválido e bloqueio; não revelar existência de conta.

## Índices/constraints propostos (além das PK/FK)

- Unique `sectors.code`; unique user/sector; unique warehouse-scoped category name;
  unique category-scoped subcategory name; unique `materials.code`; unique digest/token QR;
  unique `(material_id, sequence)`; unique partial opening por material; chave idempotente no
  escopo aprovado.
- Índices para `warehouses(sector_id)`, `materials(warehouse_id, active)`,
  `inventory_events(material_id, occurred_at DESC, sequence DESC)`,
  `inventory_events(warehouse_id, occurred_at DESC)`, tipo/atores conforme planos de query e
  auditoria PIN por titular/tempo.
- Usar `ON DELETE RESTRICT` para identidades/material/categoria referenciadas por ledger; evitar
  cascata destrutiva. `SET NULL` só se anonimização futura formalmente aprovada e preservar
  identificador pseudônimo de auditoria.

## Transações e invariantes

1. Validação do contrato e autenticação/escopo; identificadores resolvidos no backend.
2. Para QR: lookup de autorizador pelo ID; checar status/designação/setor; aplicar bloqueio/limite;
   validar PIN e registrar falhas/auditoria sem revelar conta.
3. Iniciar transação; obter/inserir receipt por escopo de principal/chave e por `operation_id`.
   Tratar concorrência pelas constraints únicas; para mesma chave, exigir mesmo principal e hash.
   `operation_id` já associado a principal diferente retorna conflito genérico sem receipt; após
   revogação do principal original, negar replay. Em nenhum caso alterar autoria do evento existente.
4. Lock `material_balances` `FOR UPDATE`; material deve estar ativo; unidade/escala válida.
5. Calcular delta pelo tipo; rejeitar insuficiência; validar aprovação de abertura/ajuste.
6. Inserir evento com before/after, autoria, justificativa e referência; atualizar saldo; persistir
   resultado da idempotência; commit.
7. Qualquer falha faz rollback integral. Tentativa inválida de PIN e trilha de segurança podem
   precisar commit independente da transação de estoque para não serem perdidas no rollback.

## Responsabilidades de aplicação

- **Controller**: validar envelope, tipo/conteúdo básico e headers (`Idempotency-Key`), extrair
  sessão se existente, selecionar o fluxo QR sem sessão e mapear erros de domínio para HTTP; não
  calcular saldo nem confiar em autoria do payload.
- **StockMovementService**: aplicar autorização atual, verificar PIN quando aplicável, resolver
  principal efetivo/origem, canonizar request, iniciar transação, reservar idempotência, bloquear
  saldo, validar regras por tipo, persistir evento/saldo/receipt e commit/rollback.
- **StockReportService**: aplicar escopo autorizado, executar consultas agregadas/cursores no
  PostgreSQL, compor totais por material e unidade e oferecer reconciliação entre saldo e ledger.
- **Repositories**: encapsular Sequelize queries e aceitar a mesma `transaction` explicitamente;
  nenhuma chamada crítica de saldo/evento/receipt pode escapar da transação.
- **Model/constraints**: declarar campos/associações sem substituir constraints SQL; evento não tem
  caminho de edição/exclusão no repository de domínio.

## Tratamento de erros planejado

- Rejeição antes do commit não altera saldo, evento nem receipt de sucesso. Falhas de tentativa PIN
  devem ser registradas por caminho de auditoria transacional próprio para não serem perdidas com o
  rollback do movimento.
- Erros de validação/unidade/sinal: `400`; sem sessão: `401`; role/setor não autorizado: `403`;
  recurso fora do escopo: resposta que não permite enumeração; chave/operationId divergente,
  unicidade ou saldo insuficiente: conflito de domínio (`409` conforme contrato); throttling PIN:
  `429` genérico. Alinhar envelope ao tratamento global atual antes de implementação.
- Não retornar PIN, hash, token QR, saldo em falha pública, SQL ou detalhes que permitam enumeração.

## Pendências de negócio e prontidão de tasks

As lacunas abaixo não bloqueiam `/speckit.tasks` globalmente; devem virar gates nas tasks das
capacidades correspondentes. Soluções puramente técnicas estão registradas no modelo acima.

- Quem pode registrar primeira contagem, quem é `admin` aprovador e qual fonte/corte/evidência
  documental de saldo inicial.
- Política formal de retenção/anonimização de ledger, pessoas, logs e receipts continua pendente;
  não implementar expurgo automático. Auditoria setorial é append-only e usa FKs `RESTRICT`.
- Processo administrativo de criação, troca, recuperação e desbloqueio do PIN; quem designa
  responsável e se este é global ou setorial.
- Política formal de retenção e anonimização para ledger, pessoas, logs/auditoria e registros
  idempotentes.
- Dado distintivo permitido para lista de retirantes e existência/semântica de entidade de
  funcionário separada de `User`.
- Magnitude máxima operacional não foi aprovada. Para não inventar limite funcional, usar PostgreSQL
  `NUMERIC` exato com scale definida, sem declarar `p` arbitrário; aplicar proteção técnica de
  tamanho de payload/dígitos no contrato/parser. Se houver exigência de precisão limitada por
  coluna, obter valor máximo de negócio antes da migration.
- G6 funcionalmente decidido: `America/Sao_Paulo`, consultas até 12 meses, intervalo semiaberto,
  keyset/cursor opaco protegido, padrão 25/máximo 100 e autorização revalidada. Implementação ainda
  deve definir tecnicamente proteção/versão do cursor, desempate único e marco de leitura.
- G5 funcionalmente decidido: dois buckets MinIO e ciclo seguro de substituição conforme spec. Validar
  operacionalmente buckets, credenciais e permissões antes de habilitar; política de QR permanece
  conforme decisões específicas já aprovadas.
- G4 parcialmente decidido: ledger e autoria original preservados, revogação/desativação quando
  aplicável; prazos de retenção dependem de análise jurídica/operacional, sem expurgo automático.
- Retry após revogação: solução técnica proposta acima — revalidar permissão; negar receipt se
  revogado; nunca reaplicar movimento nem divulgar a principal diferente. Não é gate para tasks do
  mecanismo transacional.

## Migração e rollback (diretrizes de design)

- Migrations aditivas em ordem explícita; tabelas novas isoladas do legado; índices e FKs novos.
- Seed de setores inicial e idempotente; definir `down` apenas para ambiente descartável/rollback
  seguro, sem apagar dados de produção. Operação reversa destrutiva não deve ser automatizada.
- Sem importação de `Product.quantity` ou dos `stock_movements` legados; Material nasce apenas com
  abertura aprovada pós-corte.
- Deploy separado: expand schema → deploy compatível → validação → ativação gradual por setor;
  rollback da aplicação preserva schema e dados. Expurgo/rollback de dados exige procedimento
  aprovado e backup verificável.