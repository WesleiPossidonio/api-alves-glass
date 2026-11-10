# Constituição de Engenharia da Alves Glass API

## Core Principles

### I. Integridade Transacional e Dados

PostgreSQL MUST ser a fonte oficial para entidades operacionais, saldos e histórico de estoque.
Operações que alterem múltiplas estruturas relacionadas MUST ser atômicas e controlar sua
transação no caso de uso. Alterações de schema MUST usar migrations revisadas e preservar as
constraints que impõem invariantes de domínio. `product.quantity` MUST permanecer o saldo
operacional oficial; eventos imutáveis do ledger MUST ser gravados na mesma transação PostgreSQL
de cada mudança aceita no saldo. Correções MUST criar eventos compensatórios, nunca atualizar ou
excluir o histórico. Alterações destrutivas ou migração de dados MUST exigir estratégia aprovada
de preservação, validação, reconciliação e rollback quando houver dados a preservar.

### II. Domínios Independentes e Responsabilidades Explícitas

Ordens de Serviço (OS), seus itens, atribuição e histórico de status MUST permanecer
independentes de produtos de catálogo e movimentações de estoque. Itens de OS MUST NOT exigir FK
ou association Sequelize para produtos de estoque. Mudança de status ou item de OS MUST NOT
reservar, consumir, reverter nem alterar estoque automaticamente; movimentação de estoque MUST
NOT alterar estado ou histórico de OS. Integração entre esses domínios MUST exigir requisito e
contrato aprovados. Decisões aprovadas em `docs/audit/remediation-plan.md` MUST ser preservadas,
e decisões de negócio pendentes MUST NOT ser inventadas na implementação.

### III. Sessões Seguras e Autorização no Backend

Sessões de autenticação MUST usar JWT armazenado em cookie HttpOnly configurado centralmente.
JWTs MUST NOT ser retornados como credencial principal no corpo de login. Cookies HTTPS de
produção MUST usar `Secure`; domínio, path, expiração e `SameSite` MUST ser coerentes entre login
e logout. Requisições que alteram estado MUST validar `Origin` segundo a política aprovada; CORS
isoladamente MUST NOT ser considerado proteção contra CSRF. Quando `SameSite=None` for exigido,
o contrato de implementação MUST incluir proteção CSRF explícita. Identidade, papel, propriedade
do recurso e estado permitido MUST ser validados no backend, nos casos de uso, sem confiar em
ator, assignee ou autorização enviados pelo frontend. Segredos, chaves, tokens e credenciais MUST
NOT ser versionados.

### IV. Idempotência Transacional e Integração At-Least-Once

Todo comando de movimentação de estoque que aceite chave de idempotência MUST persistir a chave e
seu resultado na mesma transação PostgreSQL do saldo e do evento imutável. A chave MUST ter
constraint `UNIQUE` no escopo definido do comando. A implementação MUST tratar conflito de
unicidade: chave e conteúdo iguais retornam o resultado original; chave igual e conteúdo distinto
retornam conflito sem nova movimentação. Consulta prévia isolada MUST NOT ser usada como garantia
contra concorrência. RabbitMQ e Outbox fornecem integração at-least-once; deduplicação de consumer
por `consumer + event_id` MUST permanecer distinta da idempotência de comando. Efeitos externos,
inclusive e-mail de provedor, MUST NOT prometer exactly-once e MUST ter controles de
reconciliação e replay.

### V. Qualidade Verificável e Evidência Operacional

Regras de negócio MUST ter testes unitários. Persistência, constraints, transações e concorrência
MUST ter testes de integração contra PostgreSQL real; confirmação de broker, retry e deduplicação
de consumer MUST ter testes de integração contra RabbitMQ real quando fizerem parte da mudança.
Autorização, propriedade de recursos, CSRF e demais controles de segurança MUST ser testados.
Contratos de API e fluxos críticos MUST ter testes de contrato ou de integração adequados. Testes
MUST cobrir reuso concorrente de chave de idempotência, rejeição de `Origin` em mutações e ausência
de efeito automático de OS em estoque. Código que apenas compila MUST NOT ser considerado
funcionalidade concluída. Falhas operacionalmente relevantes MUST gerar logs estruturados e
evidências acionáveis de saúde, backlog, retry e DLQ proporcionais ao ambiente.

