# Feature Specification: Fundação de Setores e Gestão de Estoque

**Feature Branch**: `003-sectors-inventory-foundation`
**Created**: 2026-11-11
**Status**: Regras funcionais consolidadas com pendências explicitamente encaminhadas ao planejamento; não autoriza implementação
**Input**: Requisitos fornecidos para setores, autorização por setor e gestão de materiais/estoque.

**Banco adotado**: PostgreSQL 17, versão oficial da Alves Glass API.

## Resumo

Estabelecer uma fundação compartilhada para os setores Vidraçaria e Marcenaria, associar usuários
comuns aos setores que podem acessar e especificar o ciclo auditável de materiais e saldo de cada
almoxarifado. PostgreSQL permanece fonte de verdade para cadastro operacional, saldo e ledger de
estoque. Clientes permanecem cadastros globais. Ordens de Serviço, produção e orçamentos não são
implementados nesta feature nem recebem efeitos automáticos das movimentações.

Esta especificação deve ser lida em conjunto com `.specify/memory/constitution.md` e
`docs/audit/remediation-plan.md`. Se houver conflito, a Constituição e as decisões arquiteturais
  aprovadas prevalecem; definições técnicas ainda abertas estão destacadas para planejamento.

## Contexto atual confirmado

- A aplicação usa Express, Sequelize 6, PostgreSQL e Sequelize CLI convencional. A arquitetura
  vigente é Routes → Controllers → Services/Use Cases → Repositories → Models; services controlam
  transações. Migrations aplicadas não devem ser editadas; mudanças futuras de schema são aditivas.
- Os papéis persistidos em `users.role` são `admin` e `user`. `Client` é uma identidade separada.
  A Feature 002 fornece sessão persistida, cookie e middleware que obtém identidade/role no backend.
- No baseline anterior à Feature 003 não havia `Sector`, `UserSector`, `Warehouse`, `Material`, saldo/evento de estoque
  operacional, Outbox, RabbitMQ ou MongoDB funcionais/registrados. Estado atual da feature está descrito em `tasks.md` e não altera essa evidência histórica.
- A migration legada `20261110000400-create-inventory.cjs` criou `product_category`, `category`,
  `Product` e `stock_movements`; a tabela de movimento possui `IN`/`OUT`, quantidade e alguns
  campos de responsável. Não há rotas ou caso de uso de inventário conectado a esses Models.
- `Product` existente representa o catálogo legado de produtos; a feature não deve renomear,
  reaproveitar ou vincular automaticamente esse catálogo a materiais. `OrdersProducts` guarda
  snapshot textual e não possui FK para `Product`.
- A Feature 001 substituiu o baseline planejado por Sequelize CLI convencional. A Feature 002
  documenta que a matriz efetiva de acesso deve derivar dos endpoints existentes, não de matrizes
  antigas aspiracionais.
- O plano aprovado de saneamento (`docs/audit/remediation-plan.md`) determina estoque independente
  de OS, `product.quantity` como saldo canônico exclusivo do domínio legado `Product` e saldo
  canônico próprio para `Material`, cada qual com ledger imutável na mesma transação. A arquitetura
  aprovada prevê Transactional Outbox para publicar fatos confiavelmente quando distribuídos; sua
  implementação nesta entrega não é presumida. A estratégia de reconstrução/reconciliação de dados
  existentes é pré-requisito antes de qualquer
  mudança destrutiva.
- Decisão aprovada: `Material` possui saldo canônico próprio no PostgreSQL, separado do
  `Product.quantity` legado. A emenda constitucional 2.0.0 e o plano de saneamento foram atualizados.
  Não há migração, sincronização, associação ou reaproveitamento automático de dados entre domínios.
- Escopo de entrega da Feature 003: cadastro e fundação transacional PostgreSQL, saldo operacional,
  ledger interno imutável, idempotência, autorização, QR/PIN e relatórios definidos nesta spec. A
  exclusão desses itens da entrega 003 não revoga a arquitetura aprovada de Event Sourcing/CQRS em
  ambos os domínios, nem a previsão de Outbox/RabbitMQ e projeções MongoDB; tais componentes não são
  declarados implementados por esta feature. Redis não integra o domínio de estoque.
- PostgreSQL continua autoridade e o saldo permanece transacional para consistência operacional.
  Essa visão não transforma o ledger em simples auditoria nem cancela Event Sourcing/CQRS;
  projeções de leitura derivam dos eventos e são reconstruíveis, sem se tornarem fonte operacional
  concorrente. Os requisitos arquiteturais estão detalhados em AR-001/AR-002 e sua conclusão é
  rastreada em T048–T050.
- A arquitetura da aplicação permanece Controller → Service → Repository → Model; services/use
  cases controlam as transações e a Feature 002 fornece os mecanismos existentes de autenticação.

## Terminologia e limites do domínio

- **Setor**: unidade de autorização e organização operacional. Nesta versão: Vidraçaria ou
  Marcenaria. Não representa por si só um local físico de armazenamento.
- **Almoxarifado**: unidade física/lógica de estoque pertencente a exatamente um setor. Cada
  setor pode possuir múltiplos almoxarifados; cada material e suas categorias/subcategorias
  pertencem a exatamente um almoxarifado.
- **Material**: insumo ou material gerenciado como estoque. Não é produto final fabricado, item de
  catálogo comercial ou item de OS.
- **Evento de inventário**: fato imutável que registra entrada, saída, ajuste, devolução ou abertura
  de saldo; contém quantidade, autor/responsável, motivo e saldos anterior/posterior conforme o
  tipo de evento aprovado.
- **Ledger de eventos**: fatos canônicos append-only do domínio de estoque, base para histórico e
  projeções Event Sourcing/CQRS. O estado transacional PostgreSQL permanece autoritativo para
  comandos; MongoDB, quando implementado, é projeção reconstruível, nunca autoridade concorrente.
- **Saldo operacional**: saldo canônico atual do Material, persistido no PostgreSQL e atualizado
  atomicamente com o evento correspondente; `Product.quantity` permanece exclusivo do domínio
  legado, conforme Constituição 2.0.0.
