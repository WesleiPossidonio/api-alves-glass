# Feature 004 — Plano de realinhamento, sem implementação nesta etapa

> Contexto histórico de planejamento/proposta. Para o contrato vigente, consultar `spec.md`, `product-corrections.md`, `rf31-client-tracking.md` e `final-validation.md`. Trechos legados sobre contador, FIFO numérico ou workflows removidos não autorizam sua reativação.

**Estado:** PROPOSTA. Este plano substitui o desenho operacional excessivo somente após aprovação e conciliação com os documentos vigentes.

## Objetivo

Reduzir a Feature 004 ao backend de cadastro/acompanhamento de OS e qualidade. Preservar identidade/segurança, histórico auditável, arquitetura Event Sourcing/CQRS e independência dos setores e estoque.

## Fase A — Preservar o estado atual e comparar fontes

1. Confirmar worktree/branch, `git status --short`, diff pré-existente e versão de `spec.md`, `data-model.md`, `plan.md`, `research.md`, `tasks.md`, `contracts/events.md`, `contracts/read-api.md` e Constituição.
2. Não descartar nem sobrescrever alterações locais; não fazer commits/PR sem autorização.
3. Confrontar esta proposta com cada requisito e a lista real de tarefas do checkout, referenciando origem e decisão posterior que substitui regra antiga.
4. Identificar requisitos e tarefas que implementam ou testam fluxos removidos, sem ainda apagar código.

**Entrega da fase:** matriz real com `mantém / altera / remove do escopo / pendente técnico`, caminhos e critérios de aceite. Nenhuma mutação de código/DB.

## Fase B — Consolidar documentos normativos

1. Reescrever `spec.md` com invariantes aprovadas; não manter FRs contraditórios apenas para preservar numeração antiga.
2. Alinhar `data-model.md` e contratos de eventos/leitura ao domínio simplificado; os nomes físicos permanecem sujeitos a compatibilidade real.
3. Atualizar `research.md` e `plan.md` sem recriar workflows removidos ou questionamentos sobre decisões funcionais já respondidas.
4. Gerar `tasks.md` coerente com a nova especificação, evitando IDs duplicados e marcando como pendentes todos os aceites ainda não executados.
5. Passar por uma revisão de consistência da documentação: estados, autorização, cancelamento, qualidade, FIFO, exclusividade, números setoriais, dados públicos e arquitetura.

**Gate B:** apresentar diff documental; usuário aprova antes de aplicar novos contratos ou alterar implementação.

## Fase C — Inventário do código existente (somente leitura)

Inspecionar `src/routes.js`, controllers/services/repositories/models/migrations de ServiceOrder, autorização, schemas/validators, tests, EventRepository/Outbox/consumer/projection, e interfaces legadas `Order` e `OrdersProducts` apenas como dependências de compatibilidade.

Classificar por artefato:

| Classificação                  | Significado                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Reutilizável                   | Já implementa regra aprovada e não depende de fluxo removido                           |
| Ajustar                        | Há diferença direta com requisito aprovado                                             |
| Obsoleto no domínio            | Só sustenta triagem/distribuição/reabertura etc.                                       |
| Dependência de compatibilidade | Não pode ser apagado sem análise de schema, evento, rota, consumidor ou dado existente |
| Sem evidência                  | Necessita teste/inspeção adicional antes de afirmar conformidade                       |

**Entrega da fase:** mapa de alterações por arquivo e riscos, sem deletar tabela, evento ou código.

## Fase D — Planejar implementação e testes, sob autorização adicional

- Atualizar serviços/validações de cadastro e correção, transições de status, assunção exclusiva, inspeção e cancelamento.
- Consolidar autorização no backend usando sessão e vínculo setorial, sem novos papéis persistidos presumidos.
- Corrigir serialização de status e consulta do cliente **somente após contrato externo definido**.
- Rever eventos/projeções sem apagar logs legados nem reescrever migrations aplicadas.
- Testes unitários para invariantes; integração PostgreSQL real para unicidade/atomicidade/concorrência; integração Outbox/RabbitMQ/Mongo para idempotência/replay.
- Testes apenas em ambiente isolado verificado e explicitamente autorizado, nunca dados de produção/compartilhados.

**Gate D:** nenhuma execução de migration, test de integração, `DROP`, `TRUNCATE`, rollback, limpeza de volumes, alteração de dados ou deploy sem aprovação expressa do alvo e da operação.

## Fora de escopo de todas as fases

Feature 003, movimentação automática de estoque, PDF no backend, logística, fabricação técnica, interfaces frontend nesta feature, microserviços, gravação indiscriminada em banco, mudanças no legado `Order`/`OrdersProducts` sem estratégia aprovada.

## Critério de conclusão do realinhamento documental

Todos os documentos normativos representam o mesmo conjunto de comportamentos aprovados; matriz de requisitos e tarefas tem rastreabilidade; pontos pendentes estão explícitos e não convertidos em requisitos inventados; diffs foram revisados. A conclusão do realinhamento documental **não** implica que a Feature 004 esteja implementada ou testada.
