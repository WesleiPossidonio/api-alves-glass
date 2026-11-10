# Feature Specification: Fundação Técnica e Reconstrução da Persistência

**Feature Branch**: `001-rebuild-persistence-foundation` (nenhum hook de criação de branch está configurado)

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: "Reconstruir a fundação arquitetural e a persistência da Alves
Glass API, com baseline PostgreSQL isolado, camadas explícitas, configuração validada,
transações e infraestrutura de testes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preparar um banco de desenvolvimento limpo (Priority: P1)

Como pessoa responsável pela plataforma, quero inicializar um ambiente de desenvolvimento isolado
a partir de um baseline de persistência canônico para que a equipe possa começar novos domínios sem
herdar inconsistências de schema ou histórico de migrations anterior.

**Why this priority**: Sem um baseline reproduzível, não é seguro implementar ou validar qualquer
domínio novo.

**Independent Test**: Pode ser testada criando um ambiente de desenvolvimento vazio, executando o
processo oficial de migrations e verificando que o schema esperado, as constraints e o registro de
migrations são produzidos sem usar o banco legado.

**Acceptance Scenarios**:

1. **Given** um ambiente de desenvolvimento isolado sem schema da aplicação, **When** o baseline
   aprovado é aplicado, **Then** o schema canônico é criado integralmente e o processo registra
   quais migrations foram executadas.
2. **Given** um banco que contém histórico de migrations legado, **When** alguém tenta usar o novo
   baseline, **Then** o processo identifica que o histórico existente exige uma estratégia
   explícita, em vez de assumir que uma nova pasta de migrations resolve a divergência.
3. **Given** o banco original contém dados, **When** não houver aprovação explícita para
   preservá-los, **Then** nenhum dado do banco original é alterado, removido ou carregado pelo
   fluxo padrão de rebuild limpo.
4. **Given** uma operação de rebuild que possa destruir schema ou dados, **When** o processo é
   iniciado, **Then** ele identifica explicitamente o ambiente e o banco de destino e confirma
   que ambos pertencem ao ambiente isolado de desenvolvimento antes de executar a operação.
5. **Given** ambiente, banco de destino ou vínculo entre ambos ambíguo, **When** é solicitada uma
   operação destrutiva de rebuild, **Then** o processo recusa a execução e não utiliza o banco
   original automaticamente como destino.
6. **Given** uma migration fica parcialmente aplicada por interrupção ou falha, **When** alguém
   tenta retomar o processo, **Then** a migration não é marcada como concluída nem repetida até que
   o estado efetivo do schema e do histórico seja verificado e uma recuperação explícita,
   documentada e segura seja escolhida.
7. **Given** um banco isolado já inicializado, **When** o modo `status` recebe observação autenticada
   e estritamente não destrutiva com identidade autorizada, metadata canônica qualificada, histórico
   completo e schema consistente, **Then** retorna `already-current` sem executar CLI, bootstrap,
   DDL ou migrations.
8. **Given** a observação de um banco inicializado é ausente, ambígua ou incompleta, **When** é
   solicitado `status`, **Then** o processo retorna `blocked`, não infere atualidade e não transforma
   a consulta em autorização para `apply`.

---

### User Story 2 - Executar operações persistentes com integridade (Priority: P1)

Como desenvolvedor de casos de uso, quero um contrato claro para transações e repositórios para
que operações que alteram estruturas relacionadas sejam concluídas integralmente ou desfeitas sem
deixar dados parciais.

**Why this priority**: A integridade transacional é requisito constitucional e reduz erros de
consistência entre entidades relacionadas.

**Independent Test**: Pode ser testada por um caso de uso de prova que grava múltiplos registros,
força uma falha controlada e comprova que nenhuma alteração parcial permanece; em caso de sucesso,
todos os registros previstos ficam consistentes.

**Acceptance Scenarios**:

1. **Given** um caso de uso que altera duas ou mais estruturas relacionadas, **When** todas as
   validações e gravações são concluídas, **Then** as alterações são persistidas como uma única
   unidade atômica.