- **PIN de autorização**: credencial individual independente da senha de login, usada para autorizar
  retirada; autentica o responsável pelo estoque, nunca o colaborador selecionado como retirante.
- **Cliente**: identidade global. Sua existência e dados cadastrais não são duplicados nem
  particionados por setor.

Nomes finais de tabelas/Models e compatibilidade com `Product`, `Category`, `ProductCategory` e
`StockMovements` ficam para o planejamento técnico. Não renomear nem alterar migrations legadas
nesta etapa. O saldo canônico de Material não será espelhado em `Product.quantity`.

## Atores e autorização

| Ator | Acesso especificado |
|---|---|
| `admin` autenticado | Acesso global aos dois setores e às operações administrativas; pode atribuir, alterar e revogar vínculos de setor de usuários comuns. |
| `user` autenticado | Acessa somente setores aos quais esteja vinculado. Vínculo com ambos concede acesso aos dois setores, nunca privilégios administrativos. |
| Cliente (`Client`) | Não recebe acesso a estoque nem a gestão de setores por esta feature. Cadastro continua global. |
| Visitante sem sessão | Pode consultar a página pública resolvida por QR conforme os dados públicos mínimos. Não pode registrar retirada. |

O backend valida identidade, role, autorização do setor, estado do material e propriedade do
almoxarifado em toda operação protegida. O setor, usuário, responsável autenticado ou autorização
fornecidos pelo cliente HTTP não substituem a identidade obtida da sessão. Administração global
não pode ser obtida por possuir autorização para os dois setores.

## Histórias de usuário

### US1 — Administrar autorização de setor (P1)

Como administrador, quero conceder, alterar e revogar acesso de usuários comuns aos setores, para
que cada colaborador visualize e opere somente os estoques autorizados.

**Critérios de aceite**

1. Dado um `admin` autenticado, quando atribui um usuário a Vidraçaria, Marcenaria ou ambos, então
   o backend persiste vínculos explícitos e confirma os setores efetivamente autorizados.
2. Dado um `user` ou `Client`, quando tenta atribuir ou revogar autorização, então a operação é
   recusada e nenhum vínculo é alterado.
3. Dado um `user` vinculado somente a Vidraçaria, quando consulta ou altera recurso de Marcenaria,
   então recebe acesso negado e nenhum dado ou efeito da operação é exposto.
4. Dado um `user` vinculado aos dois setores, quando acessa ambos, então permanece com role `user`;
   não pode executar operação exclusiva de administrador.
5. Dado um `admin`, quando opera em qualquer setor, então não necessita de vínculo `UserSector`.
6. A revogação é aplicada nas operações subsequentes, sem depender de autorização enviada pelo
   frontend ou de claims antigas no token.

### US2 — Consultar setores e almoxarifados autorizados (P1)

Como usuário autorizado, quero ver os setores/almoxarifados que posso acessar, para selecionar o
contexto correto antes de operar materiais.

**Critérios de aceite**

1. A consulta retorna somente setores autorizados ao usuário comum; `admin` pode consultar ambos.
2. Um setor inexistente ou não autorizado não pode ser usado para inferir ou consultar dados de
   materiais daquele setor.
3. A API deixa claro qual almoxarifado contém cada material e não apresenta um catálogo global
   compartilhado entre os dois almoxarifados.

### US3 — Cadastrar e manter materiais (P1)

Como usuário autenticado e autorizado para um setor, quero cadastrar e atualizar materiais do
almoxarifado desse setor, para controlar insumos identificáveis e seus níveis mínimos.

**Critérios de aceite**

1. Material criado contém identificador, código globalmente único e imutável, nome, descrição, imagem (ou
   referência persistida à imagem), unidade, almoxarifado, categoria, subcategoria opcional,
   localização física, quantidade mínima, situação ativo/inativo e identificador QR estável.
   O cadastro recebe `initialQuantity` como string decimal exata; admin e user autorizado no setor
   podem cadastrar. Material, saldo canônico e um único evento `OPENING` (saldo anterior zero,
   posterior igual à quantidade inicial) são gravados atomicamente, com `performedBy` definido pela
   sessão. Quantidade zero é válida; valores negativos, não finitos ou fora da escala são rejeitados.
2. Código estável não se repete dentro do escopo de unicidade aprovado; tentativa de duplicação
   retorna conflito sem criar segundo material.
3. Categoria deve pertencer ao mesmo almoxarifado do material. Se houver subcategoria, ela deve
   pertencer à categoria indicada e ao mesmo almoxarifado.
4. Subcategoria é opcional e admite somente um nível de hierarquia.
5. Usuário sem autorização do setor não pode criar, consultar detalhe protegido, editar, ativar ou
   inativar material daquele setor.
6. Material com histórico não pode ser excluído fisicamente. Inativação ordinária exige saldo zero;
   saldo positivo deve ser resolvido antes por movimentação autorizada e auditável. Material inativo
   continua consultável para auditoria e não aceita movimentações ordinárias.
7. Nenhuma edição cadastral altera retroativamente eventos já registrados ou seus snapshots.
8. `initialQuantity` não pode ser alterado após cadastro; mudança posterior de saldo ocorre somente
   por evento do ledger. Repetição/conflito de criação não produz abertura duplicada.

### US4 — Registrar entrada de material (P1)

Como usuário autenticado e autorizado, quero registrar entrada de material por QR ou seleção
manual, para atualizar o saldo com trilha auditável.

**Critérios de aceite**

1. QR e seleção manual resolvem o mesmo material atual no backend e obedecem à mesma autorização.
2. Entrada exige quantidade válida e positiva, ator autenticado, data/hora do servidor e descrição
   livre não vazia, preservada no evento.
3. O saldo anterior, o evento imutável e o saldo posterior são persistidos atomicamente em
   PostgreSQL.
4. Repetir uma chave idempotente com conteúdo igual retorna o resultado original sem novo evento;
   repetir a chave com conteúdo diferente retorna conflito sem alteração de saldo.
5. Falha em qualquer gravação deixa saldo e ledger sem atualização parcial.

