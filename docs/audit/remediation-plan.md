# Plano consolidado de saneamento técnico — Alves Glass API

> **Natureza deste documento:** plano técnico, sem implementação. Elaborado a partir de `docs/audit/technical-audit.md`, `docs/audit/technical-audit-review.md` e da inspeção estática do código no estado atual do diretório de trabalho em **4 de novembro de 2026**. Quando um relatório diverge do código atual, este plano adota o código como evidência e registra a divergência.

## 1. Resumo executivo

O saneamento deve ser conduzido em quatro frentes dependentes:

1. **Reconstruir o banco em ambiente de rebuild**, a partir de um esquema canônico novo e versionado, após inventário e reconciliação dos dados existentes. As migrations atuais não devem ser alteradas nem reutilizadas como fonte de verdade sem revisão.
2. **Consolidar autenticação por cookie HttpOnly**, removendo ambiguidade entre controllers, middleware e frontend, e centralizando autorização por política de rota/caso de uso.
3. **Reconstruir separadamente os domínios de ordens de serviço (OS) e estoque**: produtos da OS terão ciclo de vida e histórico próprios; produtos de estoque terão saldo oficial em `product.quantity` e ledger imutável, sem FK, associação Sequelize ou automação obrigatória entre os domínios.
4. **Evoluir o Outbox para entrega ao-menos-uma-vez com consumidores idempotentes**, preservando PostgreSQL como fonte de verdade. RabbitMQ será canal de integração opcional: indisponibilidade do broker não invalida o registro transacional de saldo e evento interno de estoque.

O código atual contém defeitos comprovados que impedem uma simples correção pontual de schema: divergência entre model e migration de endereço, associações Sequelize inconsistentes, endpoints ligados diretamente a services, autorização não uniforme, branches com `response` inexistente em services e estoque sem caso de uso operacional. A ausência de `product_id` de estoque em itens de pedido/OS **não é defeito**: é a independência arquitetural aprovada entre os dois domínios. A reconstrução aprovada só deve ocorrer após inventário, cópia verificável e decisão humana sobre regras ainda não documentadas.

### Princípios de execução

- O PostgreSQL reconstruído será a fonte oficial para entidades operacionais, saldo e eventos de estoque.
- Migrations novas serão **aditivas no novo baseline**; as migrations existentes permanecem intactas como artefato histórico.
- Nenhum dado será removido sem inventário, exportação recuperável, classificação de qualidade e decisão de reconciliação documentada.
- Eventos de estoque serão append-only; correções ocorrerão por novo evento, nunca por alteração/exclusão do evento original.
- Cada movimentação operacional exigirá descrição livre obrigatória, preservada no ledger; a identidade do responsável será obtida da sessão autenticada, nunca de campo livre enviado pelo frontend.
- O broker não decidirá saldo nem substituirá a transação do banco. O ledger e o saldo permanecem consistentes mesmo quando RabbitMQ estiver indisponível; publicação é responsabilidade posterior do Outbox quando houver necessidade real de integração.
- Produtos de OS e produtos de estoque são domínios independentes: não haverá FK, association Sequelize, baixa, reserva, consumo, reversão ou mudança de status automática entre eles.
- Funcionalidades futuras (MongoDB, CQRS amplo, Kafka, microserviços, TypeScript, OpenAPI, LGPD) são backlog condicional, não requisito desta etapa, exceto quando vierem a ser aprovadas separadamente.

## 2. Decisões arquiteturais aprovadas

| Decisão | Consequência obrigatória no plano | Limite explícito |
| --- | --- | --- |
| **Banco: REBUILD** | Criar esquema-alvo, migrations novas, models/associações/constraints/índices coerentes e processo de carga reconciliada. | Não padronizar UUID/INTEGER por estética; justificar cada PK/FK. Não apagar dados antes de inventário e reconciliação. |
| **Autenticação: COOKIE** | JWT de sessão em cookie HttpOnly; login, logout, middleware, CORS, Google OAuth e frontend devem usar o mesmo contrato. | Token não deve ser retornado como estratégia principal ao frontend. Atributos de cookie devem variar por ambiente de forma explícita. |
| **Estoque: EVENTS** | PostgreSQL persiste `product.quantity` (saldo oficial) e ledger interno imutável na mesma transação; o Outbox poderá publicar fatos de integração quando houver necessidade real; consumidores devem ser idempotentes. | MongoDB, se adotado depois, será projeção de leitura e nunca fonte oficial do saldo. Não há vínculo estrutural ou automação entre estoque e produtos da OS. |
| **OS × estoque: independência** | Produtos/itens da OS e produtos de estoque têm ciclos de vida, eventos e reconciliações próprios. | Não criar FK, association Sequelize, baixa, reserva, consumo, reversão ou alteração de status automática entre os domínios. Integração futura exige novo requisito e aprovação específicos. |

## 3. Fontes, método e divergências registradas

### 3.1 Método

Foram comparados os dois relatórios com rotas, models, migrations, services, repositories, worker e consumer. A classificação abaixo usa:

- **Defeito comprovado:** evidência estática direta no código atual.
- **Hipótese / validação operacional:** exige banco, containers, tráfego ou dados reais.
- **Decisão de negócio pendente:** não pode ser inferida de forma segura a partir do código.
- **Decisão aprovada:** fornecida para esta atividade e, portanto, vinculante para o desenho-alvo.

### 3.2 Divergências entre relatórios e código atual

| Tema | Relatório original / revisão | Evidência atual | Tratamento no plano |
| --- | --- | --- | --- |
| Número de migrations | `technical-audit.md` afirma 11, mas lista 12. | Existem 12 arquivos `.js` em `src/database/migrations/`. | Inventário inicial considera 12; baseline novo não depende da contagem histórica. |
| JWT em cookie | Relatório original declara cookie HttpOnly; a revisão anterior tratou isso como parcialmente confirmado. | `SessionsController.js:28-37`, `SessionClientController.js:19-28` e `GoogleSessionController.js:46-58` definem cookie. | Cookie é comportamento atual, mas implementação é inconsistente (`secure: false` em dois fluxos). |
| `secure: false` | A revisão anterior marcou a afirmação como incorreta. | Há `secure: false` em `SessionsController.js:31` e `SessionClientController.js:22`; Google usa `NODE_ENV`. | Código prevalece: corrigir como defeito comprovado de configuração inconsistente. |
| Segredo commitado | Auditoria original afirmou segredo JWT commitado. | `.env` está ignorado e não rastreado no estado atual; `auth.js` só lê variáveis. | Não tratar como fato. Fazer varredura de histórico/secret scanner em atividade separada, se aprovada. |
| Controllers e rotas de endereço | Auditoria mapeia `AddressClientController`/`OrderAddressController`. | `routes.js:19,52-59` liga endereço de cliente diretamente ao service; há arquivo `OrderAddressControllet.js`, não roteado. | Corrigir contrato de rota/controller no saneamento da API; remover/arquivar código morto somente após decisão de compatibilidade. |
| Idempotência no consumer | Auditoria original sugere robustez da mensageria. | `ClientCreatedConsumer.js:48-55,112-123` valida/loga `eventId`, mas não o persiste nem consulta antes de enviar e-mail. | Tratar idempotência como lacuna comprovada. |

## 4. Matriz de achados, evidências e tratamento

### 4.1 Estrutura, runtime e fronteiras de camada

| ID | Achado e evidência | Classificação | Tratamento proposto | Dependências |
| --- | --- | --- | --- | --- |
| A01 | Services chamam `response.status(...)` sem receber/importar `response`: `OrderService.js:104,118,134`, `ClientService.js:75,108,137,149,159,165,232`, `UserService.js:10,31,47,57,67`, `OrderAddressService.js:18,32,46`. | **Defeito comprovado** | Definir erros de domínio/aplicação e mapeamento HTTP único em controller/middleware. Services nunca respondem HTTP. | Estratégia de erros e testes de API. |
| A02 | `routes.js:52-59` registra `AddressClientService.create/update` como handlers Express, embora suas assinaturas sejam `(addressData, clientId)` e `(id, addressData, clientId)` em `AddressClientService.js:5-45`. | **Defeito comprovado** | Roteamento deve chamar controllers; controller extrai params/body/identidade e chama service. | Decidir URLs públicas/protegidas de endereço. |
| A03 | `OrderAddressControllet.js:10` usa `validator` não importado e o arquivo não é importado em `routes.js`. | **Defeito comprovado** | Decidir se gerenciamento separado de endereço de pedido existe; se sim, reconstruir controller/rota; se não, retirar do baseline novo. | Decisão de negócio sobre edição de endereço do pedido. |
| A04 | Camadas não são consistentes: `BudgetService.js:1,22,101` usa model direto; a maior parte usa repositories. | **Defeito comprovado** | Estabelecer convenção simples: controller → use case/service → repository/model; exceções precisam ser documentadas. | Refatoração pós-baseline. |
| A05 | `meddleawares` é typo em caminhos (`routes.js:16`, `server.js:2`). | **Defeito comprovado** | Renomear no ciclo de organização, com atualização de imports e testes. | Nenhuma; baixo risco. |
| A06 | Não existe runner nem arquivos de teste; `package.json:16` falha por definição. | **Defeito comprovado** | Escolher framework compatível com ESM e adicionar pirâmide de testes antes do cutover. | Decisão técnica de ferramenta, não aprovada nesta etapa. |

