# Parecer histórico — reconciliação T060–T066 (2026-11-19)

> **Estado posterior (21/11/2026):** T001–T066 estão marcadas `[x]` em
> `tasks.md`; T062 foi aceita na matriz final de `t062-scope-review.md`, T063 em
> `security-validation.md`, T064 em `legacy-reconciliation.md`, T065 em
> `quickstart.md` e T066 em `plan.md`. G1/US1–US5 foram aceitos. Os bloqueios
> descritos abaixo são registros das respectivas rodadas, não pendências atuais
> de implementação nem impedimento para iniciar revisão de código. O aceite
> técnico **não** autoriza deploy/release: permanecem pré-deploy backup operacional
> de objetos MinIO, supervisor/entrega de alertas, gestão de segredos, usuário
> não-root/limites e decisões relativas a consumidores externos desconhecidos de
> `/budged`. O legado permanece preservado, sem retirada nesta feature.

## Atualização vigente — T061 concluída (run `db1126fff37e`)

O critério T061 foi ensaiado no runner com manifesto/identidades e preflight
remoto revalidados. Suíte pertinente **11/11, 0 skips**, log privado
`t022-ops-cd3b77b9408b/t061.log`, saída 0. Worker real processou backlog
exclusivo em lotes 25+2, sem duplicação; dez falhas reais de DELETE em proxy
local exclusivo persistiram retries/backoff e liberaram leases, emitindo alertas
de backlog >1h e >=10 erros. Recuperação removeu o objeto na tentativa 11.
Subprocesso acima de RSS apertado foi encerrado; pool max1 e lock_timeout 5 s
medidos; resource-pressure/worker-bootstrap/process-kill confirmaram limites,
timeouts e interrupções. Métricas e ressalvas em `quickstart.md`. Emissão de
alerta não é integração com sistema de monitoramento. Nenhuma regra funcional,
migration ou legado foi alterado.

**Estado nesta rodada de 19/11 (superado):** T060 e T061 concluídas; T062 aberta por integrações antigas
de OS/estoque dependentes de autorização e preflights próprios 003/004. T063
depende de T062, T064 de T063, T065 de T064 e T066 de T065. A matriz individual
T065 está preparada em `traceability-review.md`, não aceita. Não declarar
conclusão da feature, revisão final liberada ou autorização de produção.

---

# Histórico anterior (antes da conclusão de T061)

## Complemento técnico desta rodada (sem aceite adicional)

Revalidado `db1126fff37e`: `verify-resources.js` confirmou identidades Docker,
preflight remoto do `operational-runner.js` passou antes de executar a CLI real do
worker. O cenário `worker` saiu 0 após SIGINT controlado: eventos sanitizados
`budgetWorkerTick` (`completed:0`) e `budgetWorkerStopped` foram registrados em
`t022-ops-bafde201cb0b/worker.log` (privado); **não** houve backlog/10 falhas
na execução, nem comprovação de entrega ao monitoramento. A execução contínua
sem `RUN_ONCE` foi encerrada por sinal; não tratá-la como ensaio de dez erros.
Não houve fixtures ou mudanças no banco por esse ensaio.

T062: o critério exige tanto regressões antigas quanto fronteira da aplicação
atual. `domain-isolation.integration.test.js` e regressões auth/OS/estoque já
constam do migrated/regressões aceitos; `service-orders/*.integration.test.js`
inclui recovery PG17 + MongoDB 8 + RabbitMQ 4, com identidade fixa do projeto
Feature 004. `stock/cqrs-real.integration.test.js` usa PG/Mongo/Rabbit próprios
Feature 003; outros testes PostgreSQL/MinIO de estoque não equivalem a CQRS real.
O manifesto Feature 005 contém apenas PG17/MinIO; nenhum manifesto de autorização
para a execução nos ambientes próprios 003/004 foi apresentado nesta rodada.
Não foram acessados ou reaproveitados. Obter autorização explícita e preflights
de identidade/isolamento **desses** ambientes antes de rodar seus testes antigos.

