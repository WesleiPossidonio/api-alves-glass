# Feature 004 — Pesquisa e decisões de compatibilidade

> Contexto histórico de planejamento/proposta. Para o contrato vigente, consultar `spec.md`, `product-corrections.md`, `rf31-client-tracking.md` e `final-validation.md`. Trechos legados sobre contador, FIFO numérico ou workflows removidos não autorizam sua reativação.

## RF-11 — contrato definitivo aprovado

Nome, descrição e medidas só podem ser corrigidos em `IN_PRODUCTION`, antes de qualquer registro ou sinalização de qualidade do próprio produto. A primeira atividade bloqueia definitivamente esses campos, sem bloquear outros produtos sem atividade própria de qualidade. Os cinco demais estados não permitem correções. Quantidade, identidade e composição são imutáveis. Permanecem autorização, auditoria, evento canônico `ServiceOrderProductCorrected` e Outbox transacional; não se cria workflow de revisão aprovada nem se altera o fluxo de qualidade. Esta decisão substitui a antiga pendência de correções após encerramento da produção ou após qualidade.

**Status:** PROPOSTA. Não substitui leitura do `research.md` real do worktree nem autoriza implementação.

## Decisões funcionais já fechadas — não rediscutir

- Uma OS para um setor; cliente global; número externo manual, exclusivo por setor; prazo obrigatório.
- Produtos definidos no cadastro, sem adicionar/remover depois; correções excepcionais com histórico.
- Funcionário recebe a OS impressa fora deste sistema, seleciona setor e digita número; assume a OS se estiver livre.
- Um colaborador vinculado por OS e uma OS ativa por colaborador; só gestor transfere/libera; conclusão definitiva ou cancelamento libera.
- Andamento por produto, sinalização para conferência, inspeção/reinspeção obrigatória; sem distribuição quantitativa ou apontamento de unidades produzidas.
- Seis estados da OS e dois estados visíveis por produto durante produção; cancelamento/conclusão terminais; sem suspensão/reabertura.
- Flag de prioridade não altera FIFO; cliente acompanha marcos limitados no próprio sistema.

## Decisões arquiteturais preservadas

- Express/Sequelize/PostgreSQL canônico, Services/Repositories/Models e transações do caso de uso.
- Autenticação/sessão existente; `User`, `UserSector`, `Client` e `Sector` reutilizados.
- Event Sourcing (fatos PostgreSQL append-only), Outbox transacional, RabbitMQ at-least-once, Mongo CQRS reconstruível.
- Projeções próprias de OS, organizadas por OS e produto, sem dependência de eventos/módulos de estoque.
- Nenhuma mudança silenciosa em rotas legadas, dados de produção ou migrations aplicadas.

## Incompatibilidades detectadas na versão compartilhada da Feature 004

| Tema       | O que a especificação/tarefas antigas previam              | Direção aprovada                                                                   |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Numeração  | Contador/sequência externa gerado pela API                 | Número inserido manualmente; restrição única por setor                             |
| Fila       | Triagem obrigatória 7+ e elegibilidade                     | Sem triagem; FIFO como ordenação, não fluxo de atribuição                          |
| Produção   | Divisões por quantidade e apontamento de execução          | Apenas status individual por produto e qualidade                                   |
| Qualidade  | Veto à autoaprovação e gestão formal do retrabalho         | Aprovação por autorizado, mesmo autor; solução fora do sistema                     |
| Revisão    | Solicitante/aprovador, versão vigente, revisão pendente    | Correção auditada sem aprovação adicional                                          |
| Ciclo      | Suspensão/retomada/reabertura, encerramento administrativo | Eliminar ciclos extras; conclusão definitiva terminal                              |
| Status     | Sete estados públicos antigos                              | Seis estados aprovados; contrato do cliente restrito                               |
| Permissões | Grants granulares gerenciais                               | Conjunto de poderes do responsável; autorização expressa específica quando exigida |
| Cliente    | Consulta interna detalhada da própria OS                   | Apenas marcos do pedido exibidos no sistema de acesso do cliente                   |
| Prioridade | Possível ordenação de urgentes antes do FIFO               | Indicador visual, ordem de chegada inalterada                                      |

## Riscos e decisões técnicas necessárias (somente onde bloqueantes)

**R1 — Histórico físico já implementado.** A Feature 004 tem Model/repositories/migrations de escopo antigo, segundo o relatório de revisão. Uma edição documental não remove schema nem apaga histórico. Primeiro inventariar referências em rotas, testes, eventos, grants e projeções. Retirada de código exige análise de compatibilidade e aprovação separada; não fazer DROP.

**R2 — Quantidade imutável (RF-10 resolvido).** A decisão funcional definitiva substitui a antiga regra de limite mínimo produzido: quantidade não pode aumentar nem diminuir após cadastro, em qualquer estado. Não implementar correção quantitativa, contador de unidades produzidas ou apontamentos de fabricação.

**R3 — RF-07 definitivo: opcionais sem material condicionado.** Nome não vazio, quantidade inteira positiva e largura/altura numéricas, finitas e positivas são obrigatórios. Espessura e cores são opcionais na API; quando informadas, espessura deve ser numérica, finita e positiva e cores devem ser textos livres não vazios. Preservar aliases e JSON histórico, sem conversão de unidades. Não criar catálogo/classificação/enumeração/seletor obrigatório e não inferir aplicabilidade por nome. Mesma validação de medidas no cadastro e nas correções permitidas por RF-09/RF-11.

**R4 — Superfície de acompanhamento do cliente.** O cliente recebe status no _sistema dele_, não acesso a relatórios/inspeções da Feature 004. Não inferir endpoint, push, webhook ou consumidor. Mapear os três marcos públicos explicitamente mencionados e o tratamento dos demais estados antes do contrato final.

**R5 — Autorização e concorrência.** A regra exige no máximo uma OS ativa por colaborador e um vínculo ativo por OS. Confirmação precisa ser atômica no PostgreSQL, inclusive ao liberar/cancelar/concluir. A base existente de grants deve ser reconciliada com o conjunto gerencial simplificado, sem migração precoce.

**R6 — Histórico de qualidade.** O relatório de auditoria aponta `inspection_history` acumulado como array JSON e risco de crescimento/paginação. Confirmar se os fatos canônicos já permitem reconstrução/histórico; não introduzir duplicação sem necessidade.

**R7 — Integração e testes.** `tasks.md` registra baseline isolado com migrations selecionadas e falhas de integração de autenticação (`pin_hash` ausente). Isso não valida a Feature 004 revisada. Não fazer `yarn test:integration`, migrations ou subir containers até conferir alvo e obter autorização de execução.

**R8 — G8 de retenção.** Sem decisão legal/funcional aprovada, não criar expurgo, anonimização ou prazo automático de retenção. Preservar histórico e não alegar retenção infinita como política definitiva.

## Convenções de execução futuras

- Yarn Classic v1 e `yarn.lock` canônico. Não usar npm/npx.
- Worktree dedicado e branch correta, sem alterar `main/master`.
- Nenhuma migration aplicada deve ser reescrita. Estratégia de compatibilidade aditiva/compensatória precisa aprovação técnica.
- Relatório de diffs antes de qualquer alteração de código.