### 4.2 Banco, models, associações e integridade

| ID | Achado e evidência | Classificação | Tratamento proposto no rebuild | Dependências |
| --- | --- | --- | --- | --- |
| D01 | `AddressClient` model usa UUID (`AddressClient.js:7-15`) e migration cria INTEGER (`20261026175511-create-addressClient.js:8-20`). | **Defeito comprovado** | Escolher o tipo de `address_client.id` pelo impacto de referências/dados existentes; implementar model e schema novos com o mesmo tipo. | Inventário de IDs e referências externas. |
| D02 | `ProductCategory.belongsTo(Category)` usa `foreignKey: 'id'` (`ProductCategory.js:18-22`), mas FK persistida é `category_section_id` (`20260811000258...:13-19`). | **Defeito comprovado** | Reconstruir a associação com FK correta e alias único/canônico. | Schema de categoria/subcategoria. |
| D03 | Product usa alias `products` para `belongsTo(ProductCategory)` (`Product.js:31-35`), enquanto repository inclui `product_category` (`ProductRepository.js:7-16,34-39`). | **Defeito comprovado** | Definir nomes de associação consistentes e cobri-los por teste de include. | D02. |
| D04 | `Order.hasMany(OrderAddress)` (`Order.js:35-38`) e `order_address.order_id` não é UNIQUE (`20260721185036...:13-22`). O relatório representa 1:1. | **Decisão de negócio pendente** | Não impor 1:1 ou 1:N por inferência. O schema-alvo será definido após decisão de endereço por pedido. | Aprovação humana P01. |
| D05 | FKs de `orders_products.order_id`, `order_address.order_id` e `order.client_id` permitem NULL e usam `SET NULL` (`20251020030455...:13-22`; `20260721185036...:13-22`; `20250908045344...:13-22`). | **Decisão de negócio pendente** | Determinar retenção histórica, anonimização e regra de exclusão para pedidos/clientes antes de escolher `RESTRICT`, snapshot ou nullable. | Aprovação humana P02. |
| D06 | `client.update_number` é consultado (`ClientService.js:227-229`) sem índice explícito na migration. | **Defeito comprovado** | Criar índice no baseline novo se o fluxo de ativação for preservado. Avaliar unicidade/expiração conforme regra aprovada. | Decisão sobre ativação P03. |
| D07 | Busca de produto usa tabela citada como `"Product"` (`ProductRepository.js:80-88`), enquanto model define `product` (`Product.js:23-26`). | **Defeito comprovado** | Evitar nome físico hardcoded em SQL ou garantir nome canônico. Validar com PostgreSQL real. | Teste de integração. |
| D08 | `Budget.client_id` é nullable e `SET NULL` (`Budget.js:12-21`; migration correspondente). | **Decisão de negócio pendente** | Preservar nullable somente se orçamento sem cliente for requisito. Caso contrário, reconciliar antes de tornar obrigatório. | Aprovação humana P04. |
| D09 | O mix de UUID para entidades principais e INTEGER para categoria/subcategoria não quebra as FKs atuais. | **Hipótese de convenção, não defeito** | Não migrar identificadores por uniformidade. Para cada tabela nova, justificar o tipo por geração, integração, cardinalidade e referências. | Inventário e ADR de schema. |

### 4.3 Autenticação, sessão e autorização

| ID | Achado e evidência | Classificação | Tratamento proposto | Dependências |
| --- | --- | --- | --- | --- |
| S01 | Middleware lê `request.cookies.token` e valida JWT (`auth.js:5-18`). | **Estrutura a preservar/corrigir** | Preservar cookie como transporte da sessão, renomeando/configurando de modo centralizado. | Política de cookie. |
| S02 | Sessão de usuário e cliente usam `secure: false` (`SessionsController.js:28-37`; `SessionClientController.js:19-28`); Google usa `NODE_ENV` (`GoogleSessionController.js:46-53`). | **Defeito comprovado** | Uma única factory/configuração de cookie para todos os logins e logout. | Definição de domínios e HTTPS por ambiente. |
| S03 | Não há rota de logout nem `clearCookie` no código. | **Defeito comprovado** | Criar contrato de logout que expira o mesmo cookie (nome, path, domain, sameSite) e limpa estado de sessão conforme política. | Decisão sobre revogação P05. |
| S04 | JWT não é retornado pelos controllers atuais; resposta traz `authenticated` e, no Google, `role`. | **Estrutura a preservar** | Manter token fora do JSON como estratégia principal. Revisar frontend para `credentials: 'include'`. | Contrato com frontend. |
| S05 | CORS usa allowlist fixa localhost e `credentials: true` (`app.js:16-41`). | **Defeito comprovado** | Tornar origins e política de credentials configuráveis/validadas por ambiente; nunca usar `*` com cookies. | URLs reais de frontend. |
| S06 | Role vem do JWT (`auth.js:16-18`), mas autorização é dispersa e incompleta: pedidos só verificam usuário existente (`OrderService.js:114-122`), budget testa existência (`BudgetService.js:8-11,68-76,121-125`). | **Defeito comprovado** | Criar política declarativa por rota/caso de uso e checagem de ownership no service. | Matriz de permissões P06. |
| S07 | `ClientService.resendActivationCode` usa condição sempre verdadeira para role (`admin.role !== 'admin' || admin.role !== 'user'`, linhas 155-160). | **Defeito comprovado** | Corrigir ao implementar a política aprovada; cobrir por testes de admin/user/client. | P06. |
| S08 | `/client/me`, atualização de cliente e rotas de endereço estão antes de `routes.use(authMiddlewares)` (`routes.js:27-60,95`). `ClientController.store` lê `request.userId` e envia `user_id`, mas `client` não tem essa coluna (`ClientController.js:49-67`; migration client). | **Defeito comprovado** | Separar rotas públicas e autenticadas; definir criação de cliente (autoatendimento, admin ou ambos) antes de reconstruir o contrato. | P07. |
| S09 | Google valida ID token no backend, audience e email verificado (`googleAuth.js:5-25`; `GoogleSessionController.js:21-40`). | **Estrutura a preservar/corrigir** | Preservar validação server-side; aplicar a mesma emissão de cookie e política de vínculo de conta ao novo fluxo. | Política de vínculo P08. |

### 4.4 Pedidos, catálogo e estoque

| ID | Achado e evidência | Classificação | Tratamento proposto | Dependências |
| --- | --- | --- | --- | --- |
| O01 | Criação de pedido/OS grava cabeçalho, itens e endereço em transaction (`OrderService.js:10-96`). | **Estrutura a preservar/corrigir** | Preservar atomicidade **dentro do domínio de OS**; reconstruir o contrato de item com snapshots comerciais/operacionais e ciclo de vida próprios, sem tocar saldo de estoque. | Modelo de OS e P01/P11. |
| O02 | Item de pedido contém apenas `product_name`, `quantity`, `unit_price` (`OrdersProducts.js:12-19`; migration) e create não consulta Product (`OrderService.js:23-84`). | **Decisão arquitetural aprovada** | A ausência de `product_id` de estoque não é defeito e deve ser preservada: item/produto da OS não referencia produto do estoque. A reconciliação de itens legados ocorrerá dentro do domínio de OS, preservando snapshots comerciais e operacionais. | Decisão aprovada P09; inventário de dados da OS. |
| O03 | Não há use case/endpoint de entrada, saída, inventário ou histórico de estoque; busca por `StockMovement` só retorna o model. | **Defeito comprovado** | Construir domínio de movimentação independente de OS; impedir mutações diretas de `product.quantity` fora desse caso de uso. Reserva/consumo/reversão automática por OS ficam explicitamente fora do escopo. | P10 e arquitetura EVENTS. |
| O04 | `StockMovements` tem `IN`/`OUT`, mas alias `client` para User (`StockMovements.js:70-73`). | **Defeito comprovado** | Reconstruir nomenclatura e metadados de autoria no novo ledger. Não reaproveitar model sem revisão. | P10. |
| O05 | Atualização de pedido ignora `request.transaction` (`OrderController.js:139`; `OrderService.js:129-145`); atualização de item recebe transação possivelmente indefinida (`OrderProductsController.js:54`). | **Defeito comprovado** | Cada caso de uso mutável da OS abre/recebe transaction de maneira consistente e inclui somente cabeçalho, itens, endereço, total e eventos próprios da OS quando aplicável; não inclui saldo/evento de estoque. | Novo application service do domínio de OS. |
| O06 | `status`/`status_description` são strings livres (`Order.js:17-19`; `OrderController.js:20-25,113-118`). | **Decisão de negócio pendente** | Definir estados permitidos, transições, ator autorizado e eventos próprios da OS. Nenhuma transição de OS baixa, reserva, consome, reverte estoque ou altera status de produto de estoque automaticamente. | P11. |
| O07 | Produto de estoque possui `quantity`, `min_quantity`, `control_level` e categoria (`Product.js:13-21`), porém não existe implementação de alerta/reabastecimento. | **Decisão de negócio pendente** | Preservar `product.quantity` como saldo oficial; definir semântica de `min_quantity`, `control_level`, alertas e reposição somente se aprovada. Isso não cria vínculo com OS. | P10/P12. |