### US5 — Registrar saída de material (P1)

Como colaborador selecionado no fluxo de retirada, quero que o responsável pelo estoque autorize
com seu PIN individual uma retirada iniciada por QR, preservando identidades distintas e auditáveis.

**Critérios de aceite**

1. O fluxo identifica o material pelo QR, seleciona colaborador por identificador interno (exibindo
   nome e dado distintivo para evitar homônimos) e informa quantidade positiva, descrição/motivo
   não vazia e eventual referência de OS textual.
2. O responsável pelo estoque fornece PIN individual independente da senha de login. O backend
   valida PIN, conta e permissão setorial de quem autoriza; PIN não autentica o colaborador.
3. Identificar o autorizador antes de validar o PIN; não buscar titulares comparando um PIN com
   múltiplas contas. PIN inválido ou autorizador sem permissão rejeita o comando sem revelar saldo
   nem criar movimento. Aplicar política inicial de 5 falhas/15 minutos e bloqueio por 15 minutos.
4. No fluxo QR sem sessão, não inventar `performedBy`: registrar origem do comando e manter
   `withdrawnBy` e `authorizedBy` separados.
5. A quantidade é positiva e o saldo disponível é suficiente no instante da operação transacional.
   Duas saídas concorrentes que, em conjunto, excedam o saldo não podem produzir saldo negativo.
6. Se informada, a referência de OS é texto opcional sem FK, validação de existência ou efeito no
   domínio de OS; não altera status, itens ou histórico de OS.
7. O evento registra material, almoxarifado, quantidade, motivo/descrição, timestamp do servidor,
   saldos anterior/posterior, sequência, `performedBy`, `withdrawnBy`, `receivedBy` e `authorizedBy`
   quando aplicáveis. PINs, senhas e segredos nunca são persistidos ou expostos.
8. Requisição válida retorna confirmação da retirada; erro de validação, autenticação,
    autorização, saldo ou idempotência não cria evento nem altera saldo.
9. Leitura pública do QR não autoriza retirada. A autorização pontual por PIN é do responsável,
    não cria sessão persistente e não substitui as regras de autorização setorial.

### Identidade e origem do comando de retirada

O colaborador retirante é escolhido por identificador interno, com nome e dado distintivo exibidos
para evitar homônimos. O responsável deve ser identificado antes da validação do seu PIN. O PIN
autentica exclusivamente `authorizedBy`; não identifica `withdrawnBy` e não cria sessão. Em retirada
QR sem sessão, `performedBy` não é artificialmente preenchido: a origem do comando é registrada
separadamente, e `withdrawnBy` e `authorizedBy` permanecem identidades distintas.

### US6 — Corrigir saldo por ajuste, devolução ou abertura (P1)

Como usuário autorizado segundo a política aprovada, quero corrigir discrepâncias por eventos
compensatórios, para preservar a auditabilidade sem editar o passado.

**Critérios de aceite**

1. Ajustes exigem autorização administrativa, responsável e justificativa; devoluções referenciam a
   movimentação original sempre que identificável.
2. Evento existente não pode ser editado ou apagado por API operacional; correção cria evento
   compensatório com referência ao evento corrigido e motivo.
3. O cadastro cria uma única abertura por Material na mesma transação do saldo inicial, com autoria
   rastreável; não exige operação de abertura nem aprovação adicional G1. Nenhuma movimentação produz
   saldo negativo.

### US7 — Consultar material e histórico (P1)

Como usuário autorizado, quero consultar saldo e extrato paginado de um material, para conferir
consumo e auditoria no seu setor.

**Critérios de aceite**

1. A leitura protegida valida setor/almoxarifado no backend.
2. Resposta do material inclui uma coleção encapsulada em `movements`, paginada com ordenação
   determinística e cursor/limite documentados; não inclui histórico inteiro sem limite.
3. Cada movimento expõe tipo, quantidade, responsável/autoria segundo política, motivo/descrição,
   timestamp e saldos anterior/posterior necessários à auditoria.
4. Página pública de QR resolve o identificador opaco e expõe somente nome, imagem aprovada e
   unidade. Não contém cookie, credencial ou autorização administrativa, nem expõe saldo,
   localização, setor ou histórico.
5. Código inválido/inativo não permite acessar outro material nem executar comando de estoque.

## Requisitos funcionais

- **FR-001**: O sistema MUST manter os papéis existentes `admin` e `user`; `Client` permanece uma
  identidade independente e cadastro global, não segmentado por setor.
- **FR-001a**: O colaborador retirante MUST ser resolvido por identificador interno; a interface
  exibe nome e dado distintivo aprovado para evitar homônimos. Nome não substitui o identificador.
- **FR-002**: O sistema MUST disponibilizar dois setores iniciais, Vidraçaria e Marcenaria, sem
  confundir setor com almoxarifado.
- **FR-003**: O sistema MUST associar usuários comuns aos setores por autorizações explícitas,
  permitindo nenhum, um ou ambos os setores. Somente `admin` pode criar, alterar ou revogar essas
  autorizações.
- **FR-004**: A autorização de setor MUST ser aplicada no backend em todas as operações protegidas
  sobre almoxarifado, categoria, subcategoria, material e inventário. Ter dois vínculos MUST NOT
  transformar `user` em `admin`.
- **FR-005**: Um setor MAY possuir múltiplos almoxarifados; cada almoxarifado MUST pertencer a
  exatamente um setor. Materiais, categorias e
  subcategorias MUST pertencer a um único almoxarifado; não haverá catálogo compartilhado de
  materiais entre almoxarifados.
- **FR-006**: O sistema MUST cadastrar materiais de estoque com todos os campos definidos nesta
  spec, incluindo código estável, unidade, imagem, quantidade mínima, situação e QR estável.
  O cadastro exige `initialQuantity` decimal em string, aceita zero e persiste Material,
  `MaterialBalance` e evento único `OPENING` na mesma transação, com autoria da sessão. A capacidade
  de saldo inicial no cadastro não depende do gate G1 de aprovação adicional.
