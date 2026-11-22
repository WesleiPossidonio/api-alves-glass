# Implementation Plan: 005 — Gestão de Orçamentos em PDF

**Branch**: `feature/005-budgets-pdf` | **Date**: 2026-11-17
**Spec**: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/spec.md
**Status**: fases 0/1 reconciliadas e G-PDF fechado por aprovação explícita de qpdf; tarefas solicitadas nesta etapa. Nenhuma implementação autorizada automaticamente.

## Summary

Orçamento documental, sem itens/preços: PostgreSQL controla metadados, publicação e autorização; MinIO guarda bytes privados em chaves imutáveis. No máximo um publicado e um pendente, cada qual com sua validade civil. Publicação manual troca os pares atomicamente. Entrega exclusivamente por download autenticado (`attachment`) via streaming; inline foi adiado para melhoria futura com gate de segurança próprio. Não há URL pré-assinada. Registry PostgreSQL e executor de manutenção do próprio projeto garantem limpeza/recuperação; não adicionar broker, Event Sourcing ou CQRS.

## Technical Context

- **Language/Version**: JavaScript ESM, Node 22 da imagem existente.
- **Primary Dependencies**: Express 5, Sequelize 6, pg, MinIO JS 8, Multer 2, Yup, JWT/cookies existentes; qpdf aprovado como nova dependência de sistema a integrar na imagem, não instalado nesta etapa. --requires-password seguido de --check com semânticas distintas, fail-closed e limites em research.md.
- **Storage**: PostgreSQL canônico e MinIO privado; novas tabelas preservam tabela budget legada intocada. Sem versionamento/Object Lock no prefixo ativo, a verificar antes de habilitar exclusão.
- **Testing**: node:test/assert existentes; unitários, contratos HTTP e integração PostgreSQL/MinIO isolados planejados, não executados.
- **Target Platform / Project Type**: Linux, monólito API atual, executor de limpeza como modo de execução do mesmo projeto.
- **Performance Goals**: sem SLO inventado; limites iniciais em research.md exigem ensaio isolado.
- **Constraints**: 10 MiB/PDF, lista 25/100, concorrência limitada, I/O com timeout, autenticação/CSRF/ownership correntes; nenhum acesso público.
- **Scale/Scope**: cinco jornadas, seis permissões, gerência setorial sem role global novo. Capacidade real não medida.
- **PostgreSQL**: PostgreSQL 17 é a única versão suportada pela Feature 005, conforme decisão arquitetural do responsável. Produção utiliza uma única instância lógica principal e banco compartilhado pelos domínios da API; não há banco/instância exclusivo de orçamentos. Recursos isolados abaixo são temporários e exclusivos de testes, não topologia de produção. A referência divergente na Constituição não institui outra versão suportada e não é alterada nesta feature.

## Procedimento Spec Kit

Lidos integralmente spec e Constituição, consultados procedimento plan e template oficiais instalados. No planejamento anterior foi restaurado somente o template oficial em /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/.specify/templates/plan-template.md, sem customização. Executado setup_plan.py oficial com sucesso, gerando os caminhos esperados. BRANCH no JSON é `005-budgets-pdf` por resolução do diretório; Git confirma `feature/005-budgets-pdf`. Não há hooks locais/extensions.yml. Fases 0 e 1 concluídas sem tasks naquela etapa. Agora tasks foi solicitado/gerado com fallback somente em memória ao template oficial instalado, conforme tasks.md; nenhuma escrita fora da feature nesta execução e nenhuma atualização automática de contexto/handoff de implementação.

## Constitution Check