### 4.5 Outbox, broker, consumidores e infraestrutura

| ID | Achado e evidência | Classificação | Tratamento proposto | Dependências |
| --- | --- | --- | --- | --- |
| M01 | Cliente e outbox são gravados na mesma transação (`ClientService.js:27-68,176-222`). | **Estrutura a preservar/corrigir** | Generalizar esse padrão apenas para fatos que **precisam** sair do banco. Para estoque, o saldo e ledger interno são obrigatórios; Outbox é gravado na mesma transaction somente quando existir integração aprovada, nunca como pré-requisito do movimento. | Schema de outbox novo e contrato de integração aprovado. |
| M02 | Worker bloqueia evento, publica com confirm e marca como processado (`OutboxWorker.js:11-40`); busca `pending`, batch 20, `attempts < 10` (`69-79`). | **Estrutura a preservar/corrigir** | Manter publisher confirms e retry, mas definir estados, claim, backoff, eventos esgotados e métricas. Avaliar transação curta/claim para não manter lock de banco durante I/O de broker. | Modelo de entrega. |
| M03 | Consumer possui retry/DLQ, mas não persiste deduplicação por `eventId` antes do e-mail (`ClientCreatedConsumer.js:48-55,112-123`). | **Defeito comprovado** | Implementar tabela de mensagens processadas (consumer + event_id com índice/unique) ou mecanismo equivalente transacional. | Schema novo e regra de retries. |
| M04 | `OutboxEvent` usa payload JSONB, status, attempts, erro e processed_at (`OutboxEvent.js:7-57`); migration tem índice `(status, created_at)`. | **Estrutura a preservar/corrigir** | Preservar os conceitos; formalizar versão de evento, `occurred_at`, chave de idempotência e estados. | Contrato de evento. |
| M05 | Compose tem serviços e healthchecks de infraestrutura, mas não healthcheck de API/worker/consumer (`docker-compose.yml:1-239`). | **Defeito comprovado** | Criar health/readiness no ciclo de operacionalização; critérios dependem de dependências críticas de cada processo. | Observabilidade P13. |
| M06 | Compose usa credenciais MinIO padrão em texto (`docker-compose.yml:165-168`) e Dockerfile usa Node 23.5.0 (`docker/dockerfile:2`). | **Defeito comprovado** | Tratar segredos/dev defaults e imagem suportada em hardening de ambiente; não misturar com a reconstrução funcional do banco. | Política de deploy. |

## 5. Estruturas: preservar, corrigir, reconstruir, remover ou adiar

| Estrutura / capacidade | Destino | Justificativa e condição |
| --- | --- | --- |
| PostgreSQL | **Preservar e reconstruir schema** | Fonte oficial aprovada para dados e estoque. O conteúdo atual exige inventário antes de carga. |
| RabbitMQ | **Preservar e corrigir** | Já há topologia, confirm publisher, retry e DLQ; faltam idempotência e contrato formal de entrega. |
| Outbox | **Preservar e reconstruir contrato** | Padrão já existe e é compatível com a decisão EVENTS; schema/worker devem ser endurecidos. |
| Redis rate limit | **Preservar, validar operacionalmente** | Está integrado; política de fallback e disponibilidade precisam ser definidas/testadas. |
| MinIO e `StorageService` | **Preservar, corrigir ciclo de vida** | Budget usa objeto no MinIO. Decidir retenção/remoção de objeto ao excluir budget e configuração por ambiente. |
| Models/migrations atuais | **Reconstruir no baseline novo; preservar como referência histórica** | Há divergências de tipo, FKs, aliases, nullable e contratos. Não editar as migrations existentes. |
| `StockMovements` atual | **Reconstruir** | Não é usado operacionalmente e não cumpre ainda o modelo EVENTS aprovado. |
| Produtos do catálogo de estoque (`product` atual) / categoria / subcategoria | **Corrigir e preservar conceito** | Entidades pertencem exclusivamente ao domínio de estoque. `product.quantity` será o saldo oficial; associações e busca precisam de schema/aliases consistentes. Tipos de ID só mudam se justificados. A nomenclatura física do baseline deve evitar ambiguidade com produtos da OS, sem renomear nada nesta atividade. |
| Produtos e itens de ordem de serviço (`orders_products` atual) | **Reconstruir contrato e preservar independência** | Pertencem exclusivamente ao domínio de OS, com snapshots comerciais/operacionais, status e histórico próprios conforme regra aprovada. Não recebem FK, association Sequelize ou dependência estrutural de produto do estoque. |
| Ordem de serviço, itens e endereço | **Reconstruir contrato** | É necessário definir cardinalidade de endereço e ciclo de vida da OS antes de schema definitivo. A transação da OS não atualiza saldo de estoque. |
| `AddressClientController` e `OrderAddressControllet` | **Corrigir ou remover do baseline** | Hoje não compõem superfície HTTP válida. Decidir rotas suportadas e compatibilidade antes de remoção física. |
| Cookie JWT | **Preservar e consolidar** | É decisão aprovada e já é parcialmente implementado. |
| MongoDB/projeções de leitura | **Adiar** | Não há dependência nem requisito aprovado. Se adotado, não terá autoridade sobre saldo. |
| CQRS amplo, Event Sourcing integral, Kafka, microserviços | **Adiar** | Não são necessários para cumprir decisões atuais; avaliar por volume/SLA/requisitos futuros. |

## 6. Arquitetura-alvo proposta

### 6.1 Camadas e fluxo de requisição

```text
HTTP route
  -> autenticação de cookie / autorização declarativa
  -> controller (contrato HTTP, validação, serialização)
  -> application service / use case (regra e fronteira transacional)
  -> repositories (queries e persistência)
  -> PostgreSQL (fonte oficial)
       ├─ tabelas operacionais
       ├─ domínio de OS: ordem, produtos/itens, endereço e eventos próprios
       ├─ domínio de estoque: catálogo, `product.quantity` (saldo oficial) e ledger interno imutável
       ├─ outbox_events
       └─ processed_messages (idempotência de consumidores)

Outbox worker -> RabbitMQ (publisher confirm) -> consumer idempotente -> e-mail/projeção/integração

Domínio de OS e domínio de estoque não possuem seta de dependência obrigatória. O ledger de estoque existe e mantém saldo consistente sem consumidor externo; o Outbox somente publica eventos de integração quando houver necessidade real aprovada.
```

Regras de fronteira:

- Controllers não acessam models diretamente, exceto serialização deliberada e documentada; não conhecem transaction.
- Services/use cases não usam `request` ou `response`; devolvem resultado ou erro de domínio/aplicação.
- Uma operação de negócio que altera várias entidades inicia a transaction no use case.
- Repositories recebem transaction explicitamente quando participam dela.
- Middleware traduz autenticação; uma política de autorização decide papel/ownership; handler de erro mapeia erros para HTTP.

### 6.2 Modelo de dados-alvo — princípios, não DDL final

O novo baseline deve conter tabelas para usuário interno, cliente, endereço de cliente, catálogo e produtos de estoque, ordem de serviço, produtos/itens de OS, endereço/snapshot de entrega **conforme decisões pendentes**, orçamento, ledger de estoque, outbox e deduplicação de mensagens. A nomenclatura física deve diferenciar produtos de estoque de produtos/itens de OS para evitar ambiguidade.

Regras mínimas de integridade a materializar em migrations novas:

- PK, FK, nullability e `ON DELETE` definidos a partir de regras aprovadas; não de defaults do ORM.
- E-mails e códigos externos com unicidade/índice conforme a semântica aprovada; considerar normalização de case antes de impor unicidade.
- Índices nas FKs consultadas e nos filtros operacionais: ativação, cliente de pedido, produto de evento, status/ordenação do outbox e deduplicação de consumer.
- Checks para quantidades e valores monetários não negativos quando compatíveis com a regra de negócio, e descrição não vazia em toda movimentação operacional de estoque.
- Valores monetários em decimal fixo no banco e cálculo sem ponto flutuante na aplicação.
- A relação Category → ProductCategory → Product de estoque mantém tipos compatíveis em cada FK. Não é obrigatório que todas as entidades usem o mesmo tipo de ID.
- Não haverá FK, association Sequelize, constraint de dependência ou gatilho automático entre produtos/itens da OS e produtos de estoque.

### 6.3 Contrato de erro e observabilidade

- Catálogo de erros: validação, não autenticado, não autorizado, não encontrado, conflito, regra de negócio e falha de infraestrutura.
- Correlação de requisição/evento para logs, sem expor token, senha, código de ativação ou payload sensível.
- Métricas mínimas: backlog/idade do outbox, tentativas esgotadas, tamanho da DLQ, eventos duplicados suprimidos, saldo negativo bloqueado, falhas de autenticação e health/readiness.

## 7. Plano de rebuild do banco

### 7.1 Estratégia: rebuild controlado, não destrutivo

O projeto não está em produção neste momento. Portanto, o caminho padrão é um **rebuild de desenvolvimento em ambiente isolado**, que pode recriar o ambiente sem conservar dados operacionais quando não houver dados aprovados para preservação. Se existirem dados que precisem ser mantidos, aplicam-se inventário, snapshot, reconciliação e carga idempotente antes de qualquer descarte. Um cutover de produção só será planejado se o sistema entrar em produção antes da conclusão do saneamento; sua estratégia dependerá do ambiente real naquele momento.

O rebuild não começa descartando banco ou dados existentes. O processo proposto é:

1. **Congelar o desenho, não os dados:** definir schema-alvo, regras de transformação e critérios de aceite antes de reconstruir ambiente ou, se aplicável, de qualquer cutover futuro.
2. **Inventariar fonte atual em modo leitura:** versão das migrations aplicadas, contagem por tabela, colunas/tipos reais, constraints/índices reais, sequências, tamanho, timestamps mínimo/máximo e referências órfãs.
3. **Criar snapshot recuperável:** backup lógico/artefato cifrado, checksum e metadados de data/hora/ambiente. A retenção e o acesso ao backup exigem responsável definido.
4. **Executar qualidade e reconciliação:** produzir relatório de duplicidades, nulos proibidos no alvo, FKs órfãs, IDs incompatíveis, valores de status fora do catálogo, totais divergentes e objetos MinIO referenciados/inexistentes.
5. **Construir banco-alvo isolado:** aplicar somente migrations novas do baseline aprovado, sem editar migrations existentes e sem reutilizar o banco atual como ambiente de teste destrutivo.
6. **Carregar dados transformados de modo idempotente:** staging → validação → tabelas-alvo, com tabela/arquivo de mapeamento de IDs quando necessário.
7. **Comparar origem e destino:** contagens, checksums por conjunto lógico, totais monetários, amostragem de relações, relatório de rejeições e decisões tomadas.
8. **Ensaiar reconstrução e migração, quando aplicável:** executar restore + carga + smoke tests em ambiente isolado; medir duração e validar rollback. Para desenvolvimento sem dados a preservar, validar criação limpa do baseline e smoke tests sem introduzir processo de migração desnecessário.
9. **Escolher a estratégia de transição conforme o ambiente real:** se ainda não houver produção, recriar o ambiente de desenvolvimento a partir do baseline aprovado. Se houver produção ou dados operacionais a preservar, aprovar plano de cutover com pausa de escrita, snapshot final, delta se necessário, troca e monitoramento.
10. **Retenção do legado quando houver dados preservados:** manter backup e/ou instância legada somente-leitura durante período aprovado; exclusão exige aprovação posterior explícita.

### 7.2 Dados que exigem reconciliação antes de carga

| Conjunto | Risco conhecido | Reconciliação necessária | Não decidir automaticamente |
| --- | --- | --- | --- |
| `address_client` | PK INTEGER na migration e UUID no model. | Mapear todos os IDs e consumidores/referências; escolher ID alvo e gerar mapa legado→novo se houver troca. | Converter tipo ou descartar endereços. |
| Clientes | E-mail/nome únicos, ativação, Google ID e status; rota atual envia `user_id` inexistente. | Detectar e-mails duplicados por normalização, Google IDs duplicados, contas sem status, códigos expirados e senhas ausentes. | Mesclar clientes por semelhança de nome. |
| Usuários | `status_users`, role e `update_number` existem, com fluxos frágeis. | Validar roles, hashes, e-mails, contas inativas e propriedade administrativa inicial. | Elevar papel de usuário sem decisão de responsável. |
| Ordens de serviço e itens | Itens têm nome, quantidade e preço, sem `product_id` de estoque; endereço pode ser múltiplo; `client_id` pode ser nulo. | Recalcular total a partir dos itens, preservar snapshots comerciais/operacionais, contar endereços por OS e registrar OS órfãs. | Associar item/produto da OS a produto de estoque por nome, código ou aproximação; a independência entre domínios é decisão aprovada. |
| Produtos e categorias de estoque | Associações ORM quebradas, mas FKs físicas usam INTEGER nas categorias. | Validar categoria/subcategoria existentes, códigos duplicados, quantity/min_quantity inválidos e produtos sem categoria. | Alterar tipo de identificador apenas para uniformidade. |
| Estoque | `product.quantity` atual não possui histórico operacional confiável. | Tratar saldo atual como saldo de abertura candidato; realizar contagem física ou aprovação formal da fonte; criar eventos de abertura com descrição e responsável rastreáveis somente após reconciliação. | Inferir eventos históricos IN/OUT a partir do saldo final ou associar o saldo a uma OS/cliente automaticamente. |
| Orçamentos/MinIO | Budget aponta `pdf_object_name`, mas consistência objeto↔registro não foi executada. | Listar referências e objetos, classificar órfãos de banco e de bucket, preservar inventário. | Apagar objetos órfãos automaticamente. |
| Outbox/RabbitMQ | Eventos pendentes, processados e mensagens podem ter sido publicados/consumidos parcialmente. | Exportar estado, definir se pendentes serão reprocessados, descartados com justificativa ou migrados; impedir duplicação por idempotência no alvo. | Reexecutar e-mails sem aprovação. |

### 7.3 Baseline de migrations novo

O baseline deve ser criado em diretório/linha de migração claramente identificável e conter, em ordem:

1. extensões/tipos necessários e convenções de timestamp;
2. identidades e clientes;
3. endereço de cliente;
4. categoria, subcategoria e produto;
5. ordem de serviço, produtos/itens e endereço/snapshot após decisão de cardinalidade;
6. ledger interno de estoque, idempotência de comandos e atualização do saldo oficial em `product.quantity`;
7. orçamento e referências a armazenamento;
8. outbox e deduplicação de mensagens;
9. constraints, índices e dados mínimos somente se aprovados;
10. scripts de validação/carga separados das migrations de schema.

As migrations existentes não serão editadas, apagadas ou executadas contra o banco-alvo sem uma estratégia de baseline aprovada. A ferramenta e o mecanismo preciso de baseline devem ser validados em ambiente isolado antes do uso em qualquer ambiente com dados.

## 8. Plano de autenticação e autorização

### 8.1 Contrato de sessão por cookie

O contrato-alvo deve ter os seguintes elementos:

- Um único nome de cookie de sessão, configurado em módulo único.
- `HttpOnly: true` em todos os fluxos de login.
- `Secure: false` **somente** em desenvolvimento HTTP local; `Secure: true` em produção HTTPS. A seleção deve vir de configuração validada, não de comentários dispersos.
- `SameSite` definido pelo fluxo de frontend: `lax` para mesmo site/navegação compatível; `none` apenas se frontend/API forem cross-site e junto de `Secure: true`. A escolha depende dos domínios reais e requer aprovação.
- `path`, `domain`, `maxAge`/expiração e limpeza no logout coerentes entre set e clear.
- Resposta de login sem token no corpo; somente metadados mínimos da sessão/identidade autorizados pelo contrato.
- Frontend com `credentials: 'include'`; CORS permite somente origins configuradas e específicas.
- Requisições que alteram estado (`POST`, `PUT`, `PATCH` e `DELETE`) devem usar estratégia de proteção contra CSRF definida no contrato de implementação; a escolha não impõe biblioteca ou mecanismo específico nesta etapa.
- O backend valida o cabeçalho `Origin` de requisições de alteração de estado conforme a política de domínios autorizados. CORS, isoladamente, não é proteção contra CSRF.
- Se o fluxo exigir cookie com `SameSite=None`, a estratégia deve incluir proteção CSRF explícita, como token CSRF ou mecanismo equivalente aprovado no planejamento de implementação.