2. **Given** uma falha de persistência após a primeira alteração de uma operação atômica, **When**
   o caso de uso é encerrado, **Then** todas as alterações daquela unidade são revertidas.
3. **Given** um caso de uso transacional, **When** ele chama múltiplos repositórios, **Then** todos
   usam o mesmo contexto transacional e nenhum repositório inicia ou confirma uma unidade paralela
   sem autorização do caso de uso.

---

### User Story 3 - Operar a aplicação com configuração confiável (Priority: P2)

Como pessoa responsável pela operação local, quero que a aplicação valide sua configuração antes
de aceitar trabalho para que credenciais ausentes, ambiente inválido ou conexão indisponível sejam
detectados de forma previsível e sem exposição de segredos.

**Why this priority**: Configuração dispersa e inicialização implícita tornam falhas de ambiente
difíceis de diagnosticar e podem produzir comportamento inseguro.

**Independent Test**: Pode ser testada iniciando a aplicação em ambientes de teste com configuração
válida, variável obrigatória ausente e conexão indisponível, verificando respectivamente sucesso,
falha descritiva sem segredo e encerramento controlado.

**Acceptance Scenarios**:

1. **Given** todas as configurações obrigatórias válidas, **When** a aplicação é iniciada,
   **Then** os recursos obrigatórios são inicializados em ordem definida e a aplicação fica pronta
   para receber trabalho.
2. **Given** uma configuração obrigatória ausente ou inválida, **When** a aplicação é iniciada,
   **Then** ela falha antes de atender requisições e informa qual configuração é inválida sem
   revelar valores sensíveis.
3. **Given** uma falha durante a inicialização de um recurso, **When** a aplicação encerra,
   **Then** recursos já iniciados são liberados de modo controlado e a falha fica registrada de
   forma estruturada.

---

### User Story 4 - Confiar na fundação por meio de testes repetíveis (Priority: P2)

Como pessoa revisora técnica, quero uma infraestrutura de testes isolada para provar migrations,
constraints, transações, rollback e inicialização antes que domínios de negócio sejam construídos
sobre a fundação.

**Why this priority**: O projeto não possui suíte de testes configurada; a fundação não pode ser
aceita apenas por compilação ou inspeção manual.

**Independent Test**: Pode ser testada executando a suíte de fundação contra ambiente isolado e
confirmando que cada execução começa sem dados residuais e produz o mesmo resultado verificável.

**Acceptance Scenarios**:

1. **Given** um ambiente de teste isolado, **When** os testes de migrations são executados,
   **Then** eles comprovam criação limpa, aplicação ordenada, constraints e compatibilidade com os
   Models do baseline, incluindo tipos e identificadores, primary keys, foreign keys,
   nullability, unicidade, índices, associações e cardinalidades contra PostgreSQL real.
2. **Given** dados criados por um teste, **When** o próximo teste é iniciado, **Then** ele não
   observa dados residuais nem depende da ordem de execução anterior.
3. **Given** uma alteração futura na fundação, **When** a suíte de qualidade é executada,
   **Then** testes unitários, de integração, transação, rollback, configuração e inicialização
   fornecem resultado verificável para os aspectos afetados.

### Edge Cases

- Histórico de migrations legado presente, ausente ou incompatível com o baseline novo.
- Migration parcialmente aplicada, interrompida ou registrada de forma divergente do schema.
- Identificadores incompatíveis entre estruturas relacionadas, incluindo tipos distintos ou FK sem
  constraint correspondente.
- Falha de conexão, credencial inválida, variável obrigatória ausente ou ambiente não reconhecido.
- Erro de unicidade, referência, validação ou concorrência durante uma operação transacional.
- Tentativa de executar o fluxo opcional de preservação sem inventário, backup recuperável,
  reconciliação e aprovação explícita.
- Encerramento da aplicação enquanto uma inicialização ou operação de banco falha.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A fundação MUST definir e aplicar as responsabilidades de Routes, Controllers,
  Application Services/Use Cases, Repositories, Models e infraestrutura compartilhada conforme a
  Constituição.
- **FR-002**: Routes MUST apenas compor middleware e encaminhar requisições; Controllers MUST
  tratar protocolo HTTP e validação de transporte, e MUST NOT acessar Models diretamente.