| Gate                               | Antes da pesquisa          | Após desenho                                                                                           |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Integridade e preservação          | Estratégia exigida         | Constraints/locks/transações + dados antigos intocados; data-model.md                                  |
| Domínios independentes             | Atende                     | Nenhuma alteração 003/004; registry próprio, sem OS/estoque                                            |
| Sessão e autorização backend       | Atende                     | Sessão atual, concessões correntes, CSRF, DTOs e ownership                                             |
| Efeitos externos recuperáveis      | Atende no desenho          | Registry durável, fencing, retry/reconciliação, sem exactly-once                                       |
| Qualidade verificável              | Plano somente              | quickstart.md define evidências futuras; não afirma execução                                           |
| Camadas e migrations novas         | Atende                     | Service controla transação; nenhuma migration aplicada/editada/criada                                  |
| Dependências confirmadas/aprovadas | G-PDF originalmente aberto | qpdf agora expressamente aprovado; instalação/pin/smoke como tarefas futuras, sem execução nesta etapa |
| Segurança operacional              | Atende                     | Nenhuma operação banco/MinIO/container/deploy                                                          |

Nenhuma exceção constitucional solicitada. G-PDF fechado permite decomposição em tarefas; validação de execução, integração da imagem e gates de release permanecem futuros e obrigatórios.

## Project Structure

Raiz de todos os caminhos: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.

### Documentation (produzida)

```text
.specify/templates/plan-template.md
specs/005-budgets-pdf/
  spec.md
  checklists/requirements.md
  plan.md
  research.md
  data-model.md
  contracts/http-api.md
  contracts/storage-lifecycle.md
  quickstart.md
```

### Source Code (destinos futuros; não implementados)

```text
src/routes.js                         composição, preservando contratos 003/004
src/app/controllers/                  transporte Budget/permissões comerciais
src/app/services/                     casos de uso, política setorial, adaptadores e limpeza
src/app/repositories/                 persistência do orçamento/objetos/grants/auditoria
src/app/models/                       novas tabelas do domínio
src/database/index.js                 registro dos models novos
src/database/migrations/              migrations NOVAS posteriores ao maior timestamp
 tests/unit/budgets/                  regras e contratos com node:test
 tests/integration/budgets/           PostgreSQL/MinIO reais isolados
```

**Structure Decision**: Routes → Controllers → Services → Repositories → Models. Novo domínio separado de budget legado evita fingir conformidade ou inventar dados. Não criar camadas DDD, microserviços ou projeções adicionais.

## Phase 0 — Research

DT-01..06 detalhadas em research.md: arquivo 10 MiB, assinatura e qpdf aprovado com sondagem de senha/check, timeout/recursos/limpeza e imagem compatível; comparação textual exata; streaming revogável; CAS/locks; registry e executor PostgreSQL isolados do estoque; preservação de /budged nesta entrega (substitui a hipótese histórica de retirada); preservação/quarentena do legado; limites operacionais finitos.

## Phase 1 — Design

1. data-model.md: `budgets_pdf`, registry de objetos, grants, gerência e auditoria; quatro migrations novas planejadas, nenhuma criada.
2. storage-lifecycle.md: intenção antes do PUT, anexação por CAS/fencing, jobs após desanexação e recuperação de uploads tardios.
3. http-api.md: DTOs estritos, ETag/If-Match, paginação, confirmação de exclusão e proxy privado.
4. Gerência = concessão setorial, não novo role em User. Perda de UserSector desativa efetivamente permissões comerciais.
5. GET segura mantém autorização corrente e locks compartilhados por stream limitado; escritas/revogações aguardam término ou falham sem commit. Referência antiga nunca é endpoint de download.
6. Legado: /budged e a tabela budget preservados sem alteração comportamental; sem 410, adaptação, cutover ou migração automática. Retirada futura depende de iniciativa independente autorizada.

## Estratégia de testes e gates

Unitários: política das seis permissões, sem autoconcessão, datas civis, limites/textos e validação/compensação. Contratos: DTOs, CSRF, ETag, download attachment-only, erros, preservação do legado. Integração: UNIQUE/rollback, intents expiradas, upload tardio, dois workers, publicação/upload/exclusão concorrentes, stream/revogação, recuperação após reinício e ausência de perda de referência. Regressores 003/004 sem mudança de contrato; inventário legado antes/depois. O gate de viewer/inline foi adiado e não é declarado aprovado.