- **FR-007**: O código de material MUST ser globalmente único e imutável; QR estável com
  identificador opaco identifica o material, mas não concede privilégio.
- **FR-008**: Categorias pertencem a um almoxarifado; subcategorias são opcionais, pertencem a uma
  categoria do mesmo almoxarifado e não suportam profundidade superior a um nível.
- **FR-009**: O sistema MUST registrar `IN`, `OUT`, `RETURN`, `ADJUSTMENT` e `OPENING` como eventos
  imutáveis. Quantidades ordinárias são positivas; `IN`, `RETURN` e `OPENING` aumentam saldo;
  `OPENING` de cadastro aceita delta zero ou positivo e há no máximo um por material;
  `OUT` diminui saldo; `ADJUSTMENT` registra delta positivo ou negativo. Nenhum movimento pode
  gerar saldo negativo. Todos exigem descrição; RETURN, ADJUSTMENT e OPENING exigem motivo
  categorizado. RETURN referencia a movimentação original sempre que identificável; todo evento
  compensatório referencia o evento corrigido. Relatórios distinguem tipos e sinais sem classificar
  RETURN ou ADJUSTMENT como entrada/saída operacional.
- **FR-010**: Cada evento aceito MUST guardar material, almoxarifado, tipo, quantidade, timestamp do
  servidor, motivo/descrição, `performedBy`, `withdrawnBy`, `receivedBy`, `authorizedBy` quando
  aplicáveis, saldo anterior/posterior, sequência e chave idempotente; MUST NOT guardar segredo.
- **FR-011**: `Material` MUST possuir saldo canônico próprio no PostgreSQL, separado de
  `Product.quantity`, exclusivo do domínio legado. A regra segue a Constituição 2.0.0; não haverá
  espelhamento, associação ou importação automática de dados.
- **FR-012**: Atualização do saldo canônico próprio do Material e gravação do evento MUST ser
  atômicas na mesma transação PostgreSQL; falha parcial MUST rollback e saldo negativo é proibido.
- **FR-013**: A API MUST proibir edição/exclusão do ledger por operação comum; correções criam
  evento compensatório. Alteração direta de saldo fora do caso de uso de movimentação MUST NOT ser
  permitida.
- **FR-014**: Todo comando de movimentação MUST exigir chave idempotente que identifique uma
  tentativa lógica de operação. Chave, hash canônico da requisição e resultado MUST ser persistidos
  atomicamente com saldo/evento. Mesma chave e conteúdo retornam o resultado original; mesma chave
  com conteúdo diferente retorna conflito. Escopo UNIQUE aprovado: almoxarifado + principal efetivo
  (`performedBy` em sessão ou `authorizedBy` no QR sem sessão) + chave do cliente. A constraint
  também inclui `operationId` estável, único por almoxarifado, para proteger a mesma intenção lógica
  quando há troca de autorizador durante retry. Cada
  intenção lógica usa adicionalmente um `operationId` estável, único por almoxarifado; retries da
  mesma intenção reutilizam esse ID mesmo se houver troca do autorizador, sem duplicar evento.
- **FR-015**: A saída MUST verificar saldo sob concorrência no PostgreSQL, sem depender de consulta
  prévia isolada; comandos concorrentes não podem gerar saldo negativo.
- **FR-016**: A referência textual opcional de OS MUST NOT possuir FK/association nem disparar
  reserva, consumo, devolução ou mudança de status. O domínio de OS permanece fora da feature.
- **FR-017**: Consulta do material por QR resolve dados atuais no backend. A página pública não
  autentica o portador do QR nem substitui login em operações protegidas.
- **FR-018**: Histórico por material MUST ser encapsulado em `movements`, com paginação e ordenação
  estáveis, e respeitar autorização de setor em consultas não públicas.
- **FR-019**: Nesta entrega, consultas de saldo, histórico e relatórios leem do PostgreSQL
  autoritativo; projeções MongoDB reconstruíveis são obrigatórias para o aceite final conforme
  AR-001 e T048–T050.
- **FR-020**: Clientes e seus dados cadastrais MUST NOT ser duplicados por setor. Esta feature não
  modifica fluxos, rotas ou schema de cliente sem necessidade demonstrada.
- **FR-021**: A feature MUST NOT alterar autenticação/sessões existentes além da integração
  necessária para consultar o role/user e a autorização setorial no backend, devidamente
  justificada no planejamento.
- **FR-022**: Retirada unitária MUST resolver material por QR ou identificação manual, apresentar
  saldo, receber quantidade, solicitar PIN em Dialog e registrar um único `OUT` antes de retornar
  ao scanner. O PIN individual identifica a própria pessoa retirante; `withdrawnBy` e
  `authorizedBy` são derivados da conta validada. Não há seleção de terceiro nem retirada em lote.
- **FR-023**: Backend MUST validar autorização setorial atual do autorizador. PIN é armazenado
  apenas como hash; política inicial é 5 falhas em 15 minutos e bloqueio por 15 minutos. Não
  comparar PIN com múltiplas contas. Fluxo não cria sessão persistente para o retirante.
- **FR-024**: Evento MUST distinguir `performedBy`, `withdrawnBy`, `receivedBy` e `authorizedBy`
  quando aplicáveis, além dos atributos comuns. Nenhum segredo pode ser persistido, registrado em
  logs ou retornado.
- **FR-025**: QR opaco, estável e revogável, sem autenticar o portador nem permitir retirada.
  Leitura pública expõe somente nome, imagem aprovada e unidade; não expõe saldo, localização,
  setor, mínimo ou histórico.