T063 continua dependente de T061/T062; superfícies já cobertas estão em
`security-validation.md`, sem aceite formal. T064 depende de T063: apenas backup
JSON sintético anterior possui checksum; não foi restaurado registry/MinIO/worker
em destino isolado, nem se sobrescreveu o banco principal. Preparar fixtures
exclusivas e destino restaurável com identidade comprovada antes de executá-lo,
após T063. T065: matriz individual preparatória com 42 RF, 10 RNF e 8 SC em
`traceability-review.md`; lacunas estão indicadas ali. Quickstart ponta a ponta
aguarda T064. T066 aguarda T065. **Não declarar conclusão da Feature 005 nem
prontidão para revisão de código ou deploy.** UID 0 por padrão, supervisor de
worker, encaminhamento dos alertas e limites produtivos continuam pré-deploy,
não são prova de T061 local.

**T060 concluída nos critérios expressamente revisados. T061–T066 não aceitas.**
Decisão posterior excluiu 410 e comunicação de retirada do escopo da Feature 005;
nenhum critério antigo foi declarado cumprido. A rota POST /budged, `budget` e
seu middleware/controller permaneceram inalterados. `legacy-http.test.js`,
`legacy-reconciliation.integration.test.js` e a sonda de cliente no app real
comprovam composição e preservação do schema/snapshot; não demonstram que a
implementação legada cumpre o contrato novo. Inventário local em `src`, `tests`,
`docs`: composição da rota, código legado e sondas de integração; nenhum
consumidor frontend HTTP identificado neste repositório. Consumidores externos
desconhecidos; nenhum comunicado/migrado. Retirada, migração e testes de
compatibilidade completos dependem de iniciativa independente autorizada.

| Tarefa | Resultado nesta rodada                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T060   | Concluída: preservação de rota/tabela, inventário local, contrato e teste de composição, sem 410/cutover.                                                                                                                                                                                                                                                     |
| T061   | Aberta: limites de cgroup e upload/stream/timeout/abort testados; **overshoot por filho não comprovado**; emissão de códigos de backlog >1h/tentativas >=10 testada na unidade, mas **não ensaiada em CLI com backlog/10 falhas reais**; pool escasso e lock de 5s extremo ainda não comprovados. Eventos precisam de encaminhamento e supervisor pré-deploy. |
| T062   | Aberta: teste integrado novo prova contagens imutáveis de OS/estoque/legado após attach/delete/cleanup, mas integrações antigas completas com ambientes próprios de broker/MongoDB não executadas.                                                                                                                                                            |
| T063   | Aberta: evidências de autorização, qpdf, privacidade e imagem sumarizadas em `security-validation.md`; falta gate integral dependente de T061/T062, portanto não aprovar habilitação.                                                                                                                                                                         |
| T064   | Aberta: backup JSON sintético recuperado com checksum/contagem e snapshot read-only do legado estável; não comprova restauração completa com registry/MinIO e worker mantido, nem o gate dependente T063.                                                                                                                                                     |
| T065   | Aberta: jornadas US1–US5 e falhas/races já aceitas; ainda falta matriz individual comprovada de 42 RF/10 RNF/8 SC e execução ponta a ponta vinculada a T064. Checklist documental não foi convertido em prova.                                                                                                                                                |
| T066   | Aberta: depende de T065; riscos e evidências não podem ser mascarados como aceite final.                                                                                                                                                                                                                                                                      |

Preflights Docker/remoto (manifesto privado `db1126fff37e`) executados antes de
acesso externo; nenhuma migration/fresh/upgrade, teardown ou recurso de outro
run tocado. Reexecuções finais: unitários **137/137** (`final-accepted-unit.log`,
exit0), contratos **18/18** (`final-accepted-contract.log`, exit0), migrated
PG17/MinIO **124/124** (`t022-ops-329b768ed0ad/migrated.log`,
`final-accepted-migrated.exit` 0), regressões auth/OS/estoque/config **234/234**
(`final-regressions.log`, exit0). Zero skipped/TODO/cancelados. Logs privados em
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/`.
Integração antiga de OS/estoque com ambientes próprios não executada. Falhas
intermediárias: migrated 121/123 (claim da fixture fora do lote25 num run
compartilhado), corrigida prioridade somente da fixture sem mudar claim/limite;
migrated 122/124 e teste isolado worker 4/7: entrada direta saiu13 por ciclo de
import/top-level await introduzido na revisão, corrigido passando função de
alertas à CLI; fixture de um tick também passou a priorizar seu próprio job.
Teste isolado posterior worker 7/7; migrated final 124/124. Nenhum resultado
falho foi reclassificado como skip. Defeito de produção originalmente existente
não foi atribuído sem prova.

Segurança: sessão/cookie, Origin/CSRF, ownership, membership corrente,
MANAGE_PERMISSIONS admin-only, seis grants independentes, ETag/CAS, qpdf
fail-closed, objeto privado, URL/Range antigos, stream e cleanup possuem
regressões; não há viewer inline. A imagem fixa Node22/qpdf, mas **default UID0**
segue pendência de hardening antes do deploy, com filesystem/segredos/limites e
supervisor/alertas operacionais. A revisão do código não equivale a autorização
de produção. Migrations históricas/Features003/004 e legado não alterados;
sem Python, commit, push, PR ou deploy.

**Decisão:** ainda não declarar “IMPLEMENTAÇÃO CONCLUÍDA, VALIDADA E PRONTA PARA
REVISÃO DE CÓDIGO” sob os critérios T061–T066. Bloqueios objetivos são os
ensaios operacionais e de segurança pendentes, regressões antigas em ambiente
próprio autorizado e matriz completa de rastreabilidade/rollback. A comunicação
de desativação do legado **não** é bloqueio desta feature.

---

# Histórico supersedido: revisão bloqueada no gate antigo T060 — 2026-11-18

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`, branch `feature/005-budgets-pdf`. Este registro não é aceite de T060–T066, release, cutover nem aprovação para produção. Alterações locais anteriores preservadas; não houve commit, push, PR, deploy, migration, fresh/upgrade, importação ou acesso a produção.

