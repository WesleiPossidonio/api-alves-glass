# Feature 004 — Matriz de reconciliação com o planejamento anterior

**Natureza:** comparação entre decisões da conversa e **versão compartilhada** dos documentos (spec de 13/11, tasks de 14/11, auditoria do código relatada em 14/11). Não é diff do checkout atual nem inspeção direta do repositório.

## Requisitos de domínio que continuam

### RF-11 — decisão definitiva

Nome, descrição e medidas são corrigíveis exclusivamente em `IN_PRODUCTION`, antes de qualquer registro ou sinalização de qualidade do próprio produto. O bloqueio após a primeira atividade é definitivo e individual; outros produtos sem atividade própria continuam corrigíveis. `REGISTERED`, `AWAITING_SUPPLIER`, `AWAITING_DELIVERY`, `COMPLETED` e `CANCELLED` não permitem correções. Quantidade, identidade e composição permanecem imutáveis. Autorização, auditoria, `ServiceOrderProductCorrected` e Outbox transacional são preservados. Não há decisão pendente de RF-11 nem workflow de revisão aprovada.

| Tema                               | Decisões da revisão                                 | Contrato atual                                                                                              |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| OS com identificação única e setor | 01–05, 70, 73                                       | ID global; número externo manual único por setor; cliente global e prazo obrigatório                        |
| Produtos/medidas                   | 06–14, 55–59                                        | Itens cadastrados na OS; composição fixa; quantidade imutável; correções de campos permitidos com auditoria |
| Qualidade                          | 20–28, 66–67, 76–77                                 | Sinalização; inspeção; reprovação parcial; reinspeção seletiva; aprovação antes de concluir produto         |
| Status da OS e do produto          | 29–45, 62 corrigida                                 | Seis estados da OS; dois por produto em produção; cliente vê marcos no próprio sistema                      |
| Permissões                         | 46–49, 59, 67–70                                    | Admin, responsável do setor, criador autorizado, colaborador vinculado; setor+pedido para operação          |
| Assunção simplificada              | 63–64 reinterpretadas pela mudança de escopo, 68–74 | OS impressa externa; vinculação por número; uma OS ativa por colaborador; gestor transfere                  |
| Cancelamento                       | 34–36, 74–75                                        | Definitivo, justificativa opcional, autoria obrigatória, liberação automática                               |
| Prioridade/FIFO                    | 60–61 corrigidas pela decisão 78                    | Flag persistida; UI destaca; ordenação FIFO por chegada                                                     |

## Substituições/revogação de propostas antigas

| Antigo                                                                                                                   | Decisão nova                                               | Efeito documental                                                                                      | Risco de código                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Número sequencial gerado pela API                                                                                        | Manual, único por setor                                    | Alterar US1, FR de numeração, modelo e tarefas                                                         | Função `allocateExternalNumber` citada pela auditoria                       |
| Triagem obrigatória ≥7, distribuição de quotas e apontamento por unidade                                                 | Retirados na simplificação                                 | Excluir US2/US3/US4 antigos enquanto fluxos de triagem/distribuição; preservar apenas FIFO consultável | Repositories/rotas de triagem, atribuição e execução citados                |
| Proibição de autoinspeção                                                                                                | Autorizado pode inspecionar próprio trabalho               | Alterar qualidade                                                                                      | Validação de inspetor pode contrariar decisão                               |
| Disposição formal de retrabalho/substituição/descarte                                                                    | Tratamento fora do sistema; registrar problema/reinspeção  | Alterar US5; reduzir eventos/modelo                                                                    | Tabelas/repositories de não conformidade e retrabalho                       |
| Revisões com solicitação e aprovação separadas                                                                           | Correções auditáveis de produtos existentes                | Excluir US6 como processo obrigatório                                                                  | Estados de revisão e services                                               |
| Suspensão/retomada                                                                                                       | Não existem                                                | Remover US7, FR e tarefas                                                                              | Rotas/services/status                                                       |
| Encerramento administrativo e reabertura/ciclos                                                                          | Fechamento da produção + confirmação final; sem reabertura | Reformular US9/US10 e remover US11                                                                     | Models de ciclo e endpoints reabertura                                      |
| Sete status externos `CREATED`, `APPROVED`, `MATERIALS_SEPARATED`, `IN_PRODUCTION`, `IN_ROUTE`, `DELIVERED`, `CANCELLED` | Seis status funcionais aprovados                           | Substituir máquina de estados e contratos públicos                                                     | `ServiceOrderReadService`/serializer/projeção                               |
| Consulta completa de OS para cliente                                                                                     | Cliente vê marcos no próprio sistema                       | Reformular US12 e DTO                                                                                  | Leitura detalhada por Client citada                                         |
| Permissões de gerente por grant de cada operação                                                                         | Conjunto predefinido de responsável                        | Simplificar matriz de autorização                                                                      | `service_order_grants`/permissões existentes precisam conciliação, não drop |
| Prioridade muda posição                                                                                                  | Flag visual, FIFO não alterado                             | Corrigir filtro/ordenação                                                                              | Critérios de sort e testes antigos                                          |

## Pontos de atenção que não devem ser tomados como fatos do código atual

A auditoria compartilhada relata `ServiceOrderEventRepository`, `ServiceOrderOutboxPublisher`, `ServiceOrderProjectionConsumer`, `ServiceOrderProjectionService` e `ServiceOrderReadService`, além de estruturas de qualidade, ciclo, grants e numeração automática. Não executei inspeção atual desses arquivos. O Cline deve verificar a presença e o comportamento reais e apresentar o diff antes de qualquer mudança.

`tasks.md` compartilhado registra implementação parcial, múltiplas tarefas ainda pendentes, suites unitárias aprovadas em determinado momento e integrações PostgreSQL/RabbitMQ/Mongo **não aprovadas como aceites completos**. Não converter esses resultados em conclusão da nova feature, pois os testes foram escritos para regras agora substituídas.

## Critérios de qualidade da nova documentação

1. Cada RF da nova `spec.md` precisa um critério de aceite ou uma lacuna explícita; nenhuma regra nova sem decisão.
2. Cada tarefa deve apontar RF(s) e teste(s) aplicáveis, sem reutilizar indevidamente contagem/numeração antiga de FR.
3. A terminologia de estados deve ser consistente nos documentos. Não confundir status interno de conferência com status público de produto.
4. A liberação do colaborador por cancelamento/conclusão e manutenção do vínculo até encerramento definitivo devem constar explicitamente.
5. A prioridade deve ser tratada como informação, sem ordenação baseada nela.
6. Nenhuma correção técnica no backend deve ser escondida em requisito de UI.
7. Nenhuma migration, evento histórico, schema ou rota legada será removida sem análise de compatibilidade e autorização específica.

## Pendências identificadas, sem novas perguntas funcionais neste momento

- RF-07 resolvido: largura/altura obrigatórias, finitas e positivas; espessura e cores opcionais, validadas quando informadas, sem material condicionado, catálogo ou inferência por nome.
- RF-10 resolvido: quantidade imutável após cadastro, sem correção quantitativa ou contador de produção.
- RF-11 resolvido: correções somente em IN_PRODUCTION e antes de qualidade do próprio produto.
- RF-31 resolvido: seis estados funcionais e DTO mínimo com ownership canônico; consumo pelo frontend não demonstrado.
- Retenção/anonimização (G8), histórico de eventos e eventual migração de contratos/rotas.

Estas pendências devem ser tratadas apenas quando bloquearem uma implementação concreta, com **uma decisão dirigida por vez**. Não são autorização para reintroduzir os fluxos removidos.