- **AR-001**: PostgreSQL é fonte de verdade e autoritativo para comandos, ledger, saldo e idempotência transacionais. Event Sourcing preserva eventos imutáveis e compensações; CQRS separa comandos de consultas. Transactional Outbox grava fatos destinados à publicação atomicamente; RabbitMQ entrega assincronamente at-least-once e consumers idempotentes tratam falhas/reentregas. MongoDB mantém projeções reconstruíveis de saldo, consultas, relatórios e histórico em `movements`, reconciliáveis com PostgreSQL. T048–T050 e suas validações são obrigatórias para conclusão da Feature 003.
- **AR-002**: Requisito de implementação recebido em 12/11/2026: snapshots versionados são obrigatórios para acelerar reconstrução, devem ser recuperáveis e nunca substituem/excluem eventos do ledger. A política de geração deve ser baseada em volume/desempenho, documentada e testada; limiares concretos dependem de medição, não devem ser inventados. O histórico lógico MongoDB em `movements` deve ter armazenamento/paginação escalável, evitando documento acima do limite físico e carga integral em memória. Redis não integra a Feature 003. Esta exigência de snapshots é um incremento do pedido atual; a arquitetura aprovada descreve snapshots como otimização possível.
- As regras FR-027–FR-048 existentes permanecem inalteradas; preservam eventos, QR/PIN e decisões de negócio aprovadas.
- **FR-049**: Inativação de Material MUST exigir saldo zero; saldo positivo é liquidado antes por movimentação autorizada e auditável. Material inativo permanece consultável, sem movimento ordinário.

## Requisitos não funcionais

- **NFR-001 — Integridade**: PostgreSQL é a fonte de verdade do saldo e ledger; constraints e
  transações devem sustentar as invariantes mesmo sob concorrência.
- **NFR-002 — Segurança**: comandos protegidos validam identidade/autorização no backend. Mutações
  autenticadas por cookie usam Origin/CSRF conforme política existente; retirada por QR valida o
  PIN do autorizador e suas permissões sem sessão persistente para o retirante. Nunca confiar em
  identidade, ator, role ou setor enviados pelo cliente HTTP.
- **NFR-003 — Imutabilidade**: registros de eventos operacionais são append-only; retenção e
  anonimização devem preservar trilha e cumprir decisões legais/operacionais aprovadas.
- **NFR-004 — Idempotência/evolução de integração**: idempotência do comando é distinta de
  deduplicação de consumer por `consumer + event_id`. Na arquitetura aprovada, Outbox/RabbitMQ
  entregam at-least-once quando os eventos do domínio forem distribuídos; a Feature 003 não declara
  publisher/consumer implementados nem promete exactly-once.
- **NFR-005 — Auditoria**: cada mudança permite correlacionar comando, evento, ator autenticado,
  timestamp, motivo e saldos anterior/posterior sem expor tokens ou segredos em respostas/logs.
- **NFR-006 — Paginação**: extratos devem limitar tamanho de página, ter ordenação determinística
  e suportar navegação sem carregar todo o histórico.
- **NFR-007 — Mídia/QR**: referência de imagem e conteúdo do QR não podem expor segredos. O QR é
  estável; a página consulta dados atuais e aplica visibilidade adequada.
- **NFR-008 — Testabilidade**: regras terão testes unitários; FKs, constraints, transações,
  isolamento setorial, saldo concorrente e idempotência terão integração PostgreSQL real. Testes
  de segurança cobrirão negação de acesso, CSRF e fluxo QR, incluindo PIN inválido, bloqueio,
  autorizador sem setor e administrador global. Testes verificarão que PIN e senha não persistem
  nem aparecem em eventos/logs/respostas e que as identidades de auditoria são distintas. Integração com RabbitMQ não faz parte da validação desta entrega; testes reais de broker
  pertencem a uma feature posterior caso mensageria seja aprovada.
- **NFR-009 — Evolução segura**: migrations novas, aditivas, revisadas e validadas em PostgreSQL
  local descartável; migrations legadas não serão alteradas. Mudanças que exijam reconciliar dados
  precisam inventário, fonte aprovada, validação e rollback antes de execução.
- **NFR-010 — Autorização pontual**: retirada valida PIN do autorizador e permissão setorial no
  backend, sem criar sessão persistente para o colaborador selecionado.
- **NFR-011 — PIN**: PIN independente da senha de login, armazenado exclusivamente como hash seguro;
  implementar limitação de tentativas e proteção contra força bruta, sem persistir segredo em
  ledger, logs ou resposta.

## Modelo conceitual e relações

| Entidade conceitual | Relações e invariantes funcionais |
|---|---|
| `Sector` | Um setor possui um ou mais almoxarifados e autorizações `UserSector`. Os registros iniciais são Vidraçaria e Marcenaria. |
| `UserSector` | Liga um `User` comum a um `Sector`; par usuário/setor único. Não é role nem elevação administrativa. Cada `GRANT`/`REVOKE` registra ator, usuário afetado, setor, ação, motivo e timestamp do servidor em trilha histórica preservada. |
| `Warehouse` | Pertence obrigatoriamente a exatamente um `Sector`; nome único por setor após remoção de espaços externos e comparação sem distinção entre maiúsculas/minúsculas. Pode ser inativado, não excluído fisicamente após histórico; inativo não recebe novas movimentações ordinárias. Contém materiais e taxonomia de categorias. |
| `Material` | Pertence a exatamente um `Warehouse` e uma `MaterialCategory`; pode ter zero ou uma `MaterialSubcategory`. Possui identidade/código/QR estáveis. |
| `MaterialCategory` | Pertence a exatamente um `Warehouse`; nome normalizado é único no almoxarifado. Referências impedem exclusão física; inativação é permitida. |
| `MaterialSubcategory` | Pertence a uma categoria do mesmo almoxarifado; sem sub-subcategorias. Nome normalizado é único na categoria; referências impedem exclusão física. |
| `InventoryEvent` | Pertence a um material; registra evento imutável, tipo, quantidade/delta, autoria, justificativa, saldos anterior/posterior e referências de origem/correção. Correção por evento compensatório. |
| `InventoryBalance` | Saldo canônico próprio do novo domínio Material, persistido no PostgreSQL e atualizado na mesma transação do evento; distinto de `product.quantity`, saldo exclusivo do Product legado. Sua representação física não é mais bloqueada pela Constituição 2.0.0. |
| `User` | Permanece papel `admin`/`user`; role consultado conforme sessão existente. Admin global; user autorizado por `UserSector`. |
| `Client` | Entidade global, sem associação setorial introduzida nesta feature. |
| `Order` / OS | Fora do escopo e independente do estoque. Referência textual opcional não cria relação persistente com OS. |