- **FR-003**: Application Services/Use Cases MUST concentrar regras de aplicação, invariantes,
  autorização quando aplicável e delimitação de transações; Repositories MUST encapsular o acesso
  a dados; Models MUST representar persistência e associações.
- **FR-004**: A fundação MUST fornecer um contrato para iniciar transações em Application
  Services/Use Cases e propagar o mesmo contexto aos Repositories envolvidos, com commit somente
  após sucesso integral e rollback diante de falha.
- **FR-005**: A fundação MUST definir tratamento previsível para erros de persistência, incluindo
  violações de integridade, conflito de unicidade, referência inválida, erro de validação e falha
  de conexão, sem expor credenciais ou detalhes sensíveis.
- **FR-006**: A reconstrução MUST criar um baseline PostgreSQL novo, coerente e versionado, com
  migrations ordenadas, rastreáveis e compatíveis com o mecanismo de execução configurado para o
  projeto.
- **FR-007**: Esta feature MUST estabelecer o mecanismo de baseline e conter somente as estruturas
  de persistência necessárias e já aprovadas para a fundação. Ela MUST NOT antecipar tabelas ou
  estruturas de clientes, usuários, orçamentos, OS ou estoque; cada domínio será definido em sua
  respectiva especificação, respeitando decisões aprovadas e pendências do plano. Estruturas de
  infraestrutura só MAY integrar o baseline quando forem estritamente necessárias à fundação e
  tiverem justificativa documentada; tabelas genéricas ou estruturas antecipadas por conveniência
  MUST NOT ser criadas.
- **FR-008**: Para cada estrutura efetivamente incluída no baseline que possua Model
  correspondente, o baseline MUST definir e validar contra PostgreSQL real a compatibilidade entre
  migrations e esse Model, cobrindo tipos e identificadores, primary keys, foreign keys,
  nullability, unicidade, índices, associações, cardinalidades e constraints de integridade. Este
  requisito MUST NOT exigir a criação de Models ou tabelas de domínio não incluídos no baseline;
  quando tais estruturas não fizerem parte da fundação, sua ausência MUST ser preservada.
- **FR-009**: A execução de qualquer operação destrutiva de rebuild MUST identificar
  explicitamente o ambiente e o banco de destino, confirmar que ambos pertencem ao ambiente
  isolado de desenvolvimento e recusar a operação quando ambiente, destino ou vínculo entre eles
  for ambíguo. O banco original MUST NOT ser selecionado automaticamente como destino.
- **FR-010**: A reconstrução MUST inventariar o schema e o histórico de migrations existentes
  antes de definir a estratégia de ativação do baseline; criar uma nova pasta de migrations MUST
  NOT ser tratado como solução automática para histórico já executado.
- **FR-011**: Quando uma migration falhar ou ficar parcialmente aplicada, o processo MUST verificar
  o estado efetivo do schema e do histórico antes de qualquer nova ação. Ele MUST NOT marcar a
  migration como concluída nem repetir sua execução automaticamente; a recuperação MUST ser
  explícita, documentada e segura.
- **FR-012**: O planejamento técnico e os testes MUST diferenciar rebuild de banco isolado a partir
  do baseline, reexecução em banco já reconstruído e tentativa de reaplicar migrations já
  registradas. Cada comportamento MUST ter resultado seguro, determinístico e verificável, sem
  confundir criação limpa com recuperação ou repetição de histórico.
- **FR-012A**: O modo `status` MUST ser observacional, autenticado e estritamente não destrutivo,
  limitado a destinos isolados autorizados. Ele MUST verificar identidade efetiva, metadata canônica
  qualificada, histórico completo do caminho canônico e consistência de schema; MUST retornar
  `already-current` somente com evidência completa, `recovery-required` para inconsistência
  comprovada e `blocked` para evidência ausente, ambígua ou insuficiente. `status` MUST NOT executar
  CLI, bootstrap, DDL, migrations, cleanup ou recovery, e seu resultado MUST NOT autorizar `apply`.
