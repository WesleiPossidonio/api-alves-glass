# Quickstart — Validação e testes planejados da Feature 004

> Matriz de testes do planejamento original, incluindo cenários legados que não são comandos ativos. A aceitação vigente e comandos/resultados finais estão em `final-validation.md`. Não executar migrations, ativação de geração ou workflows removidos com base nesta lista.

Este guia é um contrato de planejamento, não uma autorização para executar comandos que alterem estado. Nenhuma migration, banco, broker, volume, consumer ou serviço deve ser iniciado sem aprovação explícita do ambiente descartável e do plano.

## Pré-condições de implementação futura

1. Considerar G1 formalizado no plano da Feature 004: a distribuição por produto/quantidade prevalece somente neste escopo sobre remediation §9.2; manter `Order`/`OrdersProducts` legados preservados e separados, sem conversão automática. G2/G3/G4 já são decisões funcionais aprovadas; implementar os contratos correspondentes sem reabri-los.
2. Confirmar ambiente descartável PostgreSQL e versões/runtime efetivos; G9 exige autorização antes de executar migrations, consumers ou testes de integração; nunca apontar testes a banco compartilhado/produção.
3. G6/G9: autorizar e validar separadamente recursos RabbitMQ e Mongo replica set descartáveis e credenciais de teste antes de executar consumers ou testes integrados; não reutilizar volumes existentes sem aprovação.
4. Definir variáveis de ambiente próprias do pipeline OS conforme mecanismo compartilhado aprovado; não assumir nomes/configuração do worker de Estoque como contrato OS.
5. Revisar migrations aditivas e procedimento de reset/rollback antes de qualquer `db:migrate`.

## Comandos existentes — referência, não executar nesta etapa

- Unitários existentes: `npm test`.
- Integração PostgreSQL existente: `npm run test:integration`.
- Migrations Sequelize convencionais: `npm run db:migrate:status`, `npm run db:migrate`.
- Workers atuais da Feature 003 (`inventory:outbox-worker`, `inventory:projection-consumer`) são específicos de estoque e **não** devem ser usados para processar OS.

Os testes de OS futuros devem seguir `node:test` e convenções do repositório, adicionando suites próprias sem modificar ou apropriar testes/serviços `stock`.

## Matriz mínima de validação futura

### Unitário (sem serviços externos)

- Validação de cadastro, número externo textual, cliente/setor obrigatórios, itens e medidas flexíveis.
- Sequência numérica independente por setor, `(sectorId, externalNumber)` concorrente e único, zeros à esquerda, mesmo número permitido nos dois setores, UUID interno e não reutilização após cancelamento.
- Client global com múltiplas OS por setor e leitura consolidada apenas das OS próprias; isolamento de setor em fila, relatórios, indicadores e históricos.
- FIFO por setor, desempate estável, corte por item 1–6 versus 7+ e preservação da prioridade após triagem; triagem usa quantidade total por item, sem somar outros itens; distribuição entre colaboradores não altera o limiar.
- Quantidades de produção inteiras positivas `UN`; dimensões precisas por item e itens dimensionalmente distintos mesmo com o mesmo nome.
- Distribuição fracionada e soma atribuída; reatribuição sem reescrever autoria.
- Produção inválida/excessiva/duplicada, estados impeditivos e cálculo por produto.
- Não conformidade, bloqueio de quantidade, disposição, retrabalho, inspeção parcial e veto de autoinspeção do próprio retrabalho inclusive admin.
- Revisão pendente/aprovada/rejeitada e vínculo de execução à versão/ciclo.
- Suspensão/retomada/cancelamento/conclusão/encerramento/reabertura; ciclo ativo exclusivo.
- Agregação: produto concluído + produto em produção → OS `IN_PRODUCTION`; nenhum início → marco anterior; todos cumpridos → conclusão canônica; status administrativo não sobrescrito.
- Autorização client/admin/manager/collaborator, grants UserSector e permissões por usuário+setor+operação; permissões diferentes de gerente entre setores, vedação de autoconcessão, revogação prospectiva e invariantes não sobreponíveis.
- Inspeção independente: executor de retrabalho não pode aprovar a própria execução, mesmo admin; projeção pública sem campos privados.

### PostgreSQL (ambiente descartável autorizado)

- Migrations aditivas e compatibilidade de rotas/dados legados `Order`.
- FKs, unicidade externa `(sector_id, external_number)`, alocação concorrente da sequência setorial sem reutilização, sequência de aggregateVersion e append-only. Executar somente após gate G9. Retenção/anonimização permanece G8 pendente: não implementar nem executar retenção, anonimização ou expurgo; não fixar prazo.
- Concorrência: dois claims exclusivos, alocação concorrente acima do disponível, produção repetida, última conclusão concorrente, revisão versus execução, suspensão/cancelamento versus produção e abertura simultânea de ciclo.
- Verificação de atomicidade: fato de domínio + decisão + Outbox todos commitam ou rollbackam juntos.
- Mudança/revogação de grant durante operação: autorização revalidada e resultado serializável segundo política.

### RabbitMQ e MongoDB (G6/G9 validados; ambiente descartável aprovado)

- Publisher confirm, indisponibilidade/retry/backoff/lease e redelivery at-least-once sem perder fato PostgreSQL.
- Consumer dedupe por `consumer + eventId`; ordem causal, duplicado, versão antiga, gap, envelope inválido/DLQ.
- Atualização atômica de movimento por produto, head/summary da OS e checkpoint; nenhum efeito duplicado.
- Projeção orientada à OS com produtos e histórico lógico `products[].movements[]`, paginação por produto e cursores estáveis.
- Reconstrução a partir do log canônico, geração nova, verificação e ativação; snapshot opcional não perde replay integral.
- Falha de Mongo/projeção não desfaz nem invalida comando PostgreSQL já confirmado.

### HTTP/segurança

- Mutação autenticada exige sessão, Origin/CSRF segundo Feature 002; autorização valida role, ownership, setor e estado no backend.
- Autoria de eventos vem da sessão; clientes não selecionam executor/inspetor/actor.
- Cliente só consulta suas OS; DTO público não expõe atribuições, dados pessoais, detalhes internos de qualidade ou histórico privado.
- Leitura eventualmente consistente comunica versão/atraso segundo contrato aprovado; Mongo nunca autoriza comando.

## Critério de conclusão dos testes

Executar somente após autorização de implementação e ambiente. Registrar comandos, versões, IDs dos ambientes isolados, resultados e evidências. Não declarar passagens de testes até que tenham sido realmente executados. Aprovação deste quickstart não equivale a aprovação de schema, tasks, release ou deploy.