Relações conceituais esperadas: `Sector 1:N Warehouse`; `User N:M Sector` por `UserSector`;
`Warehouse 1:N MaterialCategory`; `MaterialCategory 1:N MaterialSubcategory`; `MaterialCategory
1:N Material`; `MaterialSubcategory 0..1:N Material`; `Material 1:1 InventoryBalance`;
`Material 1:N InventoryEvent`. A cardinalidade física, nomes de FK, estratégia de unicidade e
compatibilidade com tabelas legadas serão detalhadas somente em planejamento após reconciliação.

## Fluxos operacionais

### Cadastro/edição

1. Requisição chega com sessão válida e recurso/setor pretendido.
2. Backend resolve usuário/role e valida acesso ao setor. Admin é global; user precisa de vínculo.
3. Backend valida que warehouse, categoria e subcategoria pertencem ao mesmo escopo.
4. Backend valida campos, código e situação, persiste alterações cadastrais e retorna representação
   autorizada.
5. Atualização cadastral não altera eventos ou saldo.

### Entrada e saída autenticadas

1. Para entrada autenticada, validar sessão existente, autorização setorial atual, material ativo,
   payload, descrição/motivo e chave idempotente.
2. Para retirada QR, resolver o material pelo token opaco e selecionar retirante por ID interno,
   exibindo nome e dado distintivo. Identificar o autorizador antes de validar PIN individual.
3. Validar autorização setorial atual do autorizador e política de PIN. PIN não autentica retirante,
   não cria sessão e não é comparado contra múltiplas contas.
4. No QR sem sessão, registrar a origem do comando sem preencher `performedBy` artificialmente;
   resolver `withdrawnBy` e `authorizedBy` separadamente no backend.
5. Validar material ativo, quantidade, sinais, precisão, justificativa, referência opcional e
   idempotência. Repetição idêntica retorna resultado anterior; divergência de conteúdo conflita.
6. Em transação PostgreSQL, serializar/condicionar saldo, validar suficiência e persistir saldo,
   evento append-only e resultado idempotente atomicamente; qualquer falha faz rollback.
7. Consulta de histórico e relatórios na entrega corrente lê PostgreSQL autoritativo; projeções
   MongoDB reconstruíveis são obrigatórias para conclusão, conforme AR-001 e T050.

## Contrato funcional de API a detalhar no planejamento

Esta seção registra recursos, não fixa ainda verbos, nomes finais de URI, schemas ou status HTTP.

- Administração de setores/autorização: listar setores e conceder, alterar ou revogar `UserSector`
  somente por admin; auditoria registra ator, usuário afetado, setor, ação `GRANT`/`REVOKE`, motivo
  obrigatório e timestamp UTC gerado no servidor. Autorização é sempre validada no backend.
- Almoxarifado pertence obrigatoriamente a um setor; nome único no setor após trim e comparação
  case-insensitive. Inativação preserva histórico e bloqueia novas movimentações ordinárias.
- Consulta operacional: listar almoxarifados/setores acessíveis e materiais filtrados pelo escopo
  autorizado; leitura pública por código QR devolve apenas campos aprovados como públicos.
- Catálogo do estoque: criar/listar/consultar/editar/ativar/inativar materiais e gerir categorias
  e subcategorias no almoxarifado; não há exclusão física de material com histórico.
- Movimentação: tipos, sinais, permissões e justificativas conforme FR-009/FR-036; exigir
  idempotência, saldo não negativo e ledger imutável. Retirada QR segue FR-022/FR-023/FR-028.
- Relatórios na entrega corrente: `StockReportService` segue FR-032 e FR-046–FR-048 no PostgreSQL;
  projeção MongoDB e reconciliação seguem AR-001/T050.
- Histórico: consulta paginada por material, encapsulada em `movements`, com filtros/ordenação
  definidos no planejamento.
- Nenhum endpoint nesta feature cria, atualiza, reserva ou sincroniza OS, orçamento ou produto
  final fabricado.

## Casos excepcionais

- Acesso a setor não autorizado: negar sem retornar dados do setor/materiais.
- Setor, warehouse, material, categoria ou subcategoria inexistente/inativo: rejeitar sem escrita.
- Categoria/subcategoria de outro warehouse: rejeitar a operação por violação de escopo.
- Código/QR duplicado ou idempotency key em conflito de conteúdo: conflito; sem efeito adicional.
- Saída com quantidade não positiva, saldo insuficiente, material inativo ou permissão revogada:
  rejeitar e manter saldo/eventos inalterados.
- Concorrência de saídas/ajustes: bloquear/condicionar saldo de modo que nenhum saldo negativo ou
  saldo/evento divergente seja confirmado.
- Falha entre gravação de saldo e evento: rollback total.
- Reenvio idêntico de comando: devolver resultado original, sem duplicar evento.
- Retirada QR: autorizador inexistente, PIN inválido, bloqueio ou falta de permissão rejeita sem
  revelar saldo nem registrar movimento; PIN não é usado para localizar a conta.
- ID interno do colaborador inválido ou ausente: rejeitar sem movimento; nome e dado distintivo
  apenas auxiliam a seleção e não substituem resolução backend por identificador.
- Payload tenta declarar outra identidade: backend resolve identidades conforme sessão, ID
  selecionado, autorizador identificado e origem do comando, sem confiar em nomes livres.
- Tentativa de editar/apagar evento: negar; correção deve ser novo evento permitido.
- QR inválido/inativo: resposta pública limitada, sem revelar dados internos nem permitir operação.
- Consultas e relatórios da entrega corrente usam PostgreSQL; as projeções MongoDB continuam
  arquitetura aprovada, com implementação não presumida nesta entrega.
- Falta de fonte aprovada, conferência ou aprovação de abertura: bloquear abertura; não importar
  dados Product nem inventar histórico.

## Fora de escopo

