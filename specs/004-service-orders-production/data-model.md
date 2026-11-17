# Feature 004 — Modelo conceitual revisado

**Status:** PROPOSTA; não é migração, DDL nem nomenclatura física aprovada. Referência normativa: `spec.md` da proposta.

## Entidades e relações necessárias

| Conceito                                      | Dados e finalidade                                                                                                            | Restrições                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceOrder` (OS)                           | ID global, número externo textual, setor, cliente, data prevista, status, prioridade, instantes e autorias                    | Cliente e setor existentes; `(sectorId, orderNumber)` único; estados terminais imutáveis                                         |
| `ServiceOrderProduct`                         | ID, OS, nome, quantidade `UN`, largura, altura, espessura/cores opcionais, descrição, observação, status de produção          | Composição e quantidade fixas após criação; correções dos campos permitidos auditadas; sem FK obrigatória a estoque              |
| `ServiceOrderResponsibility` (vínculo)        | OS, colaborador atual, data de assunção e liberação, autor da liberação, histórico                                            | Máximo um vínculo ativo por OS e por colaborador; pertence a setor autorizado                                                    |
| `ServiceOrderQualitySignal` (sinalização)     | Produto, colaborador vinculado, instante, finalidade inicial/reinspeção, referência a rejeição anterior quando for reinspeção | Apenas vinculado; sinal inicial após todas as unidades fisicamente prontas; reinspeção só rejeitadas                             |
| `ServiceOrderQualityInspection`               | Produto, quantidade inspecionada, aprovada, rejeitada, descrição da rejeição, inspetor, data, vínculo com sinalização         | Aprovado + rejeitado compatível com universo inspecionado; rejeição com descrição obrigatória; aprovações anteriores preservadas |
| `ServiceOrderEvent` (fato canônico)           | Stream da OS, evento ID, versão contígua, tipo, ator, instante, payload e referências aos produtos                            | Append-only, sem reescrita retroativa; domínio OS isolado                                                                        |
| `ServiceOrderOutbox` / checkpoint de projeção | Publicação confiável e posição aplicada à projeção                                                                            | Idempotência, sem duplo efeito; reutilizar infraestrutura genérica aprovada                                                      |

**Observação:** não há aprovação para introduzir cada nome acima como tabela independente; são **conceitos** e podem ser implementados com estruturas físicas já existentes, desde que satisfaçam invariantes e não recriem módulos removidos.

## Identidades reutilizadas

- `Client`: cadastro global compartilhado; OS contém FK para cliente já existente.
- `Sector` e `UserSector`: autorizam ações e leitura; um usuário pode acessar mais de um setor.
- `User`: mesma identidade da autenticação atual, sem criar tabela de colaboradores paralela.
- `Order` e `OrdersProducts` legados: **não presumir equivalência** com OS nem alterar suas tabelas/rotas durante a revisão.

## Invariantes transacionais

1. Uma OS pertence a exatamente um setor e um cliente. Seu número é livremente escolhido no cadastro, único dentro do setor e textual.
2. Uma OS contém um ou mais produtos na criação; a lista de referências dos produtos não muda após o commit.
3. Exclusividade simultânea: no máximo um colaborador vinculado a cada OS e no máximo uma OS ativa por colaborador. Consultar e validar isso **dentro da mesma transação/constraint/concurrency strategy**, sem confiar somente no frontend.
4. A OS assumida continua ativa para o colaborador mesmo após aprovação da qualidade e enquanto aguarda entrega/instalação. Cancelamento ou conclusão definitiva libera o vínculo; liberação por gestor conserva auditoria.
5. Produto só se conclui após toda a sua quantidade estar aprovada pela qualidade. Rejeição parcial não revoga aprovação anterior. Inspeções posteriores devem se vincular às unidades rejeitadas logicamente, sem exigir identificação individual física de cada peça.
6. O status da OS não se confunde com o de seus produtos; `Aguardando entrega/instalação` só após aprovação de todos e confirmação de fechamento da produção.
7. Quantidade, identidade e composição são imutáveis após o cadastro, em qualquer estado. Nome, descrição e medidas só podem ser corrigidos em `IN_PRODUCTION`, antes de qualquer registro ou sinalização de qualidade do próprio produto. O bloqueio é definitivo e individual, sem impedir correções em outros itens sem atividade própria de qualidade. Correção dos campos permitidos, como medidas, **nunca sobrescreve o fato antigo**; o estado corrente pode ser materializado, mas o evento de alteração guarda anterior e novo.
8. Projeção de leitura associa cada movimento ao produto de origem (`products[].movements[]`), sem um array global que perca a relação.
9. Prioridade não altera ordenação FIFO. Datas/identificadores usados como desempate devem ser estáveis e documentados.

## Registros removidos do modelo-alvo

Não criar como domínio ativo: triagem obrigatória, frações de atribuição/execução por colaborador, apontamentos de unidades produzidas, workflows de descarte/substituição/retrabalho, solicitação/aprovação de revisão, suspensão/retomada, reabertura e ciclos adicionais. **Não remover tabelas existentes fisicamente agora**; apenas excluir esses processos do modelo-alvo e preparar análise de compatibilidade.

RF-07: largura/altura obrigatórias, numéricas, finitas e positivas; espessura opcional com o mesmo formato numérico; cores opcionais como texto livre não vazio. Preservar JSON e aliases, sem conversão de unidades nem classificação de materiais.

## Questões de desenho ainda abertas

- Caso de transferência de OS com conferência pendente: histórico preservado e colaborador vinculado no momento do novo sinal; detalhes de restrições operacionais devem ser derivados do domínio aprovado, sem fluxo extra presumido.
- Distinção de `status` canônico e campos da projeção do cliente; contrato externo ainda depende de interface aprovada.
- Política de armazenamento/paginação de histórico de inspeção; não manter array JSON ilimitado sem avaliação.