### 8.2 Fluxos a reconstruir e validar

| Fluxo | Estado atual | Meta de saneamento | Critério específico |
| --- | --- | --- | --- |
| Login de usuário interno | Cookie existe, `secure: false`. | Usar factory comum, validar credenciais, emitir cookie e retornar perfil permitido. | Token não aparece no JSON; cookie tem flags esperadas por ambiente. |
| Login de cliente | Mesmo problema de configuração. | Mesmo contrato de sessão e erros neutros. | Cliente ativo autentica; inativo/bloqueado não autentica. |
| Google OAuth | ID token é validado no backend e cookie usa configuração diferente. | Preservar validação server-side e unificar cookie/conta vinculada. | Audience e email_verified são exigidos; vínculo conflitante é recusado. |
| Logout | Ausente. | Expirar cookie com atributos idênticos e definir revogação. | Requisição posterior não autentica. |
| Check-auth/me | Mistura de modelos e rota pública de cliente. | Requer cookie válido; retorna somente identidade atual e permissões necessárias. | Sem cookie/expirado retorna 401; sem exposição de hash/código. |
| Ativação/reenvio | Role e branches atuais estão quebrados. | Definir responsabilidade, expiração, tentativas, reuso e auditoria conforme regra aprovada. | Só papel autorizado opera; códigos expirados/usados falham de modo consistente. |
| Proteção CSRF | Não há contrato unificado de proteção para sessão por cookie. | Validar `Origin` nas mutações e aplicar estratégia CSRF definida durante o planejamento de implementação; exigir proteção explícita se `SameSite=None`. | Mutações originadas de domínio não autorizado são rejeitadas; CORS não é tratado como controle CSRF suficiente. |

### 8.3 Autorização: matriz a aprovar antes da implementação

Não é seguro inferir todos os papéis a partir dos nomes atuais. Deve ser aprovada uma matriz com, pelo menos:

- quem cria/edita/bloqueia cliente;
- quem visualiza todos os clientes;
- quem cria/edita/exclui usuários internos;
- quem cria/edita/exclui orçamento e lê orçamento de cliente;
- quem cria, acompanha, libera, reatribui e cancela OS;
- quais permissões o papel atual `user` possui como colaborador: assumir OS disponível, consultar suas OS atribuídas e atualizar produtos/itens da OS; o significado atual de `user` não deve ser presumido nem substituído por novo papel sem aprovação;
- quem pode atualizar produto/item da OS quando não é o colaborador atribuído; a exceção administrativa deve ser explícita;
- quem registra movimentos de estoque e autoriza saída restrita;
- quais ações pertencem a `admin`, `user` e `client`.

O alvo separa **autenticação** (identidade válida) de **autorização** (papel, ownership, estado do recurso). A verificação de ownership permanece no caso de uso, mesmo quando há middleware de papel. Para OS, o backend deve validar em toda operação se o colaborador tem atribuição válida para a OS ou se possui permissão administrativa; frontend não determina livremente responsável pela OS nem responsável por uma atualização.

## 9. Plano do domínio de pedidos

### 9.1 Regras arquiteturais obrigatórias

- Criar/alterar/cancelar pedido deve ser um use case transacional.
- Total é calculado no backend a partir de itens validados; o cliente não é autoridade para o total.
- O produto/item da OS deve preservar atributos históricos comerciais e operacionais necessários (por exemplo, nome, descrição, quantidade, preço, status e histórico do momento da OS), sem referência obrigatória a produto do estoque.
- Todo caminho que altere item, total ou status da OS deve ter regras explícitas para consistência e auditoria **dentro do domínio de OS**. A transação da OS não atualiza saldo nem ledger de estoque.
- A constraint única de número de pedido permanece a proteção contra concorrência; erro de conflito deve virar resposta de domínio adequada.

### 9.2 Atribuição e responsabilidade operacional da OS

O fluxo operacional aprovado para a OS é:

1. O administrador cria a OS.
2. A OS fica disponível para um colaborador assumi-la.
3. Um colaborador assume a responsabilidade pela **OS inteira**, e não por produtos/itens individuais.
4. A atribuição persiste como dado de domínio mesmo depois de o colaborador encerrar a sessão; sessão é apenas o meio de autenticar a ação atual.
5. O colaborador consulta suas OS atribuídas e, usando sua própria sessão autenticada, atualiza os estados dos produtos/itens da OS conforme as permissões e transições aprovadas.
6. Cada atualização registra a identidade autenticada do colaborador responsável pela ação no histórico da OS.
7. O administrador acompanha o andamento e pode liberar ou reatribuir uma OS.
8. Toda reatribuição gera histórico com responsável anterior, novo responsável, autor autenticado da alteração, data/hora e motivo.

Regras arquiteturais:

- A atribuição, o histórico de trabalho e os estados de produtos/itens pertencem exclusivamente ao domínio de OS.
- A autorização é validada no backend em cada operação. Atualizar produto/item da OS exige atribuição válida do colaborador ou permissão administrativa definida na matriz P06.
- O frontend não informa livremente quem assumiu a OS, quem executou atualização ou quem realizou reatribuição; essas identidades vêm da sessão autenticada. O identificador do colaborador escolhido em uma reatribuição é aceito somente de ator com permissão administrativa e deve ser validado no backend.
- Assumir, liberar ou reatribuir OS não cria FK, association Sequelize ou dependência com produtos de estoque.
- Atualizações de status da OS ou de seus produtos/itens não criam movimento de estoque nem alteram `product.quantity`.

### 9.3 Pontos de decisão antes do schema final

| Pergunta | Por que bloqueia desenho | Opções a aprovar |
| --- | --- | --- |
| Um pedido pode ter mais de um endereço? | Código permite 1:N; diagrama do relatório sugere 1:1. | Um snapshot de entrega por pedido; múltiplos endereços; endereço referenciado por cliente com snapshot. |
| Quais atributos e eventos próprios o produto/item da OS deve preservar? | Determina schema, snapshots, histórico e contrato de atualização da OS. | Definir nome, descrição, quantidade, informações comerciais/operacionais, status e eventos necessários. |
| Quais transições de status existem na OS? | Determina validação, autorização e eventos do próprio domínio. | Definir catálogo e transições, sem efeitos automáticos no estoque. |
| Quais estados de atribuição existem para a OS e quais ações os alteram? | Determina disponibilidade, concorrência ao assumir, liberação, reatribuição e histórico operacional. | Definir estados, regra de uma atribuição ativa, motivo obrigatório de reatribuição/liberação e permissões correspondentes. |
| Cliente pode ser removido com pedidos? | Impacta FK, retenção e privacidade. | Restrição, anonimização, snapshot, soft delete ou regra aprovada. |
| Qual actor pode criar/editar OS, assumir, liberar, reatribuir e atualizar itens? | Rotas atuais não distinguem adequadamente e o significado de `user` é ambíguo. | Matriz P06 aprovada sem criar novo papel automaticamente. |

### 9.4 Migração/reconciliação de pedidos legados

- Importar cabeçalho, produtos/itens e endereços de OS mantendo IDs legados quando possível e justificável.
- Recalcular e comparar total do cabeçalho com a soma dos itens; divergências entram em relatório de exceções, não são “corrigidas” silenciosamente.
- Não ligar um item/produto legado da OS a `product.id` de estoque, por igualdade de nome, código ou qualquer aproximação: os domínios são independentes por decisão aprovada.
- Não derivar movimentação histórica de estoque a partir de ordens de serviço antigas; o estoque é reconciliado independentemente.
- Inventariar atribuições/responsáveis legados, se existirem, sem inferir responsável a partir de sessão, texto livre ou atividade indireta; ausência de evidência entra como exceção de reconciliação.

## 10. Plano do histórico de estoque baseado em eventos

### 10.1 Invariantes aprovadas

Esta arquitetura **não** aprova Event Sourcing integral da aplicação. Ela usa um ledger imutável de estoque associado a saldo operacional materializado em `product.quantity`: o saldo atual continua oficial e o ledger permite auditoria das movimentações.

**O que está aprovado:**

1. PostgreSQL é fonte oficial do saldo e do histórico.
2. Um evento de estoque é imutável depois de gravado.
3. `product.quantity` é o saldo oficial do estoque; não será criada segunda fonte canônica de saldo.
4. Atualização de `product.quantity` e gravação do evento interno do ledger ocorrem na mesma transação PostgreSQL.
5. Toda movimentação operacional exige descrição livre obrigatória, preservada no evento; a descrição explica o motivo, não cria chave nem relacionamento automático com cliente ou OS.
6. O responsável é a identidade autenticada do colaborador; o frontend não é fonte confiável de nome ou identificador de responsável.
7. Eventos de integração podem ser gravados no Outbox na mesma transação **quando houver necessidade real aprovada**, mas RabbitMQ indisponível não impede o commit consistente de saldo e ledger.
8. Consumidores podem receber a mesma mensagem mais de uma vez e precisam deduplicar.
9. MongoDB, se existir no futuro, só recebe projeções reconstruíveis.
10. Produtos da OS e produtos do estoque não possuem relacionamento obrigatório; movimentação de estoque não altera OS, e status de OS não altera estoque.