## Decisão de dependência

T060 exige inventário **e comunicação** dos consumidores de `POST /budged` antes da retirada controlada. O registro em `quickstart.md` (T001) e `legacy-reconciliation.md` (T030) declara consumidores externos desconhecidos e nenhum comunicado/migrado. A solicitação desta rodada exige explicitamente preservar a rota legada. Sem evidência de comunicação e decisão de transição aprovada, alterar `src/routes.js` para 410 contrariaria tanto o gate de `contracts/http-api.md` quanto a restrição atual. A rota continua autenticada com `requireAdmin`, `upload.single('file')` e `BudgetController.store`; a tabela `budget` permanece isolada e intacta. **Não confundir manutenção da rota com afirmação de compatibilidade ou segurança do fluxo legado.** Não executar payload legado para provar compatibilidade.

| Tarefa | Estado e impedimento                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T060   | Bloqueada: inventário/comunicação externos e revisão de ativação ainda não comprovados; não foi implementado 410 nem escrito teste que presuma a ativação.                                                                |
| T061   | Não aceita: depende de T060; ensaios prévios cobrem parte de upload/qpdf/stream/worker, não comprovam todos os alertas e recursos reais exigidos.                                                                         |
| T062   | Não aceita: depende de T060; regressões existentes executadas, mas não foi criado o teste de isolamento de domínio exigido pela tarefa nem executadas integrações antigas com seus ambientes próprios.                    |
| T063   | Não aceita: depende de T061/T062; a segurança parcial foi revisada, mas não há gate completo nem relatório `security-validation.md`.                                                                                      |
| T064   | Não aceita: depende de T063; T030 testa fixtures TEMP e checksum, mas não é ensaio de backup recuperável/restauração sintética conforme T064.                                                                             |
| T065   | Não aceita: depende de T064; cinco jornadas já implementadas nos aceites US1–US5, mas não foi demonstrada cobertura integral dos 42 RF, 10 RNF e 8 SC nesta revisão. Checklist atual é documental, não prova operacional. |
| T066   | Não aceita: depende de T065; revisão parcial não substitui reconciliação completa de gates.                                                                                                                               |

## Evidência reexecutada (run autorizado `db1126fff37e`)

Antes do migrated, `verify-resources.js` confirmou identidades Docker; `operational-runner.js --scenario preflight` e o preflight remoto interno do cenário migrated passaram. Manifests e logs privados permanecem fora do repositório em `/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/`. Nenhum outro run foi tocado. Não se repetiram migrations. Suítes sem falha, skip, TODO ou cancelamento:

| Suíte                                   | Passaram | Evidência privada                                                                      |
| --------------------------------------- | -------: | -------------------------------------------------------------------------------------- |
| Unidade budgets                         |  135/135 | `t060-review-unit.log` / `.exit` (0)                                                   |
| Contratos budgets                       |    18/18 | `t060-review-contract.log` / `.exit` (0)                                               |
| Runner migrated PG17/MinIO              |  122/122 | `t022-ops-86a72f77f8d0/migrated.log`, `t060-review-migrated-summary.log` / `.exit` (0) |
| Regressões auth/OS/estoque/configuração |  234/234 | `t060-review-regressions.log` / `.exit` (0)                                            |