- Ordens de serviço, etapas de produção, importação de PDF e histórico de OS.
- Orçamentos e integração de orçamento com estoque.
- Produtos finais fabricados e vínculo de estoque com itens de OS/pedidos.
- Reserva, consumo, baixa, devolução ou reversão automática por evento de OS.
- Alteração das rotas/modelos/autenticação de clientes sem requisito específico.
- Reformulação do mecanismo de sessão, introdução de role novo ou elevação de `user` por acesso
  a múltiplos setores.
- Alteração de migrations legadas, migrations nesta etapa, execução de rebuild/carga ou decisão
  sobre descarte/reconciliação de dados existentes.
- Implementação operacional de Outbox, publisher/consumer RabbitMQ ou projeções MongoDB como critério
  de aceite da entrega atual da Feature 003. A arquitetura aprovada permanece: CQRS/Event Sourcing,
  Outbox transacional, RabbitMQ at-least-once com consumers idempotentes e projeções MongoDB
  reconstruíveis; não declarar esses componentes implementados sem evidência.
- Kafka, microsserviços ou outra mudança arquitetural não aprovada.

## Pendências para planejamento

As regras de negócio aprovadas não eliminam as lacunas operacionais e técnicas abaixo. Hipóteses técnicas não podem ser tratadas como decisões de negócio; estes itens não reabrem decisões já aprovadas.

1. **Saldo de abertura:** selecionar fonte física/documental aprovada, responsáveis designados e
   instante de corte; não importar Product nem fabricar histórico.
2. **PIN/credenciais:** definir fluxos concretos de criação, troca, revogação, recuperação e
   desbloqueio administrativo; limites iniciais já aprovados são 5 falhas/15 minutos e bloqueio
   por 15 minutos. Definir trilha de auditoria sem segredo/hash no ledger.
3. **Identidade QR:** decidir o dado distintivo exibido com o nome do colaborador e a representação
   persistente da origem do comando sem sessão (`performedBy` não artificial).
4. **Idempotência:** implementar o escopo aprovado (almoxarifado + principal efetivo + chave) e
   `operationId` estável por intenção, inclusive em retry QR após troca de autorizador; definir
   canonização/hash e retenção coerente sem permitir duplicidade.
5. **Categorias e mídia:** definir algoritmo exato de normalização de nomes. Regras funcionais G5
   aprovadas: MinIO, buckets público de catálogo e privado, políticas de acesso, URLs temporárias,
   JPEG/PNG/WebP até 5 MB, chaves únicas, troca de referência somente após upload confirmado e
   limpeza segura do objeto anterior/órfão sem excluir objeto referenciado. Validação operacional de
   buckets, credenciais e permissões permanece pendente; sem criar buckets/configurar credenciais
   nesta etapa documental.
6. **Referência OS:** texto opcional até 64 caracteres; definir política operacional de retenção,
   sem FK ou validação de existência.
7. **Autorização setorial:** definir formato da auditoria de concessão/revogação e efeito de
   revogação sobre operações em andamento.
8. **Relatórios:** decisões G6 aprovadas: fuso `America/Sao_Paulo`, máximo de 12 meses, intervalos
   semiabertos, keyset, página padrão 25/máximo 100, cursor opaco protegido e vinculado aos filtros,
   ordenação e escopo, autorização revalidada e leitura paginada. Definir tecnicamente a proteção do
   cursor e avaliar marco de leitura; nunca somar quantidades de unidades distintas.
9. **Retenção:** G4 parcialmente aprovado: preservar ledger append-only e autoria original, sem
   reatribuição; desativar contas e revogar acessos/credenciais/vínculos aplicáveis. Prazos por
   categoria dependem de análise jurídica e operacional. Não presumir prazo nem retenção infinita;
   não implementar expurgo/anonimização automática até aprovação formal.
10. **Operação e evolução técnica:** volume/SLOs para tuning. Contratos, migrations aditivas,
    estratégia de concorrência/constraints, rollback e reconciliação são matéria técnica do plano;
    migrations legadas permanecem intocadas.
  Outbox/RabbitMQ e projeções MongoDB são requisitos obrigatórios do aceite final, detalhados em
  T048–T050; ainda não são declarados implementados. Snapshots são opcionais; Redis não integra o domínio de estoque. O
  `StockReportService` consulta PostgreSQL nesta etapa.

## Decisões consolidadas de G4–G6 (aprovação funcional)

- **G4 — parcialmente aprovado:** eventos permanecem append-only e ligados à autoria original,
  inclusive após desligamento; contas são desativadas e acessos, sessões, PINs e vínculos setoriais
  são revogados quando aplicável; não reatribuir eventos históricos. Política e prazos de retenção
  por categoria aguardam análise jurídica/operacional. Nenhum expurgo ou anonimização automática
  antes dessa aprovação.
- **G5 — funcionalmente aprovado, operacionalmente pendente:** MinIO em dois buckets (catálogo
  público e arquivos privados). Apenas objetos publicados no catálogo têm leitura pública. Backend
  autorizado controla escrita/substituição/exclusão; arquivo privado só após autorização, por URL
  temporária. Formatos JPEG, PNG e WebP, limite 5 MB, chaves únicas. Confirmar upload antes de trocar
  referência PostgreSQL; após confirmação, limpeza controlada da imagem anterior, sem retenção
  adicional. Recuperação de falhas/órfãos nunca remove objeto ainda referenciado. Validar operação,
  buckets, credenciais e permissões antes de habilitar mídia; esta decisão não autoriza configurar
  infraestrutura nesta etapa.
- **G6 — funcionalmente aprovado, implementação pendente:** `America/Sao_Paulo`; consultas de no
  máximo 12 meses; intervalos semiabertos `[início, fim)`; keyset com cursor opaco e protegido contra
  adulteração, vinculado a filtros, ordenação e escopo autorizado; 25 itens padrão, 100 máximo;
  ordenação determinística com desempate único; autorização setorial atual revalidada em toda
  consulta; nunca materializar o histórico completo em memória. Avaliar marco de leitura para
  estabilidade diante de novas movimentações. T038–T041 implementam e validam essas decisões.

## Decisões aprovadas nesta clarificação

