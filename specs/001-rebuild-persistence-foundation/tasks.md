---
description: "Tarefas rastreáveis para Fundação Técnica e Reconstrução da Persistência"
---

# Tasks: Fundação Técnica e Reconstrução da Persistência

**Entradas lidas**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/baseline-operations.md` e `.specify/memory/constitution.md`.

**Escopo**: PostgreSQL é a fonte de verdade; Sequelize e `sequelize-cli` permanecem. Yarn Classic com `yarn.lock` é o único gerenciamento de dependências. Migrations legadas em `src/database/migrations/` permanecem intactas.

**Fora de escopo**: tabelas/Models de domínio; Auth; estoque; OS; Outbox; mensageria; MongoDB; Redis; Kafka; CQRS; microsserviços; TypeScript; preservação/cutover de dados; e qualquer destruição automática.

**Formato**: `[P]` indica paralelismo depois das dependências; `[US#]` indica história primária. Referências incluem FR, NFR, SC, decisões de `research.md` (D1–D8) e contrato operacional (CO).

## Dependências globais

1. T001–T006: preparação e decisões aprovadas. T005 e T006 são gates efetivos e obrigatórios antes de qualquer conexão administrativa, bootstrap protegido, invocação de CLI, criação/inspeção de `baseline_meta`, schema técnico ou DDL de baseline; nenhuma entrada operacional pode ignorá-los. A observação não destrutiva de `status` também depende de T006: exige adaptador autenticado, identidade efetiva autorizada e destino isolado aprovado, mas não usa o preflight destrutivo T012 nem autoriza `apply`.
2. T007 é pré-requisito de T010–T016 e T042–T049; T008/T009 são pré-requisitos de T010–T012; T010 precede T011; T011/T012/T013/T015 precedem T016. T016 é apenas entrada operacional e delega ao serviço T030: não orquestra bootstrap, CLI ou validação diretamente.
3. T017–T019 são testes negativos bloqueantes: podem ser escritos antes das implementações correspondentes T007–T016, mas sua execução/aprovação é obrigatória antes da aprovação/merge dessas implementações. Nenhum teste negativo autoriza CLI, DDL ou conexão administrativa sem os preflights aplicáveis.
4. T020–T025 são evidências de integração bloqueantes da US1: podem ser escritos antecipadamente, porém T023/T024/T025 só podem ser executados após T032 disponibilizar suas fixtures; T026 depende de T005; T027 depende de T007, T013–T015 e T026; T028 define validação pós-CLI e depende de T005, T014, T015 e T027; T029 depende de T028; T030 é o único orquestrador e depende de T005/T006, T007, T010–T015 e T027–T029. Em T030, `apply` depende obrigatoriamente de T012 e de banco existente/vazio; `status` depende do contrato aprovado de observação autenticada não destrutiva, com evidência completa de identidade, metadata, histórico e schema, sem CLI ou DDL. T031 depende de T006, T013, T028 e T029 e materializa somente essa observação; T033 é gate documental/operacional antes de aprovar US1.
5. T034–T041: transações/camadas (US2), paralelizáveis com US1 após T007–T009 e T003. T034–T036 podem ser escritos antes da implementação, mas sua execução/aprovação é bloqueante antes da aprovação das respectivas implementações T037–T040; T035 só é executado após T038/T039 disponibilizarem suas fixtures de prova.
6. T042/T043 podem ser escritos antes da implementação, mas sua execução/aprovação é bloqueante antes da aprovação de T045–T047. T046 (factory) depende de T007/T008; T045 (lifecycle) depende de T007/T008/T046 e é estritamente separado de bootstrap/baseline; T047 depende de T045/T046. Para US4, T048 depende de T007/T008/T012; T044 depende de T048 e bloqueia a aprovação da política de cleanup; T049 depende de T001 e T048.
7. T050–T054: documentação e validação final, depois das tarefas implementadas e das evidências correspondentes.

---

## Phase 1 — Preparação, estrutura e gates humanos

**Propósito**: preparar a feature sem conectar PostgreSQL, criar migrations ou criar tabelas.

- [x] T001 Atualizar `package.json` somente com scripts Yarn Classic para preflight, bootstrap protegido, baseline/status e testes nativos, sem nova dependência. (NFR-002, NFR-005, SC-005)
- [x] T002 Preservar o `package-lock.json` local não rastreado, sem removê-lo nem versioná-lo; registrar em `.gitignore`, se ainda não estiver, a proibição de adicionar/gerar `package-lock.json` ou qualquer segundo lockfile. Manter `yarn.lock` como único lockfile oficial e rastreado e validar que fluxos desta feature não geram outro lockfile. (Decisão Yarn Classic, NFR-002)
- [x] T003 [P] Criar estrutura vazia em `src/infrastructure/config/`, `src/infrastructure/lifecycle/`, `src/infrastructure/persistence/`, `src/application/use-cases/`, `src/database/baseline/`, `scripts/database/baseline/`, `tests/unit/`, `tests/integration/` e `tests/support/`, sem alterar `src/database/migrations/`. (D1, FR-020, FR-021)
- [x] T004 [P] Criar `.env.example` e contrato de configuração não versionada para `development-rebuild`, `test` e `inventory-readonly`, incluindo identidade de instância/destino, referência protegida do original e caminho canônico, sem segredos. (FR-015, FR-016, CO entrada)
- [x] T005 **[DECISÃO APROVADA]** Configurar o baseline exclusivamente com `migrationStorage: 'sequelize'`, `migrationStorageTableName: 'SequelizeMetaBaseline'` e `migrationStorageTableSchema: 'baseline_meta'`, identificando metadata como `baseline_meta.SequelizeMetaBaseline`. Usar caminho/configuração próprios, sem `.sequelizerc` legado ou `search_path`; preservar `public.SequelizeMeta` e migrations legadas independentes/intactas. Após preflights aprovados, se `baseline_meta` existir, inspecionar schema/objetos antes de uso e bloquear divergência sem remover, recriar ou sobrescrever; se ausente, permitir criação somente pelo CLI controlado. (D4, FR-006, FR-007, SC-007, CO metadata)
- [x] T006 **[DECISÃO APROVADA — EVIDÊNCIA LOCAL TEST]** Adotar proteção fail-closed por allowlist explícita de destinos autorizados e denylist de identidades protegidas, incluindo o original. Cada identidade contém ambiente, host, porta, database e perfil/identificação lógica; operação destrutiva exige ambiente explicitamente de desenvolvimento, campos completos, correspondência integral da conexão efetiva com exatamente um destino autorizado, ausência em toda identidade protegida e nenhuma ambiguidade/divergência. Para o `test` local, a identidade física foi comprovada por inspeção Docker read-only no host confiável de `postgres-alves-glass-test` e correlação com sessão PostgreSQL autenticada no runner da rede dedicada (`postgres-test:5432`); divergência bloqueia e não há fallback para `localhost:5434`. Ed25519 permanece alternativa opcional para outros ambientes. `status` não destrutivo não autoriza operação destrutiva. (D2, FR-009, FR-010, SC-007)

**Checkpoint**: T005 aprovada com `baseline_meta.SequelizeMetaBaseline`; T006 aprovada quanto ao mecanismo fail-closed, com registros reais de allowlist/denylist ainda pendentes de responsável. `yarn.lock` permanece o único lockfile oficial/rastreado, enquanto eventual `package-lock.json` local não rastreado é preservado e ignorado; sem operação PostgreSQL.

---

## Phase 2 — Configuração, identidade e preflights bloqueantes

**Propósito**: impedir conexão administrativa, CLI, schema técnico ou DDL quando instância, destino, caminho ou perfil forem inseguros.

- [x] T007 Implementar `src/infrastructure/config/persistence-config.js` para leitura/validação centralizada, sem efeito de importação, com perfis reconhecidos e redaction de segredos. (D7, FR-015, FR-016, NFR-002)
- [x] T008 [P] Implementar `src/infrastructure/persistence/target-identity.js` para comparar ambiente, host, porta, database e perfil/identificação lógica da conexão efetiva contra allowlist de destinos autorizados e denylist de identidades protegidas, incluindo o original; ausência, ambiguidade ou divergência bloqueia. (D2, FR-009, SC-007)
- [x] T009 [P] Implementar `src/infrastructure/persistence/operation-result.js` com `validated`, `blocked`, `instance-validated`, `database-created`, `rebuild-complete`, `already-current`, `migration-already-recorded` e `recovery-required`. (D6, FR-011, FR-012)
- [x] T010 Implementar `src/infrastructure/persistence/instance-preflight.js`, bloqueando antes de conexão administrativa e `CREATE DATABASE` ambiente não explicitamente de desenvolvimento, allowlist/denylist ausentes, instância original/protegida, identidade ambígua, host/porta ambíguos, perfil inválido/ausente, campos incompletos ou divergência entre configuração e identidade efetiva. (D2, FR-009, SC-007, CO 1–2)
- [x] T011 Implementar `src/infrastructure/persistence/protected-database-bootstrap.js`: após T010, criar somente database isolado declarado e ausente; proibir `DROP DATABASE`, substituição, recriação e seleção automática do original. (D2, FR-009, FR-013, SC-007, CO 3)
- [x] T012 Implementar `src/infrastructure/persistence/database-preflight.js`: validar identidade efetiva completa contra allowlist/denylist, comparação com original/protegidos e estado vazio; bloquear banco existente não vazio fora de fluxo futuro aprovado. (D2, FR-009, FR-011, FR-013, SC-007, CO 4)
- [x] T013 Implementar `src/infrastructure/persistence/migrations-path.js`: normalizar caminho absoluto, exigir existência e igualdade com diretório canônico; bloquear caminho legado, inexistente, fixture indevida ou externo antes do CLI. (D3, FR-006, FR-010, SC-007, CO 5)
- [x] T014 Implementar `src/infrastructure/persistence/baseline-cli-config.js` com executor exclusivo, `migrationStorage: 'sequelize'`, `migrationStorageTableName: 'SequelizeMetaBaseline'`, `--config`, `--env` e `--migrations-path` explícitos, sem `.sequelizerc`. (D1, D4, FR-006, FR-007)
- [x] T015 Implementar `src/infrastructure/persistence/metadata-config.js`: exigir `migrationStorage: 'sequelize'`, `migrationStorageTableName: 'SequelizeMetaBaseline'` e `migrationStorageTableSchema: 'baseline_meta'`; nunca inferir por `search_path`, aceitar `public` ou fallback. (D4, FR-006, FR-007, CO metadata)
- [x] T016 Implementar `scripts/database/baseline/run-baseline.js` somente como entrada operacional: receber argumentos, carregar configuração e delegar para T030 (`baseline-rebuild.js`), sem conter orquestração de bootstrap, preflight, CLI, metadata ou recovery. Rejeitar argumentos/perfis inválidos e não permitir caminho alternativo que contorne os gates T005/T006 ou os preflights executados pelo serviço delegado. (D2–D4, FR-006, FR-009, SC-007, CO ordem)
- [x] T017 [P] Criar `tests/unit/configuration/persistence-config.test.js` para variável ausente, perfil inválido, identidade incompleta, ambiente incompatível e redaction. (FR-015, FR-016, NFR-002, SC-003, SC-004)
- [x] T018 [P] Criar `tests/unit/persistence/instance-preflight.test.js` e `protected-database-bootstrap.test.js` para ambiente não desenvolvimento, allowlist/denylist ausentes, instância original/protegida, identidade ambígua, perfil incompatível, divergência efetiva, banco existente e ausência de executor administrativo antes de `instance-validated`. (D2, FR-009, FR-013, SC-007)
- [x] T019 [P] Criar `tests/unit/persistence/migrations-path.test.js` e `metadata-config.test.js` para caminho inexistente/legado/não canônico, configuração diferente de `baseline_meta.SequelizeMetaBaseline`, schema implícito/incompatível e ausência de fallback por `search_path`. (D3, D4, FR-006, FR-010, SC-007)

**Checkpoint**: todo cenário inseguro retorna `blocked` antes de conexão administrativa, CLI, schema de metadata ou DDL.

---

## Phase 3 — Baseline isolado, metadata e recovery (US1 — P1)
- [x] T020 [P] [US1] Criar `tests/integration/persistence/local-postgres.integration.test.js` em PostgreSQL real isolado: preflight `test` validado, bootstrap administrativo bloqueado no profile `test`, e bootstrap declarativo de `development-rebuild` bloqueado para banco existente sem executor administrativo, sem `DROP DATABASE` e sem recriação. (D2, FR-009, FR-013, SC-007)
- [x] T021 [P] [US1] Validar em PostgreSQL real isolado que allowlist/denylist e perfil `test` autorizam somente database vazio; destino protegido e perfis inadequados retornam `blocked` antes de CLI/DDL/metadata. (D2, D3, FR-006, FR-009, FR-010, SC-007)
- [x] T022 [P] [US1] Validar em `local-postgres.integration.test.js` `baseline_meta.SequelizeMetaBaseline` após fixture canônica pelo `sequelize-cli`, com relação qualificada, `name` não nulo/PK e sem `search_path`; cleanup remove somente recursos da execução. (D4, FR-006, FR-007, FR-008)
- [x] T023 [P] [US1] Validar em PostgreSQL real o isolamento bidirecional de metadata: `baseline_meta.SequelizeMetaBaseline` e `public.SequelizeMeta` coexistem, e metadata legada não prova baseline. (D1, D5, FR-006, FR-010)
- [x] T024 [P] [US1] Validar em PostgreSQL real banco vazio, dez reexecuções registradas sem novos objetos/DDL, `migration-already-recorded` para fixture consistente e migration parcial como `recovery-required`, sem marcação/reaplicação automática. (D6, FR-011, FR-012, NFR-001, NFR-003, SC-001, SC-004)
- [x] T025 [P] [US1] Validar em PostgreSQL real que histórico legado sem inventário/estratégia explícita retorna `recovery-required` e não prova equivalência ao baseline. (D1, FR-010, SC-004)
- [x] T026 [US1] Criar executor/diretório canônico em `src/database/baseline/` e configuração em `src/database/baseline/config.cjs`, preservando `src/database/migrations/` e sem migration/tabela/Model de domínio. (D1, FR-006, FR-007, FR-020, FR-021)
- [x] T027 [US1] Implementar `src/infrastructure/persistence/baseline-cli-runner.js`, recebendo somente configuração/caminho aprovados e impedindo CLI em `blocked`. (D2–D4, FR-006, FR-009, SC-007)
- [x] T028 [US1] Implementar `src/infrastructure/persistence/metadata-validator.js` como **validador pós-CLI**, dependente de T005, T014, T015 e T027: depois de execução controlada, confirmar exclusivamente `baseline_meta.SequelizeMetaBaseline`, `name` não nulo/PK-ou-única, ausência de fallback por `search_path` e isolamento de `public.SequelizeMeta`. Não exigir metadata em banco inicialmente vazio antes do CLI; schema/tabela existentes divergentes interrompem com diagnóstico, sem correção automática. (D4, D5, FR-006, FR-007, FR-008)
- [x] T029 [US1] Implementar `src/infrastructure/persistence/migration-recovery.js`, dependente de T028, para diagnosticar — sem corrigir, criar metadata, marcar nem reaplicar migrations automaticamente — divergências entre schema efetivo e metadata: metadata ausente após tentativa, metadata em schema inesperado, nome registrado incompatível e migration parcial retornam `recovery-required` com diagnóstico preservado. (D6, FR-011, FR-012, NFR-003)
- [x] T030 [US1] Implementar `src/infrastructure/persistence/baseline-rebuild.js` como **único orquestrador** do baseline, dependente de T005/T006, T007, T010–T015, T027 (CLI), T028 (validação de metadata) e T029 (diagnóstico). No modo `apply`, exigir T012 validado para banco existente e comprovadamente vazio antes de CLI; então CLI controlado → validação pós-CLI → `rebuild-complete`. No modo `status`, exigir adaptador autenticado e estritamente read-only que comprove identidade efetiva autorizada em destino isolado, relação canônica `baseline_meta.SequelizeMetaBaseline` qualificada, histórico completo do caminho canônico e consistência de schema; retornar `already-current` somente com essa evidência completa, `recovery-required` para inconsistência comprovada e `blocked` para prova ausente, ambígua ou insuficiente. Validado em PostgreSQL isolado `test` com migration técnica canônica, gate Docker+sessõo e status `already-current` sem DDL. `status` nunca executa CLI, bootstrap, DDL ou migrations e nunca autoriza/promove `apply`; T012 não é enfraquecida nem reutilizada para banco não vazio. (D2, D4, D6, FR-006, FR-009, FR-011, FR-012, FR-013, NFR-001, SC-007)
- [x] T031 [US1] Implementar `scripts/database/baseline/status-baseline.js` não destrutivo, dependente de T006, T013, T028 e T029 e limitado ao adaptador autenticado de observação, identidade efetiva validada, destino isolado aprovado, caminho canônico, metadata baseline e evidência completa de schema/histórico. O comando local foi validado no runner efêmero da rede de teste contra `postgres-test:5432`, retornando `already-current` após baseline canônico e permanecendo somente leitura. Nunca delega a CLI, bootstrap, DDL, migrations ou `apply`. (D1, D3, D5, FR-006, FR-012)
- [x] T032 [US1] Criar fixtures somente em `tests/support/database/baseline-migrations/` e `legacy-migrations/`, incluindo falha parcial controlada; não criar migration de produção nem alterar legado. (D1, D6, FR-010, FR-012, FR-020)
- [ ] T033 [US1] Proibir comandos drop/recreate no wrapper e documentação; recriação de banco existente é fluxo futuro separado que exige solicitação, preflight e aprovação próprias. (D2, D6, FR-009, FR-012, FR-013, FR-014, SC-007)

**Checkpoint US1**: original, ambiguidade, caminho errado, banco existente, metadata em schema inesperado e migration parcial são bloqueados ou exigem `recovery-required`, sem alteração indevida.

---

## Phase 4 — Camadas e propagação de transações (US2 — P1)

- [ ] T034 [P] [US2] Criar `tests/unit/persistence/transaction-boundary.test.js`: apenas Use Case inicia/confirma/reverte; Repository recebe transação; Controller não controla transação/acessa Model. (D7, FR-001 a FR-004)
- [ ] T035 [P] [US2] Criar `tests/integration/persistence/transaction-probe.test.js` com tabelas técnicas efêmeras: duas gravações, falha controlada, rollback integral e erro previsível. O teste pode ser escrito antes, mas sua execução depende de T038/T039 disponibilizarem as fixtures de Use Case/Repository de prova. (FR-001, FR-003 a FR-005, NFR-003, SC-002, SC-004)
- [ ] T036 [P] [US2] Criar `tests/unit/persistence/layer-boundaries.test.js` para dependências permitidas/proibidas entre Routes, Controllers, Use Cases, Repositories e Models. (FR-001 a FR-003, NFR-004)
- [ ] T037 [US2] Implementar `src/infrastructure/persistence/transaction-manager.js` com commit/rollback centralizado pelo Use Case. (D7, FR-004)
- [ ] T038 [US2] Criar `tests/support/persistence/transaction-probe-use-case.js` como fixture de prova, não como componente de produção, propagando uma transação a múltiplos Repositories técnicos de teste e sem regra/tabela de domínio. (D7, FR-003, FR-004, FR-020)
- [ ] T039 [US2] Criar `tests/support/persistence/transaction-probe-repository.js` como fixture de prova, recebendo transação explícita e sem commit/rollback próprio; não adicionar Repository temporário à aplicação sem justificativa arquitetural aprovada. (D7, FR-001, FR-004, FR-020)
- [ ] T040 [US2] Implementar `src/infrastructure/persistence/persistence-error-mapper.js`, sem expor SQL, URL, credenciais ou segredos. (FR-005, FR-016, NFR-002)
- [ ] T041 [US2] Documentar `docs/architecture/persistence-boundaries.md`, incluindo Controller → Use Case → Repository e ponto único de início transacional. (FR-001 a FR-005, NFR-005, SC-005)

---

## Phase 5 — Lifecycle e infraestrutura de testes (US3/US4 — P2)

- [ ] T042 [P] [US3] Criar `tests/unit/configuration/persistence-lifecycle.test.js` para ordem validar → preflight → conectar → prontidão e shutdown idempotente após falha. (D7, FR-015, FR-017, SC-003)
- [ ] T043 [P] [US3] Criar `tests/integration/configuration/startup-failure.test.js` para variável ausente, perfil inválido, PostgreSQL isolado indisponível, liberação de recursos e redaction. (FR-015 a FR-017, NFR-002, SC-003, SC-004)
- [ ] T044 [P] [US4] Criar `tests/integration/persistence/test-isolation.test.js`, dependente de T048, para provar cleanup somente no perfil `test`, após validação de identidade/perfil e apenas de recursos comprovadamente criados pela própria execução de teste; proibir cleanup contra original/desenvolvimento e proibir `DROP DATABASE` como rotina de cleanup. (D8, FR-018, FR-019, SC-001, SC-004, SC-007)
- [ ] T046 [US3] Refatorar `src/database/index.js` para factory explícita de conexão Sequelize, sem conexão por importação e sem alterar Models de domínio; a factory é consumida por T045. (FR-015, FR-017, FR-020)
- [ ] T045 [US3] Implementar `src/infrastructure/lifecycle/persistence-lifecycle.js`, dependente de T046, para o startup normal: validar configuração e identidade, consumir a factory Sequelize, estabelecer conexão, verificar prontidão e liberar recursos em ordem reversa. O lifecycle **não** executa bootstrap, `CREATE DATABASE`, migrations, criação de schema, aplicação de baseline ou qualquer DDL; essas operações permanecem explícitas e independentes em scripts de baseline. (D7, FR-015, FR-017, NFR-002, SC-003)
- [ ] T047 [US3] Refatorar `src/server.js` para consumir T045, aguardar prontidão e encerrar graciosamente, sem alterar rotas, Auth, OS, estoque ou Outbox. (FR-017, SC-003, SC-006)
- [x] T048 [US4] Implementar `tests/support/database/postgres-test-environment.js`, dependente de T007, T008 e T012, com política de cleanup restrita ao perfil `test`: validar perfil e identidade antes de cada setup/cleanup; remover automaticamente apenas recursos comprovadamente criados pela execução atual; nunca limpar original ou banco de desenvolvimento; nunca usar `DROP DATABASE` como rotina de cleanup. (D8, FR-018, FR-019, SC-007)
- [ ] T049 [US4] Configurar `tests/support/test-runner.js` e scripts Yarn para testes unitários/integração segregados por perfil, sem dependência ou lockfile novo. (D8, FR-018, FR-019, NFR-002)

---

## Phase 6 — Validação final e documentação

- [ ] T050 [P] Atualizar `specs/001-rebuild-persistence-foundation/quickstart.md` com scripts finais, variáveis aprovadas, bootstrap protegido e validações sem atingir original. (NFR-005, SC-005, SC-007)
- [ ] T051 [P] Atualizar `contracts/baseline-operations.md` e `data-model.md` com a decisão aprovada em T005, resultados expostos e limites de recovery; não alterar Constituição nem plano de remediação. (D4, FR-006, FR-011, FR-012)
- [ ] T052 [P] Criar `docs/architecture/persistence-foundation-verification.md` com matriz de evidências para FR-001–FR-021, NFR-001–NFR-005, SC-001–SC-007, decisões, contratos e testes. (NFR-005)
- [ ] T053 Executar apenas após implementação as validações permitidas: `yarn test` no perfil `test` isolado, checagens estáticas/documentais e `git diff --check`; registrar resultados, limitações e ausência de segredos. (FR-018, FR-019, SC-001 a SC-005)
- [ ] T054 Revisar contra Constituição e `docs/audit/remediation-plan.md`, registrando que migrations legadas, domínio, Auth, OS, estoque, Outbox/mensageria e tecnologias proibidas não entraram no escopo. (FR-020, FR-021, SC-006)

---

## Rastreabilidade resumida

| Origem | Tarefas |
| --- | --- |
| US1 — baseline limpo isolado | T010–T016, T020–T033 |
| US2 — integridade transacional | T034–T041 |
| US3 — configuração/lifecycle | T007, T017, T042–T047 |
| US4 — testes repetíveis | T018–T025, T044, T048–T049, T053 |
| FR-001–FR-005 | T034–T041 |
| FR-006–FR-014 | T008–T016, T020–T033, T051 |
| FR-015–FR-017 | T004, T007, T017, T042–T047 |
| FR-018–FR-019 | T020–T025, T044, T048–T049, T053 |
| FR-020–FR-021 | T003, T026, T032, T046–T047, T054 |
| D1 baseline separado | T013–T014, T023, T025–T027, T030–T032 |
| D2 bootstrap em estágios | T005–T006, T008, T010–T012, T016, T018, T020–T021, T030, T033 |
| D3 caminho é identidade | T013, T019, T021, T027, T031 |
| D4 metadata/schema `baseline_meta` explícito | T005, T015, T019, T022, T028–T030, T051 |
| D5 isolamento bidirecional | T023, T028, T031 |
| D6 estados/recovery | T009, T024, T029–T030, T033 |
| D7 config/lifecycle/transações | T007, T034–T041, T045–T047 |
| D8 Node nativo + PostgreSQL real | T020–T025, T035, T043–T044, T048–T049 |
| SC-001–SC-007 | T024/T044/T053; T035; T017/T042–T047; T017–T025/T035/T043–T044; T001–T004/T041/T050/T052; T003/T026/T032/T047/T054; T005–T006/T008/T010–T013/T016/T018–T022/T033/T048 |

## Aprovações e pendências humanas

1. **T005 aprovada:** metadata exclusiva em `baseline_meta.SequelizeMetaBaseline`; não há escolha pendente entre `public` e schema dedicado.
2. **T006 aprovada quanto ao mecanismo:** fail-closed com allowlist/denylist e comparação da identidade efetiva. **Pendente:** responsável deve fornecer, fora do repositório e sem segredos, os registros reais ambiente/host/porta/database/perfil de destinos autorizados e identidades protegidas, incluindo o original.
3. **Status de banco inicializado aprovado para planejamento:** `status` é observação independente e não destrutiva, nunca exceção ao T012. O responsável pela operação deve aprovar e fornecer o adaptador autenticado/read-only e a evidência efetiva de identidade para destinos isolados; sem isso, `status` real retorna `blocked`. T030 permanece aberta até essa evidência e as validações de integração autorizadas existirem.
4. Preservação de dados, cutover e recriação destrutiva de banco existente exigem nova aprovação explícita e não são autorizados por esta feature.

## Regras finais

- `[P]` não elimina dependências de segurança.
- PostgreSQL real somente em instância/perfil `test` isolados e aprovados; todo DDL de fixture ou baseline é posterior aos preflights aplicáveis.
- O startup normal não executa bootstrap, `CREATE DATABASE`, migrations, criação de schema, baseline ou DDL.
- Cleanup automático é exclusivo do perfil `test`, após validar perfil/identidade, limitado a recursos criados pelo teste atual e nunca usa `DROP DATABASE`.
- Reexecução nunca autoriza drop/recreate; migration parcial exige `recovery-required` e ação humana explícita.
- Não iniciar `/speckit-implement` automaticamente.