Testes de integração legados de OS/estoque dependentes de broker/MongoDB e de ambiente próprio não foram executados; não se provisionou nova infraestrutura. Não transformar cobertura dos testes migrados em alegação de integração real desses módulos. Resultados provam apenas o código e ambiente ensaiados, não readiness de produção.

## Revisão técnica e funcional parcial

As entregas US1–US5 aceitas abrangem cadastro privado com cliente global/setor/nome/número textual/PDF obrigatório de até 10 MiB, publicação manual, leitura e download autenticado somente attachment, edição com revisão/If-Match, substituição pendente sem trocar o publicado, exclusão comercial com cleanup recuperável e delegação setorial com auditoria transacional. Rotas novas: `POST/GET /budgets`, `GET/PATCH/DELETE /budgets/:id`, `POST /budgets/:id/publish`, `PUT /budgets/:id/pending-pdf`, `GET /budgets/:id/pdf`, `GET /client/budgets`, `GET /client/budgets/:id`, `GET /client/budgets/:id/pdf`, `GET /sectors/:sectorId/budget-permissions`, `PUT/DELETE /sectors/:sectorId/budget-managers/:userId` e `PUT/DELETE /sectors/:sectorId/budget-permissions/:userId/:operation`. Sem viewer inline, endpoints de versão ou link público.

Models `BudgetPdf`, `BudgetPdfObject`, `BudgetCommercialManager`, `BudgetCommercialPermission`, `BudgetCommercialPermissionAudit` e quatro migrations novas datadas 20261127–20261130 modelam PDF/slots, registry, grants e auditoria; não foram alteradas migrations históricas nesta revisão. Registry de intenção, fencing, MinIO privado, reconciliador e worker com retry preservam objetos referenciados. PostgreSQL 17 é o alvo exclusivo da feature no contrato; a constituição contém referência histórica a PostgreSQL 16 local, não substitui o contrato específico do alvo. Scripts de operação da feature são Node.js ESM; não adicionar Python. Auditoria estática não encontrou imports de MongoDB/broker na camada de serviços de budgets; coexistência de outros módulos não demonstra integração cruzada.

Segurança já ensaiada nos aceites anteriores inclui sessão, Origin/CSRF, membership corrente, seis operações independentes, restrição de MANAGE_PERMISSIONS, ownership, revogação, CAS, DTOs sanitizados, validação qpdf e stream/abort/Range. O código do router da feature reutiliza autenticação compartilhada sem alterar rotas legadas. Esta revisão não comprova novamente **todos** os cenários do gate T063, portanto não o declara aprovado. Sem defeito novo comprovado que justifique correção de produção ou relaxamento de testes nesta rodada.

## Pendências objetivas

1. Produto/operação: identificar e comunicar consumidores externos de `/budged`, aprovar contrato/janela de ativação e resolver explicitamente a exigência atual de preservação antes de T060. Não habilitar 410 sem esse gate.
2. T061: medir limites reais, overshoot qpdf, pool/aborts/locks e alerta automatizado de backlog >1 h ou >=10 erros. O worker emite códigos `budgetCleanupUnavailable`/`budgetCleanupRecoveryPending`, mas o limiar e entrega do alerta não estão demonstrados aqui.
3. T062–T065: executar teste de fronteira e regressões com ambientes próprios autorizados; gate de segurança integral; backup/restauração sintéticos e checklist RF/RNF/SC com provas individuais. Dados reais/importação requerem autorização separada.
4. Antes de produção: Dockerfile fixa base/qpdf, mas não declara `USER` não-root (UID 0 por padrão); definir usuário e permissões de filesystem/binário/tmpfs e validar operação da API/worker como não-root, limites de memória/CPU/PIDs e segredos. Containers de ensaio não-root/read-only não equivalem ao runtime padrão de produção. Configurar monitoramento/operador do worker e backup verificável. Não afirmar prontidão produtiva.

**Decisão:** Feature 005 não pode ser declarada integralmente concluída/validada para revisão de código sob os critérios T060–T066. Bloqueio inicial concreto: comunicação/inventário e decisão aprovada sobre a retirada de `/budged`; os gates posteriores mantêm dependência serial e evidências próprias pendentes.
