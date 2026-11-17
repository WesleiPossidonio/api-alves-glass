# RF-32 — leitura interna e histórico individual

## Ajustes limitados à leitura CQRS

- Mantido o vínculo OS → products[] → movements[]. Eventos sem produto não
  são replicados artificialmente nos históricos dos itens.
- Movimentos preservam os campos do payload canônico: valores anteriores/novos
  de correções, quantidades aprovadas/rejeitadas, motivos e referências de
  inspeção/reinspeção. Metadados de evento, autor e data prevalecem sobre payload.
- Histórico em ordem causal decrescente por aggregateVersion, com comparação
  numérica das strings no MongoDB, inclusive entre 9 e 10, sem migrar documentos.
- Cursor assinado vinculado a OS, produto, usuário, geração e versão-limite do
  histórico. O cursor existente também é devolvido na consulta sem filtro de item.
- O limite é por página de movimentos da consulta, não por produto. Cada produto
  recebe somente os movimentos dele presentes nessa página.
- Cursores mantêm o corte histórico inicial; o resumo dos produtos é o head
  atual da projeção. readModelVersion informa esse head, sem fingir um snapshot
  antigo do resumo. operationalVersion continua sendo canônica (PostgreSQL).
- Projeção inexistente de OS interna já autorizada retorna projectionPending;
  projeção adiantada em relação ao canônico é rejeitada. Atraso legítimo continua
  explícito pelas duas versões e consistência EVENTUAL.
- Administrador global não depende de concessão individual READ_INTERNAL.
  Usuários não administradores precisam de associação vigente e READ_INTERNAL.
- Seis estados funcionais permanecem no status interno; nenhuma alteração em
  estados públicos ou na integração de cliente (RF-31).
- Prioridade continua informativa. Nenhuma consulta FIFO foi modificada.

## Compatibilidade e replay

Eventos históricos não foram alterados. O reducer mantém os tratamentos legados.
Removido somente um case duplicado/inacessível de QualityInspectionRecorded;
aprovações continuam derivadas do fato separado QualityQuantityApproved.

Corrigida preservação do ObjectId BSON na substituição do documento Mongo.
Movimentos novos usam identidade Mongo composta por geração/evento, permitindo
que o mesmo evento seja reconstruído em outra geração. Documentos antigos com
\_id igual ao eventId continuam legíveis; eventId e identidade lógica não mudam.
Corrigida comparação BigInt do checkpoint anterior no replay.

Não foi executada reconstrução/ativação da geração operacional existente.
Para atualizar projeções antigas, usar o mecanismo de replay/verificação/ativação
já existente em execução operacional separada e autorizada; não reescrever fatos.

## Evidência

- Unitários dedicados em serviceOrderReadHistory.test.js e regressões de OS.
- Integração service-order-read-history-cqrs.recovery.integration.test.js com
  PostgreSQL/Outbox reais, publisher confirm RabbitMQ, consumer e transações
  MongoDB no replica set feature004-recovery-rs.
- Mesmos recursos/conexões do script recovery existente no package.json.
- Uma OS/two itens e 18 fatos são criados apenas em transação PostgreSQL
  rollback-only: não persistem novas OS, produtos, eventos ou Outbox canônicos.
- Publicação lê as linhas reais da Outbox da transação e usa fila exclusiva
  temporária. Claim/lease e marcação são isolados no teste; isso não é prova
  adicional do scheduler/claim global, que não é exercitado nesta validação.
- Duas gerações Mongo isoladas validam consumo, duplicado, paginação por OS/item
  e equivalência do replay. A ativação é substituída por asserção local para não
  trocar o controle ativo; portanto o teste não prova ativação operacional.
- Documentos Mongo anteriores e tabelas canônicas acompanhadas são comparados
  antes/depois. Nenhuma limpeza de dados, eventos ou volumes é feita pelo teste
  bem-sucedido. As gerações de evidência permanecem fora da geração ativa.

Nenhuma decisão funcional nova é necessária para os ajustes realizados em RF-32.