**O que não está aprovado nem faz parte do escopo:**

- Event Sourcing integral da aplicação;
- reconstrução obrigatória do saldo reproduzindo todos os eventos;
- substituição de `product.quantity` por projeção derivada do ledger;
- CQRS completo.

### 10.2 Modelo lógico sugerido, sujeito a catálogo de motivos aprovado

| Estrutura | Responsabilidade | Regras mínimas |
| --- | --- | --- |
| `product` de estoque (nome físico final a definir no baseline) | Identidade/catálogo e saldo oficial em `quantity`. | `quantity` é atualizado exclusivamente pelo use case de movimentação, com lock/controle de concorrência; não há tabela concorrente de saldo canônico. |
| `stock_events` | Ledger interno append-only, independente de consumers externos. | Identificador, produto do estoque, tipo de movimentação, quantidade positiva, **descrição obrigatória**, identidade autenticada do responsável, data/hora, saldo resultante, chave de idempotência de comando e correlação quando aplicáveis. Não contém update/delete de correção nem FK obrigatória para OS/cliente. |
| Idempotência de comando de movimentação | Protege a entrada contra reenvio por timeout, falha de rede ou repetição do frontend. | A chave é persistida no movimento ou estrutura equivalente, com restrição `UNIQUE` PostgreSQL no escopo a definir, **na mesma transação** da atualização de saldo e criação do evento. A implementação trata violação de unicidade, inclusive por duas requisições concorrentes: mesma chave + mesmo conteúdo recupera o resultado original, sem novo evento nem nova alteração de saldo; mesma chave + conteúdo diferente produz conflito. Não basta consulta prévia da chave, pois requisições simultâneas podem ambas não encontrá-la antes da persistência. Formato, escopo, retenção e contrato HTTP ficam para a fase de contrato-alvo. |
| `outbox_events` | Eventos de integração opcionais, comprometidos junto ao saldo/ledger somente quando a integração for necessária. | Evento versionado, agregado, payload, status de entrega, tentativas e timestamps. Não é pré-requisito para registrar movimento interno. |
| `processed_messages` | Idempotência de mensagens de integração no consumer. | Chave única composta por consumidor e `event_id`; protege efeitos da entrega RabbitMQ e é distinta da idempotência do comando de movimentação. Para efeito local, gravação ocorre na mesma transação do efeito. |

O catálogo atual contém `IN`/`OUT` (`StockMovements.js:21-24`). Tipos adicionais, como ajuste, inventário ou saída restrita, **não serão introduzidos como requisito** sem aprovação P10. Reserva, consumo e reversão automáticos vinculados a OS estão fora do escopo aprovado. Se uma correção de saldo for necessária, o princípio já aprovado exige novo evento; o tipo/motivo exato precisa ser decidido. A descrição livre obrigatória não substitui o tipo do evento.

### 10.3 Fluxo-alvo de movimento

1. Controller valida o comando, incluindo descrição obrigatória e chave de idempotência quando o contrato a exigir, e obtém a identidade autenticada/autorizada do colaborador.
2. Use case prepara a representação do conteúdo que será comparada para idempotência no escopo definido; uma consulta prévia pode otimizar recuperação, mas não é a garantia de concorrência.
3. Na **mesma transação PostgreSQL**, persiste a chave/resultado de idempotência sob restrição `UNIQUE`, carrega o produto de estoque e seu saldo oficial em `product.quantity` sob controle de concorrência, valida a regra de negócio aprovada e grava o evento imutável junto da atualização do saldo.
4. Se a persistência encontrar chave existente, a implementação trata o conflito de unicidade e recupera o registro persistido: mesmo conteúdo retorna o resultado original; conteúdo diferente retorna conflito e não gera movimentação adicional. Isso se aplica também a duas requisições concorrentes com a mesma chave.
5. Quando houver integração aprovada, a mesma transação também grava evento de integração no Outbox. Se RabbitMQ estiver indisponível depois do commit, o worker tentará publicar posteriormente; o ledger e saldo já permanecem válidos.
6. Worker publica apenas eventos de integração do Outbox; consumer aplica deduplicação por `consumer + event_id` antes de produzir efeito local, externo ou projeção.

### 10.4 Saldo inicial no rebuild

O campo atual `product.quantity` é o saldo oficial do estoque, mas é apenas um candidato a saldo de abertura no rebuild porque não há movimento operacional histórico confiável no código. Antes da carga:

- executar inventário físico ou aprovar formalmente a fonte de saldo;
- registrar origem, data/hora, responsável e diferenças;
- gerar um evento de abertura por produto somente depois dessa aprovação, com descrição obrigatória e responsável/origem rastreáveis;
- não fabricar sequência retroativa de eventos `IN`/`OUT` sem evidência nem associar abertura a cliente/OS automaticamente.

## 11. Plano de mensageria e Outbox

### 11.1 Garantia proposta

A garantia deve ser documentada como **at-least-once** entre Outbox e consumer. “Exactly once” não deve ser alegado. Efeitos observáveis devem ser idempotentes por `event_id` e identificador do consumidor. Essa garantia se aplica a eventos de integração; não condiciona o registro interno de saldo e ledger de estoque.

### 11.2 Contrato-alvo

- O ledger interno de estoque é gravado diretamente no PostgreSQL e existe independentemente do Outbox, RabbitMQ ou consumidores externos.
- Evento de integração no Outbox, quando necessário, tem `event_id` estável, `event_type`, versão, `aggregate_type`, `aggregate_id`, `occurred_at`, correlation/causation quando aplicável e payload compatível.
- Falha ou indisponibilidade de RabbitMQ não faz rollback de movimentação já comprometida: o worker recupera a publicação a partir do Outbox.
- Publisher usa confirmação do broker antes de marcar entrega concluída.
- Worker seleciona eventos de maneira concorrente segura, limita tentativas, calcula retry/backoff e expõe estado esgotado para operação.
- DLQ não é descarte: mensagens nela possuem procedimento documentado de inspeção, decisão e replay controlado.
- Para **efeitos locais transacionais** no PostgreSQL, o consumer registra `consumer + event_id` no mesmo contexto transacional do efeito, impedindo duplicação local.
- Para **efeitos externos** — como e-mail por provedor — não se promete exactly-once: existe uma janela de falha possível entre chamar o provedor e registrar/confirmar localmente o resultado. Deve-se priorizar chave de idempotência oferecida pelo provedor, quando suportada.
- Quando o provedor não oferecer idempotência, o contrato do consumer deve distinguir tentativa, confirmação, falha e resultado desconhecido conforme a capacidade observável do provedor; deve prever tentativas, recuperação e reconciliação operacional explícitas.
- Mensagens antigas não são reexecutadas automaticamente quando houver risco de duplicar e-mails ou outro efeito externo: replay exige inventário, reconciliação e aprovação.
- Eventos de cliente existentes são preservados somente se seus contratos e reprocessamento forem reconciliados; eventos de integração de estoque só entram depois do ledger transacional estar pronto e quando uma integração real for aprovada.

### 11.3 Ordem segura de evolução

1. Definir contratos/versionamento e tabela de deduplicação.
2. Implementar e testar consumer idempotente para evento de cliente.
3. Reconciliar backlog do outbox/DLQ legado e decidir replay.
4. Ajustar worker/outbox para estados e métricas acordados.
5. Só então emitir **eventos de integração** de estoque a partir do novo caso de uso transacional, quando houver necessidade real aprovada. O ledger interno já é obrigatório e não depende dessa publicação.

## 12. Estratégia de testes

### 12.1 Pirâmide mínima