- Consolidado: PostgreSQL transacional e ledger imutável são a base da entrega; a Feature 003 só
  pode ser concluída após Event Sourcing/CQRS, Outbox/RabbitMQ e projeções MongoDB reconstruíveis
  implementados e validados conforme T048–T050. Nesta etapa, consultas também usam PostgreSQL.
  Snapshots são opcionais; Redis não integra o domínio.
- O novo domínio é separado do `Product` legado, sem migração, sincronização, associação ou
  reaproveitamento automático. A Constituição 2.0.0 permite saldo canônico próprio de Material;
  cada estoque conserva exatamente uma fonte canônica.
- Setores podem ter múltiplos almoxarifados; código de material é globalmente único e imutável; QR
  é estável e contém identificador opaco.
- Quantidades usam decimal exato; unidades iniciais aprovadas são `un`, `kg`, `g`, `m`, `cm`, `L`,
  `mL`, `m²`; `m³` depende de necessidade confirmada. `un` usa escala 0; fracionáveis usam escala
  máxima 3, sem conversão ou arredondamento silencioso.
- Idempotência usa escopo aprovado: almoxarifado + principal efetivo (`performedBy` autenticado ou
  `authorizedBy` no QR sem sessão) + chave do cliente; canonização e retenção continuam técnicas/
  operacionais a detalhar.
- Movimentos: `IN`, `OUT`, `RETURN`, `ADJUSTMENT`, `OPENING`; convenção de sinais, motivos e
  papéis conforme FR-009/FR-036. RETURN referencia original quando identificável; compensação
- Ajustes requerem autorização administrativa. Cadastro recebe `initialQuantity` e cria Material,
  saldo e OPENING único atomicamente; zero é válido e autoria é obtida da sessão. Esta decisão
  substitui abertura separada e dispensa a aprovação adicional G1 para o saldo inicial do cadastro;
  não define procedimento manual distinto.
- Cada movimento registra material, almoxarifado, tipo, quantidade, saldo anterior/posterior,
  `performedBy`, `withdrawnBy`, `receivedBy`, `authorizedBy` quando aplicáveis, data, motivo,
  descrição e sequência. O ledger é imutável e não armazena segredos.
- **G2/G3 aprovadas formalmente:** o QR identifica somente um Material e não contém segredo. Consulta
  pública retorna somente nome, unidade e metadados públicos aprovados, com rate limiting persistente.
  Retirada sem sessão identifica o colaborador pelo PIN individual de seis dígitos via HMAC lookup e
  verificação segura de hash. A mesma conta é `withdrawnBy` e `authorizedBy`; o backend deriva toda
  identidade/autorização. PIN inválido, titular inexistente, material inexistente e setor não
  autorizado não revelam existência nem identidade. Fluxo: QR → material → quantidade → Retirar →
  Dialog PIN → confirmação → evento OUT. Cada comando movimenta exatamente um material; sem lote.
  Política inicial de tentativas/bloqueio é 5/15 minutos e 15 minutos. No fluxo sem sessão, origem
  do comando é registrada sem preencher artificialmente `performedBy`.
- Identidade, origem do comando, devolução, compensação, inativação, QR público, taxonomia e
  relatórios seguem FR-033–FR-048; materiais com histórico não são apagados e inativação exige
  saldo zero após liquidação autorizada/auditável.
- Relatórios distinguem entradas/saídas operacionais, devoluções, ajustes positivos/negativos,
  aberturas no período e saldos inicial/final; reconciliação inclui todos os efeitos de saldo.
- `StockReportService` calcula saldos inicial/final, entradas/saídas operacionais, devoluções,
  ajustes positivos/negativos e aberturas, com filtros e reconciliação conforme FR-032/FR-046–048.
  Somente política de fuso/limites permanece para fechamento técnico. Outbox/RabbitMQ e projeções
  Outbox/RabbitMQ e projeções MongoDB de relatórios são obrigatórios para conclusão conforme
  T048–T050; ainda não são declarados implementados. Snapshots são opcionais; Redis não
  integra o domínio de estoque.
- Preservar Controller → Service → Repository → Model e os mecanismos de autenticação da Feature
  002; nenhuma migration, model, controller ou service foi alterado nesta clarificação.
- Nomes finais de tabelas/Models, PK/FK, estratégia de serialização/locks e índices serão
  detalhados no planejamento, sem alterar migrations existentes.
- Estratégia futura para dados legados exige inventário e aprovação explícitos.
- A retirada via QR exige autorização por PIN do responsável e mantém separados autorizador,
  operador que registra e colaborador retirante; credenciais nunca vão ao ledger.
- Não define transições de OS/orçamento nem efeito automático entre esses domínios e estoque.

## Rastreamento constitucional e gates para planejamento futuro

- Constituição 2.0.0: PostgreSQL é fonte de verdade operacional; `product.quantity` é exclusivo do
  domínio legado Product e Material possui saldo canônico próprio, um por estoque. Saldo e evento
  imutável/idempotência são gravados atomicamente; correções são compensatórias e o histórico não
  é atualizado nem excluído.
- Não há migração, sincronização ou associação automática entre Product e Material. Projeções
  MongoDB são reconstruíveis dos fatos canônicos e não são fonte operacional. Outbox/RabbitMQ e
  projeções são obrigatórios para conclusão da Feature 003 conforme T048–T050; ainda pendem
  implementação e validação.
- Autorização do backend baseada em mecanismos existentes, role e `UserSector`; clientes globais e
  separados; admin global sem confundir escopo setorial com role.
- O PIN é validado no backend para autorizar a ação e identificar `authorizedBy`; não é persistido
  em texto claro nem tratado como identidade de `withdrawnBy`.
- OS e estoque permanecem independentes conforme Constituição II e decisão P09; referência textual
  não é relação nem integração.
- Mutações autenticadas por cookie requerem Origin e CSRF em adição à autorização; a leitura pública
  de QR não autentica nem autoriza comando de retirada.
- Antes de planejamento/implementação, fechar os itens listados em “Pendências para planejamento”,
  definir contratos e estratégia técnica, política de retenção e reconciliação de inventário; não
  alterar Constituição 2.0.0 ou migrations legadas.
