# Arquitetura aprovada dos domínios — Alves Glass API

**Status:** consolidação documental de decisões aprovadas; não é autorização para implementar,
alterar infraestrutura ou ampliar o escopo de uma feature. A Constituição vigente prevalece. Este
documento corrige interpretações divergentes em documentos de plano; não substitui decisões de
negócio nem altera as fronteiras das Features 003, 004 e 005.

## Estado das afirmações

- **Arquitetura aprovada:** direção obrigatória para a evolução dos dois domínios, ainda que partes
  não estejam implementadas neste checkout.
- **Implementado:** somente o que tem código e testes/execução identificáveis abaixo.
- **Planejado:** trabalho necessário para realizar a arquitetura, sem alegar existência de código.
- **Pendente:** detalhes operacionais, contratos ou evidência ainda não localizados/aprovados.

Ausência de implementação, dependência de infraestrutura ou artefato faltante **não** equivale a
revogação da decisão arquitetural. Uma mudança de arquitetura exige decisão explícita compatível com
governança e Constituição, não inferência de um “fora de escopo” local.

## Domínio Estoque — arquitetura aprovada

- Event Sourcing e CQRS são a direção arquitetural: fatos de entrada, saída, devolução, ajuste,
  abertura e compensação são históricos imutáveis; consultas/projeções são modelos de leitura
  distintos dos comandos.
- PostgreSQL é a fonte de verdade operacional. A mutação do saldo operacional e a gravação do evento
  devem ser atômicas. O saldo transacional é a visão operacional corrente, não uma segunda
  autoridade independente do ledger. Eventos corrigem-se por compensação, não por edição.
- Outbox grava, na mesma transação dos fatos que precisam ser publicados, mensagens de integração
  confiáveis. RabbitMQ distribui com semântica at-least-once; consumidores deduplicam por identidade
  de evento. Indisponibilidade do broker não deve desfazer um comando já confirmado em PostgreSQL.
- MongoDB hospeda projeções de leitura de saldo, extrato e relatórios, reconstruíveis a partir dos
  fatos canônicos. Snapshots podem otimizar reconstrução/consulta, sem substituir a fonte canônica.
- O saldo legado `Product.quantity` e o saldo do novo `Material` continuam separados; essa
  separação não exclui Event Sourcing/CQRS de nenhum dos domínios e não autoriza sincronização entre
  eles.

## Domínio Ordens de Serviço — arquitetura aprovada

- Event Sourcing e CQRS são igualmente a direção arquitetural do domínio de OS. Cada produto/item
  da OS tem estado individual e histórico de eventos próprio; o estado geral da OS é derivado dos
  estados dos produtos segundo a política funcional aprovada.
- PostgreSQL é a fonte de verdade operacional. Eventos de OS e mudanças de estado persistem
  transacionalmente com a respectiva decisão de domínio.
- Outbox/RabbitMQ distribuem eventos de OS com entrega at-least-once e consumidores idempotentes.
  MongoDB contém projeções de leitura/histórico reconstruíveis; snapshots de OS permanecem opcionais.
  Para Estoque da Feature 003, snapshots versionados são exigidos pelo critério de aceite da feature
  registrado em 12/11/2026 (T051), sem substituir o ledger.
- Eventos de produção/OS e eventos de movimentação de estoque são fluxos e contratos separados.
  Item/produto de OS não é material nem produto de estoque. Não inferir FK, reserva, consumo, baixa,
  reversão ou transição automática entre domínios. Qualquer integração futura requer contrato
  aprovado sem fundir os históricos.

## Fronteiras de features e dependências

- **Feature 003 — setores e fundação de estoque:** entrega autorização setorial, catálogo Material,
  saldo operacional transacional PostgreSQL, ledger, idempotência, QR/PIN e relatórios no PostgreSQL,
  além do ciclo de imagem sujeito a G5. Seu escopo de entrega pode excluir worker/broker/projeções;
  isso não cancela a arquitetura-alvo nem transfere a responsabilidade inteira para 005. A conclusão
  da 003 descreve o alvo arquitetural; estado da implementação registrado em
  `specs/003-sectors-inventory-foundation/tasks.md`.
- **Feature 004 —** o artefato de especificação/contratos não foi localizado nesta auditoria. Nome,
  escopo funcional, entregáveis e dependências permanecem **não verificados**; não atribuir aqui
  funcionalidades nem mover itens entre features.
- **Feature 005 —** referências anteriores indicam dependência de implementação de arquitetura/eventos,
  mas o artefato de especificação/contratos não foi localizado nesta auditoria. Não é a única
  responsável por aprovar a arquitetura: ambos os domínios já a têm como direção aprovada. Escopo e
  dependências concretos devem ser confirmados nos documentos originais antes de retomar trabalho.
- A sequência concreta de entrega deve respeitar os planos existentes e explicitar dependências
  técnicas. Esta consolidação não muda fronteiras nem cria autorização para iniciar 004/005.

## Evidência observada no checkout auditado

### Implementado e preservado

- Estoque Material: modelos/tabelas `InventoryEvent`, `MaterialBalance`, `MovementIdempotency`,
  `StockMovementService`, repositories e migrations; atualização transacional de saldo, evento e
  receipt de idempotência; proteções append-only no ledger; compensações; autorização setorial; QR/PIN
  e relatórios PostgreSQL. Há testes unitários e alguns testes PostgreSQL direcionados.
- Mídia: schema aditivo de intents/jobs e serviços preparados para upload/limpeza; endpoint não
  habilitado e validação operacional G5 ainda pendente.
- OS: há `Order`, `OrdersProducts`, services e migrations do modelo corrente. Isso não demonstra
  Event Sourcing de OS, estado individual/event stream por produto, estado agregado derivado, Outbox
  ou projeções.
- A Constituição define a semântica at-least-once de Outbox/RabbitMQ e projeções MongoDB
  reconstruíveis. Isso é princípio aprovado, não evidência de componente implantado.

### Não localizado / pendente de comprovação

- (Histórico de baseline) código, migration, worker ou tabela de Outbox no checkout pesquisado antes
  da implementação da Feature 003; as entregas T048–T050 estão registradas em seu checklist.
- Cliente, publisher, topologia ou configuração RabbitMQ no checkout pesquisado.
- Cliente, schemas/projeções ou configuração MongoDB no checkout pesquisado.
- Configuração Redis de autenticação localizada nesta inspeção; menções documentais não provam
  conectividade/uso corrente. A arquitetura de Redis deve ser verificada em auditoria operacional
  específica antes de qualquer alteração.
- Artefatos de especificação/plano/research/contract de Features 004 e 005 não localizados no
  diretório `specs/` pesquisado.

Estes itens são lacunas observadas, não decisões de cancelamento. A próxima auditoria deve localizar
documentos históricos/originais aprovados e conferir branches/configuração externa antes de qualquer
implementação ou conclusão de escopo.