| Nível | Escopo | Casos obrigatórios antes de cutover |
| --- | --- | --- |
| Unitário | Validação, cálculo de total da OS, transição de status da OS, atribuição/reatribuição, política de saldo, descrição obrigatória, identidade do responsável, autorização e factory de cookie. | Quantidade/preço inválido; conflito; cookie por ambiente; ownership; roles; descrição ausente; responsável vindo exclusivamente da sessão; colaborador não atribuído impedido de atualizar item; reatribuição exige motivo/histórico. |
| Integração PostgreSQL | Migrations baseline, FKs, constraints, associações ORM, índices e transações. | Schema sobe do zero; AddressClient consistente; associações de catálogo de estoque; rollback de OS; atribuição persiste após logout; histórico de reatribuição preserva anterior/novo/autor/data/motivo; `product.quantity`+ledger atômicos; duas requisições concorrentes com mesma chave/conteúdo retornam o resultado original e produzem somente uma movimentação/saldo; mesma chave com conteúdo diferente produz conflito; movimentação não altera produto/item da OS. |
| Integração RabbitMQ | Publisher confirm, retry, DLQ, reprocessamento e idempotência de eventos de integração. | Mesma mensagem duas vezes gera um único efeito local por `consumer + event_id`; falha/retry não perde mensagem; indisponibilidade do broker não invalida movimento de estoque já comprometido; efeitos externos seguem política de resultado confirmado/falha/desconhecido. |
| API/contrato | Login/logout/check-auth, CSRF/Origin, CORS com cookie, autorização, clientes, OS, produtos da OS e estoque. | Token não aparece no JSON; cookie válido autentica; origem não permitida é bloqueada; mutação de origem não autorizada é rejeitada pela proteção CSRF/validação de `Origin`; CORS não é considerado controle CSRF suficiente; papéis/ownership corretos; colaborador consulta somente OS atribuídas salvo permissão administrativa; status da OS não altera estoque. |
| Rebuild/reconciliação | Snapshot, carga idempotente, contagens e exceções. | Carga executada duas vezes sem duplicar; relatórios de divergência reconciliam com origem. |
| E2E/smoke de ambiente | API + worker + consumer + PostgreSQL + RabbitMQ + Redis + MinIO. | Health/readiness, criação de evento, publicação e efeito controlado. |

### 12.2 Critério de qualidade de mudança

Nenhuma etapa de reconstrução ou eventual cutover deve depender apenas de `node --check`. Cada modificação futura deve ter teste no nível apropriado; bugs atuais de integração ORM, schema e broker exigem testes reais contra PostgreSQL/RabbitMQ, não mocks exclusivamente. Os testes devem provar a independência bidirecional: movimentar estoque não altera produto/status da OS, e alterar status de produto/OS não altera `product.quantity` nem cria evento de estoque. Devem também separar a idempotência do comando de movimentação da deduplicação de mensagens do consumer, incluindo a corrida de duas requisições concorrentes com a mesma chave, e validar proteção CSRF em mutações com origem não autorizada.

## 13. Ordem de execução e dependências

| Fase | Objetivo | Pré-requisitos | Saídas verificáveis |
| --- | --- | --- | --- |
| 0. Governança e decisões | Aprovar regras pendentes, proprietário de dados, janela e rollback. | Nenhum. | ADRs/matriz de permissão/catálogos aprovados. |
| 1. Inventário não destrutivo | Conhecer schema e dados atuais, gerar backup e relatório de qualidade. | Acesso read-only e responsável por dados. | Snapshot com checksum; contagens; exceções; mapa de reconciliação. |
| 2. Contrato-alvo | Fechar schema lógico, API, autorização, cookies, proteção CSRF, atribuição de OS, idempotência de comandos e eventos de integração. | Fase 0 e resultados relevantes da fase 1. | Especificações, matriz de permissões, política de `Origin`/CSRF, catálogo de status/movimentos, contrato de atribuição e escopo técnico de chave de idempotência. |
| 3. Baseline PostgreSQL | Criar migrations novas, constraints, índices, models e repositories. | Fase 2; P01/P02/P03/P04/P10/P11 quando pertinentes. | Banco limpo sobe; integridade, restrição `UNIQUE` de idempotência e transações testadas. |
| 4. Auth e borda HTTP | Consolidar cookie, proteção CSRF, CORS, logout, erro e rotas/controllers. | Fase 2; frontend alinhado. | Testes de contrato de sessão/autorização e mutações de origem não autorizada passam. |
| 5. Catálogo e OS | Reconstruir produtos/categorias de estoque e, separadamente, OS/produtos-itens/endereço, atribuição, histórico operacional e transações do domínio de OS. | Fases 2-4; P01/P06/P11 decididos para OS. | OS consistente; total, atribuição persistente, histórico próprio e permissões cobertos por teste; nenhum efeito automático no estoque. |
| 6. Estoque EVENTS | Implementar movimentação independente de OS, `product.quantity` como saldo oficial, ledger interno e idempotência de comando; Outbox somente para integrações aprovadas. | Fases 2-4; P10 decidido; escopo técnico da chave definido na fase 2. | Saldo e evento interno atômicos; descrição obrigatória; responsável da sessão; repetição de comando não duplica movimento; sem saldo negativo quando essa regra for aprovada. |
| 7. Outbox/consumers | Idempotência de mensagens, retry/DLQ, efeitos externos, operação e métricas. | Fase 3 e contratos da fase 2. | `consumer + event_id` não duplica efeito local; replay controlado; política de resultado externo desconhecido documentada. |
| 8. Carga e ensaio, se houver dados a preservar | Carregar ambiente isolado e repetir até reconciliação aprovada. | Fases 1, 3, 5, 6, 7; aplica-se somente se inventário indicar preservação/migração de dados. | Relatório origem/destino aprovado; rollback ensaiado. |
| 9. Transição de ambiente | Em desenvolvimento sem dados a preservar, reconstruir ambiente a partir do baseline; em produção futura ou com dados operacionais, executar cutover aprovado. | Aceite de todas as fases aplicáveis e estratégia definida pelo ambiente real. | Ambiente-alvo estável e monitorado; quando aplicável, rollback disponível. |
| 10. Pós-transição, quando aplicável | Retenção de legado, correção de exceções e retrospectiva. | Transição com dados preservados concluída. | Backlog de exceções, decisão de descarte posterior e documentação final. |

Dependências críticas:

- Fase 6 **não depende** de P09 nem P11: estoque é domínio independente de OS. Depende apenas de P10 e dos contratos técnicos de autenticação/autorização aplicáveis.
- Fase 5 depende de P06 para definir permissões de `admin`, `user` e `client` no fluxo de atribuição; não cria novo papel automaticamente.
- Fase 8 depende da reconciliação de saldo de abertura e só é necessária quando houver dados a preservar/migrar.
- Fase 4 depende da matriz de permissões e domínios de frontend para `SameSite`/CORS corretos.
- A transição com dados preservados não inicia enquanto houver divergências sem proprietário/resolução no relatório de carga; reconstrução limpa de desenvolvimento não exige janela de manutenção de produção.

## 14. Riscos e decisões de negócio pendentes

### 14.1 Riscos

| Risco | Probabilidade/impacto | Mitigação no plano |
| --- | --- | --- |
| Perda ou corrupção de dados durante rebuild | Alto impacto. | Snapshot verificável, ambiente isolado, carga idempotente, ensaio e rollback; nenhuma exclusão automática. |
| Confusão entre produto/item legado da OS e produto de estoque | Alto impacto de modelagem e reconciliação. | Não associar nem mapear automaticamente entre domínios; reconciliar OS e estoque em fluxos independentes. |
| Saldo inicial incorreto | Alto impacto operacional/financeiro. | Inventário físico ou fonte formal aprovada; eventos de abertura auditáveis. |
| Cookie quebrar frontend em produção | Alto impacto de autenticação. | Definir domínios e testar CORS/SameSite/Secure em ambiente semelhante à produção. |
| Atribuição incorreta ou concorrente de OS | Alto impacto operacional e de auditoria. | Regra de uma atribuição ativa conforme decisão pendente, controle transacional/concorrência ao assumir, ownership validado no backend e histórico de assumir/liberar/reatribuir. |
| Reprocessar outbox reenviar e-mails ou repetir efeito externo | Médio/alto impacto reputacional. | Não prometer exactly-once; usar chave do provedor quando disponível, registrar estados tentado/confirmado/falha/desconhecido conforme capacidade, reconciliar backlog/DLQ e exigir aprovação antes de replay arriscado. |
| Mudanças em rotas quebrarem clientes | Médio/alto. | Inventário de consumidores, contrato versionado/compatibilidade e janela de transição. |
| Rebuild/migração mais longo do que o previsto, quando houver dados preservados | Médio. | Ensaiar carga, medir duração, aplicar freeze/delta e ter rollback somente no cenário que exigir transição de dados. |
| Escopo inflar com tecnologias futuras | Médio. | Manter Mongo/Kafka/CQRS/microserviços fora do caminho crítico. |

### 14.2 Decisões humanas: aprovadas e pendentes