## Operational and Security Constraints

O backend MUST preservar fronteiras entre Routes, Controllers, Application Services/Use Cases,
Repositories, Models e infraestrutura. Routes MUST somente compor middleware e encaminhar a
Controllers. Controllers MUST tratar protocolo HTTP, validar entrada de transporte e delegar ao
caso de uso; Controllers MUST NOT acessar Models diretamente. Application Services/Use Cases MUST
concentrar regra de negócio, autorização, ownership, invariantes e limites transacionais.
Repositories MUST encapsular acesso a dados e receber a transação iniciada pelo caso de uso quando
ela for necessária. Models MUST representar persistência e associações, sem se tornar substitutos
de regras de aplicação. Abstrações, camadas e tecnologias adicionais MUST ter justificativa real
de requisito, risco ou manutenção; complexidade sem benefício verificável MUST ser evitada.

A atribuição de OS pertence exclusivamente ao domínio de OS. Atores administrativos MAY criar,
liberar e reatribuir OS somente conforme a matriz de permissões aprovada. Colaboradores MAY atuar
somente em OS atribuídas, salvo exceção administrativa explícita. Histórico de atribuição e
reatribuição MUST registrar ator autenticado e informações necessárias para auditoria.

Movimentações de estoque MUST incluir descrição livre não vazia e derivar a identidade responsável
da sessão autenticada. Nomenclatura, validação, erros de domínio e respostas HTTP MUST ser
consistentes e previsíveis; tratamento de erro MUST ser centralizado quando a regra atravessar
mais de um endpoint. Logs MUST usar estrutura que permita correlação e diagnóstico sem expor
segredos. Documentação de contratos e comportamento MUST ser atualizada quando forem alterados.
Decisões pendentes sobre papéis, catálogo de movimentos, transições de status, retenção e SLOs
MUST ser resolvidas antes de a implementação depender delas; nenhuma implementação pode
silenciosamente inventá-las.

## Development Workflow and Quality Gates

Every change MUST begin with a documented requirement and identify affected API contracts,
authorization rules, persistence invariants, tests, and operational effects. Breaking contract or
schema changes MUST include a migration, compatibility, rollback, or explicitly approved rebuild
strategy before implementation.

Code review MUST verify compliance with this constitution and reject undocumented exceptions.
Database rebuilds in development MAY recreate an isolated environment. Data-preserving migration
or a future production cutover MUST include inventory, recoverable backup, reconciliation,
idempotent loading, measured rehearsal, and rollback criteria; a production maintenance window is
required only when an actual production cutover is approved.

## Governance

Esta Constituição prevalece sobre práticas locais que contrariem seus princípios.
Specifications, plans, tasks e implementações MUST respeitar esta Constituição.
`docs/audit/remediation-plan.md` permanece como referência para decisões técnicas e
arquiteturais aprovadas, evidências da auditoria e estratégia de saneamento. Decisões aprovadas
nesse plano MUST NOT ser alteradas silenciosamente: qualquer alteração exige revisão explícita e
documentação. Se uma decisão futura exigir mudança de princípio desta Constituição, o processo
formal de emenda MUST ser aberto antes da implementação.

Emendas MUST documentar a justificativa, os princípios ou seções afetados, impacto de migração e
incremento de versão semântica. Remover ou redefinir materialmente um princípio exige incremento
MAJOR; adicionar princípio ou ampliar materialmente orientação obrigatória exige incremento MINOR;
esclarecimentos que não alterem obrigações exigem incremento PATCH.

Toda specification, plan, revisão de implementação e revisão de prontidão de release MUST
verificar os requisitos constitucionais aplicáveis. Exceções exigem aprovação explícita por
escrito, escopo limitado, responsável, prazo de expiração ou plano de remoção e controles
compensatórios.

**Version**: 1.1.0 | **Ratified**: 2026-11-04 |
**Last Amended**: 2026-11-04