Release exige bucket privado verificado, qpdf aprovado já integrado/pinado e testado na imagem, executor/reconciliador ativo e ensaiado, recursos medidos e preservação aprovada. Migração/comunicação de consumidores é requisito da futura desativação, não desta entrega. Nenhum endpoint deve ser exercitado antes da cadeia de migrations e ambiente isolado necessário estarem prontos.

## Rastreabilidade

| Requisitos                 | Desenho                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| RF-001..007                | modelo + criação; DT-01/02                                          |
| RF-008..016                | registry/worker + storage-lifecycle + proxy                         |
| RF-017..021                | imutabilidade PostgreSQL, CAS, pares PDF/data                       |
| RF-022..024                | DATEONLY + dia civil em São Paulo                                   |
| RF-025..028                | exclusão física + limpeza sem FK dependente                         |
| RF-029..035                | membership + grants/manager/audit + locks                           |
| RF-036..038                | portal somente publicado/ownership                                  |
| RF-039..042                | novo domínio isolado, legado preservado, reconciliação futura DT-05 |
| RNF-001..010 / SC-001..008 | quickstart e gates de execução acima                                |

## Complexity Tracking

Sem violação constitucional. Registry/worker é a menor solução durável para falhas PUT/commit/DELETE. Reutilizar defaults da limpeza de estoque não protege referências de orçamento e exigiria alterar Feature 003. Reutilizar cliente MinIO e padrões existentes sem compartilhar verificadores inseguros. Broker e ES/CQRS não têm consumidor ou necessidade funcional.

## Prontidão

### Reconciliação final T066 — 2026-11-21 (escopo técnico, sem deploy)

Código, desenho e contratos HTTP/armazenamento confrontados com as cinco
jornadas e os 42 RF/10 RNF/8 SC (`quickstart.md`, `traceability-review.md`).
Rotas novas em `src/routes.js` mantêm `POST /budged` composto com autenticação,
`requireAdmin`, Multer e controller legados; o novo módulo não importa OS,
estoque, broker ou MongoDB. Autorização/CSRF/Origin, publicação e streaming
privado, qpdf fail-closed, CAS/locks, registry/worker e exclusão recuperável
constam dos gates T061–T065. Migrations novas aditivas, cliente obrigatório
RESTRICT sem mudar a FK nullable SET NULL da tabela histórica; teste T064
restaurou PostgreSQL em destino separado e comprovou hash de objeto MinIO,
sem simular backup físico do MinIO. Regressões reais 003/004 em T062; gate
T063 inclui build de imagem nova `sha256:0004f77dc7e789bf8035bb13f1f815d84897d3657bae853b83d9e96b50939b2f`,
qpdf 12.3.2 e suites 124/138/19. T065 repetiu apenas integração de ponta a
ponta no run novo (124/124); 5/5 checks T064 e CLI worker passaram sem skip.

**Aceite T066 = prontidão técnica/revisão final, não prontidão operacional
produtiva.** Antes de deploy, cabem ao proprietário a identidade de ambiente,
backup/restore completo de PostgreSQL **e MinIO** com worker supervisionado,
segredos, UID não-root por padrão e limites/alertas efetivamente conectados.
Consumidores externos de `/budged` não são conhecidos; não haverá desativação
sem iniciativa independente. Nenhuma importação, cutover, deploy, release,
commit, push ou PR foi realizada ou autorizada pelo aceite técnico.

O texto de “Prontidão” e as descrições “planejado” acima registram a etapa
original de planejamento e não substituem esta reconciliação de execução.

G-PDF fechado: pronto para decomposição solicitada em tasks.md e início posterior de implementação mediante solicitação explícita. Nenhuma nova decisão funcional presumida. Inventário/ensaios/provisionamento/pin reproduzível da imagem são gates posteriores rastreados, não evidências executadas. Não iniciar implementação automaticamente.
