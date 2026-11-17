# Feature 004 — Contrato conceitual de eventos

**Status:** garantias consolidadas; a tabela conceitual abaixo não renomeia eventos físicos. Contrato físico implementado em `ServiceOrderEventRepository`, `ServiceOrderService` e publisher/consumer, validado pelos testes em `../final-validation.md`.

## Objetivo

Manter os fatos canônicos da OS no PostgreSQL, registrando autoria, ordem causal e histórico imutável. A publicação é via Outbox transacional → RabbitMQ → consumidor idempotente → projeções MongoDB. A Feature 004 não compartilha eventos de domínio com a Feature 003 (Estoque).

## Eventos físicos atuais

Cadastro: `ServiceOrderRegistered`, `ServiceOrderProductRegistered`; responsabilidade: `ServiceOrderAssumed`, `ServiceOrderResponsibilityReleased`; estados: `ServiceOrderFunctionalStatusChanged`, `ServiceOrderCancelled`; qualidade: `ProductQualityInspectionSignaled`, `ProductReinspectionSignaled`, `QualityInspectionRecorded`, `QualityQuantityApproved`, `QualityInspectionPending`; confirmações: `ServiceOrderProductionClosureConfirmed`, `ServiceOrderCompletionConfirmed`; correção: `ServiceOrderProductCorrected`; prioridade: `ServiceOrderPriorityChanged`.

Envelope de integração usa `schemaVersion`, `eventId`, `aggregateType`, `aggregateId`, `aggregateVersion`, `eventType`, `occurredAt`, `actor`, `sectorId`, `productItemId`, `revision`, `cycle`, `correlationId` e `payload` conforme o fato. Versões são strings decimais na integração; PostgreSQL mantém BIGINT e hash/append-only. Não exigir que cada fato tenha produto ou todos os campos opcionais. Autoria vem da sessão. Outbox é gravada na mesma transação. Eventos legados continuam interpretáveis, sem reativar comandos retirados.

## Classes conceituais de fatos

| Categoria          | Exemplos conceituais                                                                                     | Efeito                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadastro           | `OrderRegistered`, `ProductRegistered`                                                                   | Cria OS e produtos no mesmo commit                                                                                                                                                                                                                                                      |
| Correção           | `ProductDetailsCorrected`                                                                                | Conserva anterior/novo, autor e data nos campos permitidos, sem mudar composição, identidade ou quantidade; somente IN_PRODUCTION e antes da primeira atividade de qualidade do produto (RF-10/RF-11). Evento físico existente: `ServiceOrderProductCorrected`, com Outbox transacional |
| Andamento          | `OrderMovedToSupplierWait`, `OrderProductionStarted`                                                     | Registra transições autorizadas e regras dos seis estados                                                                                                                                                                                                                               |
| Prioridade         | `OrderPriorityChanged`                                                                                   | Marca/desmarca flag sem alterar FIFO                                                                                                                                                                                                                                                    |
| Responsabilidade   | `OrderAssumed`, `OrderReleased`                                                                          | Vínculo único e histórico de transferência/liberação                                                                                                                                                                                                                                    |
| Qualidade          | `ProductSubmittedForQuality`, `ProductInspected`, `RejectedUnitsResubmitted`, `RejectedUnitsReinspected` | Aprovação/reprovação e reinspeção rastreáveis por produto                                                                                                                                                                                                                               |
| Produção encerrada | `OrderProductionClosed`                                                                                  | Confirmação autorizada após aprovação integral dos produtos                                                                                                                                                                                                                             |
| Fim                | `OrderDeliveredOrInstalledConfirmed`, `OrderCancelled`                                                   | Conclusão/cancelamento terminais e liberação do colaborador                                                                                                                                                                                                                             |

**Não são contratos aprovados de novos tipos:** nome e granularidade serão conciliados com o código existente e com a convenção de eventos do projeto. Não persistir evento redundante que não represente decisão/fato de negócio.

## Envelope mínimo a validar no contrato físico

- Identificador global do evento e da OS agregada.
- Versão causal contígua **por OS**; schema version explícita para compatibilidade.
- Tipo, instante UTC, identidade real autenticada, setor, referência de produto quando pertinente, correlation/command ID se houver.
- Payload específico sem dados pessoais desnecessários e sem duplicar fonte canônica.
- Registro Outbox na **mesma transação** da alteração canônica quando houver publicação.

## Invariantes de consumo e reconstrução

1. RabbitMQ oferece entrega `at-least-once`: não afirmar `exactly-once`.
2. Evento já aplicado não pode duplicar inspeção, movimento, status nem vínculo.
3. Evento fora de sequência não avança checkpoint nem é aplicado como se anterior tivesse sido observado; tratar gaps/retry/parking segundo mecanismos técnicos aprovados.
4. Eventos relacionados a produto precisam permanecer no respectivo `products[].movements[]` da projeção.
5. Rebuild/replay recupera o mesmo estado a partir do PostgreSQL sem consultar Mongo como autoridade de negócio.
6. O evento de correção preserva valores anteriores e novos; eventos publicados não são apagados em futuras edições.

## Remover do domínio-alvo

Classes de triagem/7+, distribuição e execução quantitativa por pessoa, revisão aprovada/pendente, suspensão, retomada, reabertura/ciclo novo, disposição de retrabalho/substituição/descarte. Não apagar eventos históricos já existentes sem política de migração/reconciliação aprovada; apenas não criar novos comandos de negócio para esses fluxos.

## Pendências técnicas

Ativação/reconstrução operacional e workers contínuos não foram exercitados nesta consolidação; ver `../final-validation.md`. Evolução futura exige compatibilidade; política de retenção G8 permanece não aprovada.