- **FR-012B**: O modo `apply` MUST preservar o preflight T012: antes de CLI, metadata técnica ou
  DDL, exige banco existente, identidade efetiva autorizada e estado comprovadamente vazio. Banco
  já inicializado não satisfaz essa condição, mesmo quando `status` retorna `already-current`.
- **FR-013**: O fluxo padrão MUST recriar apenas um banco de desenvolvimento isolado a partir do
  baseline novo e MUST NOT alterar, destruir ou migrar o banco original nem seus dados.
- **FR-014**: Preservação de dados MUST ser um fluxo opcional separado, permitido somente após
  inventário, backup recuperável, critérios de reconciliação, carga idempotente, aprovação
  explícita dos dados a manter e plano de rollback.
- **FR-015**: A fundação MUST centralizar e validar a configuração de ambiente, conexão
  PostgreSQL e aplicação antes de iniciar recursos que atendam trabalho.
- **FR-016**: Credenciais, segredos e valores sensíveis MUST ser obtidos de configuração segura,
  MUST NOT ser versionados e MUST NOT aparecer em logs, mensagens de erro ou relatórios de teste.
- **FR-017**: A inicialização MUST estabelecer ordem explícita para validar configuração, conectar
  recursos obrigatórios e expor prontidão; o encerramento MUST liberar recursos iniciados de forma
  controlada.
- **FR-018**: A fundação MUST fornecer infraestrutura de testes com testes unitários para regras
  de camada e testes de integração contra PostgreSQL real para migrations, constraints,
  transações, rollback e compatibilidade entre schema e Models.
- **FR-019**: Os testes MUST isolar e limpar dados entre execuções e MUST provar que falha numa
  operação atômica não deixa alterações parciais.
- **FR-020**: A especificação MUST permanecer limitada à fundação técnica; ela MUST NOT introduzir
  funcionalidades de autenticação, OS, estoque, Outbox, RabbitMQ ou regras de negócio pendentes.
- **FR-021**: A fundação MUST NOT introduzir MongoDB, Redis, Kafka, CQRS, microsserviços ou
  migração para TypeScript como parte desta feature.

### Non-Functional Requirements

- **NFR-001**: Um ambiente de desenvolvimento limpo MUST poder ser reconstruído repetidamente a
  partir do baseline aprovado, sem intervenção manual no schema e sem depender de dados legados.
- **NFR-002**: Falhas de configuração ou inicialização MUST impedir prontidão e resultar em
  diagnóstico estruturado, identificável e sem dados sensíveis.
- **NFR-003**: Uma falha de migration ou transação MUST resultar em estado conhecido: nenhuma
  mudança parcial é aceita como sucesso, a migration não é marcada automaticamente como concluída
  e a recuperação requerida fica identificável para o operador.
- **NFR-004**: A fundação MUST manter complexidade proporcional: novas abstrações ou componentes
  só são aceitáveis quando sua responsabilidade, benefício e custo de manutenção forem explícitos.
- **NFR-005**: Documentação de contratos de camada, configuração, execução de migrations e testes
  MUST ser atualizada quando o comportamento correspondente for alterado.

### Key Entities *(include if feature involves data)*

- **Baseline de Persistência**: conjunto canônico e versionado de migrations, Models, constraints,
  índices e regras de execução que cria o schema-alvo vazio.
- **Histórico de Migrations**: registro das migrations aplicadas em um banco específico, usado para
  determinar se o baseline pode ser aplicado ou se exige estratégia de transição explícita.
- **Contexto Transacional**: unidade de trabalho criada pelo Use Case e compartilhada com todos os
  Repositories que participam da operação atômica.
- **Configuração de Ambiente**: conjunto validado de parâmetros não sensíveis e referências
  seguras a credenciais que determinam ambiente, conexão, inicialização e encerramento.
- **Inventário de Dados e Schema**: relatório de schema, migrations, volumes, constraints,
  inconsistências e dados candidatos à preservação antes de qualquer fluxo opcional de migração.
- **Relatório de Reconciliação**: registro de contagens, mapeamentos, rejeições e divergências
  produzido apenas quando a preservação de dados for aprovada.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Em 100% de 10 execuções consecutivas do fluxo de rebuild limpo em ambiente isolado,
  o schema canônico é criado sem intervenção manual e sem dados residuais de execução anterior.