| ID | Decisão / status | Impacto ou consequência |
| --- | --- | --- |
| P01 | Cardinalidade e semântica do endereço de pedido: um snapshot, vários ou referência a endereço de cliente. | Bloqueia DDL de pedido/endereço e API. |
| P02 | Política de exclusão/retenção/anonimização de clientes e pedidos. | Bloqueia nullability, FKs e reconciliação de órfãos. |
| P03 | Regras de ativação: quem cria cliente, validade/reuso/tentativas do código e contas sem senha. | Bloqueia schema e fluxos de cliente. |
| P04 | Orçamento sem cliente é permitido? Qual ciclo de vida do PDF no MinIO? | Bloqueia nullability e limpeza/retenção de objetos. |
| P05 | Duração de sessão, logout e revogação de JWT. | Bloqueia contrato de cookie e tabela de revogação, se necessária. |
| P06 | Matriz completa de permissões para `admin`, `user`, `client`, incluindo o significado operacional de `user` como possível colaborador de OS, assumir/liberar/reatribuir, consulta de OS atribuídas e atualização de itens. | Bloqueia autorização consistente; não autoriza criar novo papel automaticamente. |
| P07 | Cadastro de cliente é público, administrativo ou ambos? | Bloqueia correção de rotas e remoção de `user_id` inexistente. |
| P08 | Política de vínculo Google: auto-criação, vínculo de conta existente e conflito de e-mail/Google ID. | Bloqueia migração e fluxo OAuth. |
| P09 | **Decisão aprovada:** produtos/itens da OS e produtos do estoque são domínios independentes, sem FK, association Sequelize, baixa, reserva, consumo, reversão ou integração automática. | Remove a dependência estrutural entre os domínios; eventual integração futura exige novo requisito e aprovação específicos. |
| P10 | Catálogo de tipos de movimentação, descrição obrigatória, regras de saldo, ajustes e inventário; saída restrita, se aplicável. | Bloqueia o modelo definitivo do ledger e os endpoints de estoque. Não inclui vínculo automático com OS/cliente. |
| P11 | Status e transições da OS, atores autorizados e eventos próprios do domínio. | Bloqueia regras transacionais da OS; não bloqueia estoque e não produz efeito automático no estoque. |
| P12 | Semântica de `control_level`, `min_quantity`, alertas e reposição. | Evita implementar automação não requerida. |
| P13 | SLOs, observabilidade, saúde e política de replay/DLQ. | Bloqueia critérios operacionais de produção. |

## 15. Critérios de aceite verificáveis

### 15.1 Banco e rebuild

- [ ] O schema-alvo é criado do zero por migrations novas, sem alteração de migrations existentes.
- [ ] Para cada tabela, PK, FK, nullability, exclusão, índices e constraints possuem decisão/evidência documentada.
- [ ] Models e schema real passam testes de integração de associação e persistência.
- [ ] Quando houver dados a preservar, snapshot de origem possui data, checksum, responsável e instrução de restauração testada.
- [ ] Quando houver carga, ela é idempotente e produz relatório de contagem, mapeamento de IDs, rejeições e divergências.
- [ ] Toda divergência de dado preservado possui decisão de correção, exclusão aprovada ou retenção como exceção; nenhuma é descartada silenciosamente.
- [ ] Quando houver migração de estoque, saldo inicial possui fonte aprovada e eventos de abertura rastreáveis.

### 15.2 Autenticação e autorização

- [ ] Login interno, login de cliente e Google OAuth emitem o mesmo cookie HttpOnly configurado centralmente.
- [ ] Em produção o cookie usa `Secure`; em desenvolvimento local a exceção é explícita e coberta por teste.
- [ ] A resposta de login não inclui JWT no corpo.
- [ ] Logout expira o cookie com os mesmos atributos relevantes e acesso posterior falha.
- [ ] CORS aceita somente origins aprovadas com credentials e rejeita origem não permitida.
- [ ] Mutações (`POST`, `PUT`, `PATCH` e `DELETE`) validam `Origin` conforme a política aprovada e não tratam CORS isoladamente como proteção CSRF.
- [ ] Quando `SameSite=None` for necessário, o contrato implementado inclui proteção CSRF explícita; testes rejeitam mutações iniciadas em domínio não autorizado.
- [ ] Todas as rotas autenticadas estão após middleware de autenticação; rotas públicas são justificadas.
- [ ] Cada mutação possui teste de papel e ownership conforme matriz aprovada.
- [ ] Ações de assumir, liberar, reatribuir OS e atualizar produto/item da OS validam no backend a atribuição válida ou a permissão administrativa; o frontend não define livremente o responsável pela ação.

### 15.3 Pedidos e estoque

- [ ] OS, produtos/itens, endereço/snapshot e total obedecem ao modelo aprovado e são gravados/alterados atomicamente dentro do domínio de OS.
- [ ] Administrador cria OS; colaborador autorizado assume a OS inteira; a atribuição persiste após logout e pode ser consultada pelo colaborador autenticado.
- [ ] Atualização de produto/item da OS registra a identidade autenticada do colaborador e é recusada para colaborador sem atribuição válida, salvo permissão administrativa aprovada.
- [ ] Liberação e reatribuição registram responsável anterior, novo responsável, autor autenticado, data/hora e motivo no histórico de OS.
- [ ] Produtos/itens da OS não possuem FK, association Sequelize ou dependência estrutural de produto do estoque; nenhum processo associa legados entre os domínios.
- [ ] Alterar produto ou status da OS não altera `product.quantity` nem cria evento de estoque.
- [ ] Movimentar estoque não altera produto, item, status ou histórico da OS.
- [ ] Nenhuma atualização de `product.quantity` ocorre fora do use case de movimento de estoque.
- [ ] Toda movimentação operacional exige descrição livre não vazia; a descrição é preservada no evento e não é usada como chave de relacionamento com cliente/OS.
- [ ] O responsável registrado no evento é obtido da identidade autenticada; campos livres de responsável enviados pelo frontend são ignorados/rejeitados conforme contrato.
- [ ] Um movimento válido grava `product.quantity` (saldo oficial) e evento interno imutável, com saldo resultante, na mesma transaction PostgreSQL.
- [ ] Evento de estoque não pode ser alterado/excluído por APIs operacionais; correção usa novo evento conforme catálogo aprovado.
- [ ] Em **teste de integração PostgreSQL**, duas requisições concorrentes com a mesma chave e o mesmo conteúdo encontram a restrição `UNIQUE` no escopo definido, produzem somente uma movimentação/alteração de saldo e ambas recebem o resultado original consistente.
- [ ] Em **teste de integração PostgreSQL**, reutilização da mesma chave com conteúdo diferente retorna conflito sem criar outro evento nem alterar saldo; a implementação não depende apenas de consulta prévia da chave.
- [ ] Regras de saldo suficiente, ajustes, inventário e saída restrita são testadas somente quando aprovadas em P10; reserva/consumo/reversão automática por OS não fazem parte do escopo.

### 15.4 Mensageria e operação

- [ ] O registro de saldo e ledger interno de estoque não depende de RabbitMQ, Outbox ou consumer externo.
- [ ] Todo evento de integração publicado possui identificador estável e versão de contrato.
- [ ] Publisher só considera entrega concluída após confirmação do RabbitMQ.
- [ ] Consumer recebe a mesma mensagem duas vezes sem produzir efeito local duplicado por `consumer + event_id`; essa deduplicação é distinta da idempotência do comando de movimentação.
- [ ] Para e-mail/efeito externo, o contrato não promete exactly-once: usa chave de idempotência do provedor quando disponível ou mantém procedimento de tentativa, confirmação, falha, resultado desconhecido e reconciliação antes de replay.
- [ ] Retry, limite, DLQ e procedimento de replay são testados e documentados.
- [ ] Backlog/idade do outbox, falhas esgotadas, DLQ e deduplicações possuem métricas/alertas aprovados.
- [ ] API, worker e consumer possuem checks de saúde/readiness adequados ao ambiente.

### 15.5 Reconstrução de desenvolvimento e eventual cutover futuro

- [ ] Rebuild do ambiente de desenvolvimento foi ensaiado em ambiente isolado, com criação limpa do baseline e smoke tests.
- [ ] Se houver dados a preservar, ensaio de carga foi realizado em ambiente isolado com duração medida e rollback documentado/testado.
- [ ] Se houver produção antes da conclusão do saneamento, plano de cutover é aprovado para o ambiente real e identifica janela, freeze de escrita, responsáveis, comunicação e critérios de abortar.
- [ ] Aceites das fases aplicáveis foram assinados pelos responsáveis técnico, negócio e dados.

## 16. Fora de escopo desta etapa

Este documento não autoriza nem executa alteração de código, migrations, banco, dependências, containers, dados ou infraestrutura. Também não torna obrigatórios MongoDB, Kafka, microserviços, CQRS integral, Event Sourcing além do ledger de estoque aprovado, TypeScript, OpenAPI ou novas obrigações de compliance. Essas iniciativas só entram em plano de execução após requisito e aprovação específicos.