- **SC-002**: Em 100% dos testes de falha controlada de operações atômicas, nenhuma alteração
  parcial da operação permanece persistida após o encerramento.
- **SC-003**: Em 100% dos cenários de configuração obrigatória ausente, inválida ou de conexão
  indisponível, a aplicação não informa prontidão e o diagnóstico não contém segredo ou
  credencial.
- **SC-004**: A suíte da fundação detecta, em execução automatizada, ao menos um caso de cada
  classe crítica: migration inválida, constraint violada, rollback, incompatibilidade entre schema
  e Model, migration parcialmente aplicada, variável obrigatória ausente e falha de inicialização.
- **SC-005**: Uma pessoa desenvolvedora consegue identificar, a partir da documentação da
  fundação, a camada responsável por uma regra, o ponto de início da transação e o procedimento
  correto para rebuild limpo sem consultar o código legado.
- **SC-006**: Nenhuma funcionalidade de autenticação, OS, estoque, Outbox ou mensageria é criada
  ou alterada para considerar esta fundação concluída.
- **SC-007**: Em 100% dos testes de operação destrutiva, destino inválido, ambiente não isolado,
  identificação ambígua ou destino correspondente ao banco original — mesmo quando rotulado como
  desenvolvimento — impede a execução antes de qualquer alteração no schema ou nos dados.

## Assumptions

- PostgreSQL e Sequelize permanecem as tecnologias de persistência já adotadas para a fundação;
  esta especificação não aprova troca de tecnologia.
- O projeto está em reconstrução e não está em produção; rebuild limpo em banco de
  desenvolvimento isolado é o caminho padrão.
- Preservação de dados é opcional e não será executada sem a aprovação explícita definida em
  FR-014.
- A escolha concreta de biblioteca de testes, convenção exata de nomes de tabelas, estratégia de
  tipagem de identificadores e mecanismo operacional de baseline será decidida no planejamento,
  desde que cumpra os requisitos, a Constituição e o plano de saneamento.
- Decisões de negócio pendentes no plano, incluindo P01–P08 e P10–P13, permanecem fora do escopo
  e não são resolvidas por esta feature.

## Dependencies and Constraints

- Depende da Constituição em `.specify/memory/constitution.md` e das decisões aprovadas em
  `docs/audit/remediation-plan.md`.
- Depende de acesso a ambiente PostgreSQL isolado para validação de migrations, constraints,
  transações e limpeza de testes.
- A execução de qualquer preservação de dados depende de inventário, autorização explícita e dos
  artefatos de reconciliação definidos neste documento.
- Não modifica o banco original, não destrói dados e não exige janela de manutenção de produção.
- Não aprova Event Sourcing integral, CQRS completo, MongoDB, Redis, Kafka, microsserviços ou
  TypeScript.

## Failure and Recovery Scenarios

- **Migration falha antes da conclusão**: o processo MUST interromper a ativação, registrar a
  migration e o motivo, preservar evidências para diagnóstico e exigir recuperação documentada
  antes de nova tentativa. Quando houver aplicação parcial, o processo MUST comparar schema e
  histórico efetivos, sem marcar a migration como concluída nem repeti-la automaticamente.
- **Schema e histórico de migrations divergem**: o processo MUST bloquear ativação automática e
  exigir inventário e estratégia explícita; não pode marcar migrations como aplicadas sem prova de
  equivalência aprovada.
- **Falha transacional**: o Use Case MUST reverter a unidade de trabalho e retornar erro de
  persistência previsível; uma nova tentativa só pode ocorrer a partir de estado consistente.
- **Configuração inválida ou recurso indisponível**: a aplicação MUST falhar antes da prontidão,
  liberar recursos já iniciados e registrar diagnóstico sem segredos.
- **Fluxo opcional de preservação falha na reconciliação**: o cutover ou carga MUST permanecer
  bloqueado; divergências devem ser registradas com responsável e decisão de correção, exclusão
  aprovada ou retenção como exceção.