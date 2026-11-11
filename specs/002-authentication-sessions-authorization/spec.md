# Feature Specification: Autenticação, Sessões e Autorização

**Feature Branch**: `002-authentication-sessions-authorization`

**Created**: 2026-11-10

**Status**: Implementada parcialmente; contrato efetivo documentado abaixo. Merge condicionado aos gates pendentes em `tasks.md`.

**Input**: Evoluir a autenticação legada da Alves Glass API para sessões persistidas com Access Token e Refresh Token, autorização explícita e proteção dos fluxos de login. Esta spec registra o escopo desejado; a matriz efetivamente exposta é a seção “Contrato HTTP atual” ao final e prevalece até nova decisão aprovada.

## User Scenarios & Testing

### User Story 1 - Autenticar usuário interno (Priority: P1)

Como usuário interno, quero entrar com meu e-mail e senha para acessar somente as funcionalidades permitidas ao meu papel (`admin` ou `user`).

**Why this priority**: Login e autorização interna são a entrada principal para proteger os recursos da API e evitar que a identidade ou o papel sejam escolhidos pelo cliente HTTP.

**Independent Test**: Autenticar usuários internos ativos e inativos com credenciais válidas e inválidas; confirmar cookie de Access Token, identidade resultante e bloqueio de recursos administrativos para clientes e usuários sem permissão.

**Acceptance Scenarios**:

1. **Given** um usuário interno ativo com senha válida, **When** envia login com e-mail e senha corretos, **Then** recebe uma sessão autenticada com Access Token em cookie HttpOnly e não recebe o token como credencial no corpo da resposta.
2. **Given** e-mail ou senha inválidos, **When** tenta entrar, **Then** recebe resposta genérica de credenciais inválidas, sem indicação de existência da conta.
3. **Given** uma conta interna inativa, **When** apresenta credenciais corretas, **Then** a autenticação é recusada e nenhuma sessão utilizável é criada.
4. **Given** um cliente ou usuário sem papel administrativo, **When** tenta acessar um recurso administrativo, **Then** recebe resposta de acesso negado e nenhum dado protegido é retornado.
5. **Given** uma chamada pública de criação de usuário, **When** o chamador tenta definir `admin` ou outro privilégio, **Then** a API não cria uma conta administrativa nem confia no papel enviado pelo chamador.

---

### User Story 2 - Autenticar cliente por senha ou Google (Priority: P1)

Como cliente ativo, quero autenticar-me com senha ou com uma identidade Google já vinculada à minha conta e obter o mesmo tipo de sessão em ambos os casos.

**Why this priority**: Os dois métodos devem produzir a mesma identidade de cliente e as mesmas garantias de sessão, sem associação ambígua de contas.

**Independent Test**: Verificar login válido/inválido por senha e Google, rejeição de cliente inativo e ausência de vinculação automática por coincidência de e-mail.

**Acceptance Scenarios**:

1. **Given** um cliente ativo com senha válida, **When** autentica por e-mail e senha, **Then** recebe uma sessão com os mesmos controles e formato de cookies usados pelos demais logins.
2. **Given** credenciais inválidas ou uma conta cliente inexistente, **When** tenta autenticar por senha, **Then** recebe erro genérico que não revela se a conta existe.
3. **Given** um cliente inativo, **When** apresenta senha correta ou identidade Google válida, **Then** o login é recusado e nenhuma sessão é criada.
4. **Given** um cliente ativo cuja conta Google já está vinculada, **When** apresenta uma identidade Google válida para a aplicação e para aquela conta, **Then** recebe uma sessão de cliente equivalente à sessão de login por senha.
5. **Given** uma identidade Google inválida, não vinculada ou vinculada a outra conta, **When** tenta entrar, **Then** a autenticação é recusada sem criar ou vincular uma conta.
6. **Given** uma conta existente com e-mail igual ao e-mail Google, mas sem vínculo Google prévio, **When** tenta login Google, **Then** a conta não é vinculada automaticamente.

---

### User Story 3 - Manter e renovar sessões por dispositivo (Priority: P1)

Como pessoa autenticada, quero manter sessões independentes em dispositivos diferentes e renovar uma sessão sem informar novamente minha senha enquanto o refresh token for válido.

**Why this priority**: Refresh rotation permite sessões duradouras controláveis sem manter um JWT de longa duração como única credencial.

**Independent Test**: Criar sessões em dois dispositivos, renovar tokens em uma delas, tentar reutilizar o refresh anterior e confirmar que expiração/revogação de uma sessão não afeta outra.

**Acceptance Scenarios**:

1. **Given** uma autenticação válida, **When** uma sessão é criada, **Then** o Access Token JWT tem curta duração e o Refresh Token é opaco, aleatório, independente do JWT e armazenado somente como hash no PostgreSQL.
2. **Given** uma sessão válida com Refresh Token atual, **When** o cliente solicita renovação, **Then** o servidor usa uma transação PostgreSQL para verificar e rotacionar o token atomicamente, persistindo somente hashes e emitindo novo Access Token e novo Refresh Token sem estender a expiração absoluta da sessão.
3. **Given** qualquer Refresh Token anteriormente rotacionado durante a validade da sessão, **When** ele é apresentado novamente, **Then** a evidência persistida permite detectar o reuse e revogar a sessão afetada; o token reutilizado não emite credenciais.
4. **Given** duas sessões do mesmo principal em dispositivos diferentes, **When** uma sessão é renovada ou revogada, **Then** a outra permanece utilizável até sua própria renovação, expiração ou revogação.
5. **Given** uma sessão expirada ou revogada, **When** seu Access Token ou Refresh Token é apresentado, **Then** o acesso é recusado.
6. **Given** um Access Token ainda não expirado cuja sessão foi revogada, **When** é apresentado a uma rota protegida, **Then** o servidor consulta a sessão persistida e recusa o acesso imediatamente.

---

### User Story 4 - Encerrar sessão e proteger requisições com cookies (Priority: P1)

Como pessoa autenticada, quero encerrar uma sessão e ter suas credenciais invalidadas; como pessoa usuária da API, quero que requisições autenticadas baseadas em cookies sejam protegidas contra CSRF.

**Why this priority**: Cookies são enviados automaticamente pelo navegador; logout, revogação e verificação de origem são necessários para que o transporte por cookie seja seguro.

**Independent Test**: Encerrar uma sessão, tentar reutilizar seus tokens, enviar mutações com origem não permitida e verificar atributos coerentes de cookies em diferentes ambientes.

**Acceptance Scenarios**:

1. **Given** uma sessão autenticada, **When** o titular solicita logout, **Then** a sessão persistida é revogada e os cookies correspondentes são expirados com atributos compatíveis com os usados na criação.
2. **Given** um logout concluído, **When** Access Token ou Refresh Token daquela sessão é reutilizado, **Then** o acesso é recusado, inclusive antes da expiração natural do JWT.
3. **Given** uma mutação autenticada por cookie originada de origem não permitida ou sem a prova CSRF exigida, **When** chega à API, **Then** é recusada sem alterar dados.
4. **Given** uma origem frontend aprovada, **When** realiza requisição autenticada conforme o mecanismo CSRF definido, **Then** a API aceita a origem e aplica as credenciais de forma compatível com a política de cookies.
5. **Given** execução em produção HTTPS, **When** uma sessão é criada, **Then** os cookies são `HttpOnly` e `Secure`, com `SameSite`, `Path`, `Domain` e validade centralizados conforme a topologia aprovada.

---

### User Story 5 - Aplicar limites e proteger credenciais de senha (Priority: P1)

Como operador da API, quero limitar tentativas de autenticação e usar hashes de senha modernos para reduzir abuso e proteger credenciais armazenadas.

**Why this priority**: Endpoints de autenticação são expostos a tentativa automatizada; senha armazenada deve usar o algoritmo aprovado desde a criação, sem migração destrutiva de contas.

**Independent Test**: Exceder o limite de tentativas e receber HTTP 429; criar e verificar senhas com Argon2id; confirmar que logs e respostas não expõem senha, tokens ou segredos.

**Acceptance Scenarios**:

1. **Given** um endpoint de autenticação que atingiu o limite configurado, **When** recebe nova tentativa dentro da janela de bloqueio, **Then** responde HTTP 429 e não executa uma nova autenticação.
2. **Given** uma senha recebida em um fluxo coberto por esta feature, **When** é persistida, **Then** somente um hash Argon2id é armazenado; a senha em texto claro não é persistida nem registrada.
3. **Given** um hash Argon2id persistido, **When** a senha correta ou incorreta é verificada, **Then** somente a senha correta autentica.
4. **Given** qualquer fluxo de login, refresh ou logout, **When** produz logs ou erros, **Then** Access Tokens, Refresh Tokens, cookies, senhas e segredos não aparecem nos registros nem nas respostas.
5. **Given** falha de login por conta inexistente, conta inativa ou senha incorreta, **When** a API responde, **Then** a mensagem não permite distinguir a existência da conta.

---

## Requirements

### Functional Requirements

- **FR-001**: O sistema MUST autenticar `User` por e-mail e senha, mantendo os papéis existentes `admin` e `user`.
- **FR-002**: O sistema MUST autenticar `Client` por e-mail e senha sem tratar clientes como usuários internos.
- **FR-003**: O sistema MUST recusar autenticação de usuários internos e clientes inativos, inclusive durante renovação quando a conta estiver inativa.
- **FR-004**: O sistema MUST autenticar por Google somente clientes ativos cuja conta já possua vínculo Google válido. MUST validar a identidade Google, não criar contas e não vincular automaticamente por e-mail.
- **FR-005**: Login por senha e login Google de cliente MUST criar sessões pelo mesmo mecanismo de sessão persistida.
- **FR-006**: O sistema MUST emitir Access Token JWT de curta duração e MUST validar assinatura, expiração e vínculo com uma sessão ativa em cada requisição protegida.
- **FR-007**: Access Token MUST ser transportado em cookie HttpOnly e MUST NOT ser retornado como credencial principal no corpo da resposta.
- **FR-008**: O sistema MUST emitir Refresh Token opaco, aleatório e independente do JWT; somente hashes MUST ser persistidos em PostgreSQL. A sessão e seu Refresh Token MUST expirar absolutamente em 7 dias desde a autenticação inicial; rotação não estende esse prazo e não há expiração adicional por inatividade nesta versão.
- **FR-009**: A renovação MUST ocorrer atomicamente em transação PostgreSQL, serializando operações concorrentes para uma mesma sessão. MUST invalidar o token atual e detectar a apresentação de qualquer token anteriormente rotacionado durante a validade da sessão. Hashes de evidência de todos os tokens rotacionados MUST ser retidos até a expiração absoluta da sessão e eliminados depois; tokens em texto claro MUST NOT ser armazenados.
- **FR-010**: Sessões MUST ser independentes por dispositivo, persistidas no PostgreSQL e manter a separação de identidade entre `User` e `Client`. Proposta preferencial para planejamento: `user_id` e `client_id` tipados, cada um com FK real para sua entidade, ambos anuláveis e constraint XOR que exija exatamente uma referência; validar compatibilidade com schema, constraints e ciclo de migrations no planejamento.
- **FR-011**: O sistema MUST recusar sessões expiradas ou revogadas e MUST permitir revogação imediata do Access Token consultando a sessão persistida associada.
- **FR-012**: Logout MUST revogar a sessão correspondente no PostgreSQL e expirar seus cookies com atributos compatíveis com os de criação.
- **FR-013**: O backend MUST aplicar a matriz registrada em `Authorization Decisions`, validando tipo de principal, papel e ownership; MUST NOT confiar em identidade ou propriedade enviadas pelo cliente HTTP.
- **FR-014**: Uma requisição pública MUST NOT criar usuário com papel `admin` nem aceitar do cliente HTTP a atribuição de privilégio administrativo. Esta feature MUST NOT adicionar novos fluxos de cadastro.
- **FR-015**: Senhas criadas ou alteradas nos fluxos incluídos MUST ser armazenadas com Argon2id e verificadas com Argon2id. A feature MUST NOT executar migração progressiva de hashes bcrypt nem apagar dados automaticamente.
- **FR-016**: A aplicação MUST centralizar atributos dos cookies de autenticação: nome, `HttpOnly`, `Secure`, `SameSite`, `Path`, `Domain` e expiração.
- **FR-017**: Requisições autenticadas que alterem estado MUST usar proteção CSRF apropriada a cookies, além de política explícita de validação de `Origin`; CORS isoladamente MUST NOT ser considerado proteção CSRF.
- **FR-018**: Login por senha MUST limitar inicialmente a 5 tentativas por IP em cada janela de 15 minutos; login Google, 10 tentativas por IP por 15 minutos; refresh, 30 requisições por IP por 15 minutos. MUST responder HTTP 429 ao exceder o limite. A primeira versão MUST usar armazenamento em memória somente enquanto a API operar em uma única instância; a limitação entre múltiplas instâncias deve ser documentada e não pode ser apresentada como limite global.
- **FR-019**: PostgreSQL MUST ser a fonte de verdade para sessões, hashes de Refresh Tokens, expiração e revogação. A validação de cada requisição protegida MUST consultar o estado da sessão persistida para aplicar revogação imediata. Esta feature MUST NOT introduzir Redis, MongoDB ou infraestrutura adicional.
- **FR-020**: Regras de autenticação e sessão MUST permanecer desacopladas dos detalhes de persistência, preservando Controller → Service → Repository → Model quando aplicável; a separação MUST ser pragmática e MUST NOT introduzir interfaces ou abstrações sem necessidade demonstrável.


## Authorization Decisions

- `admin`: acesso administrativo completo, incluindo gestão de usuários internos e clientes.
- `user`: pode criar, consultar e atualizar clientes, sem permissão para excluí-los; pode executar CRUD de estoque, categorias, pedidos e orçamentos; pode gerenciar movimentações de estoque e etapas de produção.
- `client`: pode consultar e atualizar somente os próprios dados autorizados e consultar somente os próprios pedidos e orçamentos. Não acessa recursos administrativos nem dados de outros clientes.
- Identidade, tipo de principal (`User` ou `Client`), papel e ownership são determinados e validados no backend; a API não confia em ator, papel ou propriedade enviados pelo frontend.
- Requisições públicas não podem atribuir privilégio administrativo; criação de usuário interno exige ator autorizado conforme o fluxo administrativo existente.

### Non-Functional Requirements

- **NFR-001**: PostgreSQL MUST permanecer fonte de verdade para sessões, refresh hashes, expiração e revogação.
- **NFR-002**: Verificação de sessão persistida MUST ocorrer em toda requisição protegida para satisfazer revogação imediata de Access Token.
- **NFR-003**: Operações de emissão, renovação, detecção de reuse e revogação MUST preservar consistência concorrente no PostgreSQL; duas renovações concorrentes do mesmo token não podem produzir duas sessões válidas.
- **NFR-004**: Hashes de refresh token MUST ser calculados de modo determinístico para comparação e MUST NOT permitir recuperar o token original; a entropia do token deve vir de gerador criptograficamente seguro.
- **NFR-005**: Em produção HTTPS, cookies de autenticação MUST usar `Secure` e `HttpOnly`. Valores de `SameSite`, `Domain`, `Path` e origens permitidas MUST corresponder à topologia frontend/API aprovada.
- **NFR-006**: Parâmetros de Argon2id MUST usar configuração segura e consistente, sem armazenar parâmetros fornecidos pelo cliente. A configuração inicial proposta é 19 MiB, 2 iterações e paralelismo 1; a confirmação final MUST considerar medição de latência e carga no ambiente-alvo antes de planejamento da implementação.
- **NFR-007**: A operação MUST preservar a separação entre `User` e `Client`, sem permitir colisão de identificadores entre tipos de principal para fins de autorização ou sessão.
- **NFR-008**: Regras de autenticação e sessão MUST permanecer desacopladas dos detalhes de persistência, respeitando pragmaticamente Controller → Service → Repository → Model. MUST NOT criar interfaces, camadas ou abstrações genéricas sem necessidade demonstrável.
- **NFR-009**: Regras de autenticação, autorização, CSRF, rotação, concorrência de refresh e rate limiting MUST ser verificáveis por testes automatizados. Persistência, constraints e concorrência MUST ser cobertas por testes de integração com PostgreSQL.
- **NFR-010**: A implementação MUST manter diagnósticos operacionais úteis sem registrar material secreto ou credenciais.
- **NFR-011**: Controles de autenticação e autorização MUST proteger a confidencialidade dos dados pessoais e prevenir exposição de dados de terceiros; respostas devem limitar-se aos campos necessários e autorizados.
- **NFR-012**: Logs e respostas MUST NOT expor senhas, hashes de credenciais, Access Tokens, Refresh Tokens, cookies ou segredos. Dados pessoais não necessários para autenticação, autorização, resposta ou diagnóstico MUST NOT ser expostos.

## Key Entities

- **User**: usuário interno existente, com identificador, e-mail, hash de senha, estado ativo/inativo e papel `admin` ou `user`.
- **Client**: cliente existente, com identificador, e-mail, hash de senha, estado ativo/inativo e vínculo Google opcional já estabelecido.
- **Authentication Session**: sessão persistida no PostgreSQL comum a exatamente um `User` ou um `Client`, com identificador próprio, estado de validade/revogação, criação e expiração absoluta em sete dias e datas necessárias para auditoria. Proposta preferencial: FKs tipadas `user_id`/`client_id` e constraint XOR, a validar no planejamento.
- **Refresh Token Rotation Record**: hash não reversível de cada Refresh Token rotacionado, associado à sessão e retido até sua expiração absoluta, para detectar replay de qualquer token anterior sem armazenar credenciais em claro.

## Assumptions

- A aplicação usa ambiente local descartável para as validações desta feature; o estado de produção não foi verificado.
- O frontend não está neste repositório; compatibilidade do consumidor deve ser verificada antes de release.
- Access Token e Refresh Token serão usados em cookies, salvo decisão explícita de contrato diferente; nenhum token será exposto como credencial principal no corpo HTTP.
- A conta Google já vinculada é identificada pelo vínculo persistido atual, sem inferência por e-mail.
- O identificador de principal da sessão precisará incluir o tipo (`User` ou `Client`) porque as entidades e seus espaços de identificador permanecem distintos.
- Não serão apagadas contas, sessões ou dados automaticamente durante implantação ou autenticação.

## Dependencies and Constraints

- Depende da Constituição em `.specify/memory/constitution.md`, especialmente sessões seguras, autorização no backend, não exposição de segredos e testes de segurança.
- Depende de PostgreSQL 16/Sequelize 6; schema evolui pelo Sequelize CLI convencional em `src/database/migrations/` com `public.SequelizeMeta`.
- PostgreSQL é a fonte de verdade para sessões, hashes, expiração e revogação. Não será introduzida infraestrutura de persistência adicional nesta feature.
- Contrato do frontend e validação Google externa real permanecem pendentes.
- Não inclui infraestrutura de Redis, broker, e-mail ou novos serviços.

## Out of Scope

- Exclusão da própria conta pelo cliente, atendimento aos direitos dos titulares, retenção e anonimização serão tratados em feature específica de privacidade e gestão de clientes, observando a LGPD.
- Cadastro de novos usuários/clientes, convites, ativação de contas por e-mail e criação de administrador.
- Recuperação ou redefinição de senha.
- Vinculação inicial de contas Google ou associação automática por e-mail.
- Endereços, estoque, ordens de serviço e refatoração geral da API.
- RabbitMQ, envio de e-mails, Redis, microsserviços, CQRS, deploy e mudanças de infraestrutura.
- Migração progressiva de bcrypt para Argon2id e exclusão automática de dados existentes.

## Decisões e limites registrados

- A autorização independente de `admin`, `user` e `client` segue a matriz em `Authorization Decisions`; autorização para cada recurso deve ser verificada no backend.
- Access Token JWT: validade de 15 minutos.
- Refresh Token: validade de 7 dias; a sessão tem expiração absoluta de 7 dias desde o login, não estendida pela rotação, sem prazo adicional de inatividade inicialmente.
- Logout padrão: revoga somente a sessão atual.
- Reutilização de Refresh Token já rotacionado: revoga somente a sessão afetada, sem revogar outras sessões independentes do mesmo principal.
- Refresh Token: opaco, gerado por fonte criptograficamente segura; somente hash persistido no PostgreSQL.
- Revogação imediata: toda requisição protegida consulta o estado persistido da sessão associada ao Access Token.
- Rate limiting: login por senha, 5 tentativas/IP/15 minutos; login Google, 10 tentativas/IP/15 minutos; refresh, 30 requisições/IP/15 minutos. Armazenamento inicial em memória somente com uma instância da API.
- Argon2id: 19 MiB, 2 iterações e paralelismo 1 são parâmetros iniciais propostos; a confirmação depende de benchmark no ambiente-alvo. Não há migração progressiva de hashes bcrypt.
- User e Client permanecem entidades distintas, usando a estrutura comum de sessões com tipo de principal explícito.
- A persistência MUST manter hash de evidência de cada Refresh Token rotacionado até a expiração absoluta da sessão, de modo que qualquer token histórico possa ser reconhecido; a forma de armazenamento (por exemplo, tabela de registros vinculada à sessão) será definida no planejamento sem criar abstrações de aplicação desnecessárias.
- Google: autenticar apenas Client ativo previamente vinculado e validar a identidade pelo `sub` Google, além de validar emissor/audience/assinatura/validade do token. Não vincular pelo e-mail.
- `/createUser`: somente usuário interno autenticado com papel `admin` pode criar usuário; papel administrativo nunca é aceito de uma requisição pública.
- Topologia aprovada: frontend de produção `https://alvesglass.com.br`; API de produção `https://api.alvesglass.com.br`; desenvolvimento `http://localhost:5173` (frontend) e `http://localhost:3000` (API). Cookies host-only (sem `Domain`), `SameSite=Lax`, `Secure` em produção HTTPS; CORS somente para essas origins explícitas, com credenciais.
- Login Google: manter `/google-session` se o contrato existente puder ser corrigido com segurança; não criar rota substituta sem necessidade demonstrada.
- Mutações autenticadas por cookie exigirão validação de `Origin` contra a allowlist exata e token CSRF vinculado à sessão, enviado em header não simples; CORS não substitui esses controles. A implementação deve definir emissão/validação e teste do token CSRF sem expor segredos em logs.

## Contrato HTTP efetivamente registrado

| Rota | Identidade/papel atual |
|---|---|
| `POST /session/user`, `/session/client`, `/google-session` | Público para autenticação do tipo correspondente |
| `POST /session/refresh` | Access JWT assinado + refresh cookie, Origin e CSRF válidos; limitações por IP |
| `POST /session/logout` | Se houver sessão: Origin e CSRF válidos; revoga a sessão do Access JWT; limpa cookies |
| `GET /check-auth` | User ou Client com sessão ativa |
| `POST /createUser`, `GET /user/all`, `POST /budged` | User admin |
| `PUT /user/:id` | Guard exige User admin e `:id` igual ao próprio ID; controller atualiza o ID autenticado |
| `POST /client`, `GET /client/all`, `PUT /client/:id` | User admin |
| `GET /client/me`, `GET /order/me` | Client; consultas usam o ID autenticado e filtram pelo titular |
| `POST /order`, `GET /order/all`, `PATCH /order/:id`, `PATCH /orders/:id/products` | User admin |

Papel/tipo sem permissão retorna 403; sessão ausente/inválida em rota protegida retorna 401.
Limites por 15 minutos: User e Client por senha 5, Google 10, refresh 30; 429 inclui `Retry-After`.
Rate limiter é memória local a um processo.

## Decisões ainda pendentes/limitações

1. Confirmar que origens/cookies implementados correspondem ao deployment e frontend reais antes de release.
2. Confirmar o contrato consumido pelo frontend para login User/Client/Google, refresh e logout; o frontend não está neste repositório.
3. Definir orçamento de latência/capacidade Argon2id para produção. O ambiente local não representa os limites do container de produção.

## Registro histórico da investigação (não é estado atual)

> As observações abaixo foram feitas antes da implementação. Para o estado vigente, prevalecem
> “Contrato HTTP efetivamente registrado” e `tasks.md`.

- Fluxos legados de login foram substituídos por cookies de sessão documentados no contrato atual acima.
- Google externo depende de validação de ID token com `GOOGLE_CLIENT_ID`; a integração com provedor real ainda não foi validada nesta rodada.
- Não há frontend no repositório. A API já habilita CORS com credenciais, mas sua allowlist atual inclui origins locais e não inclui os domínios de produção aprovados; portanto, o código não prova que o frontend envia cookies (`credentials: include`/`withCredentials`) nem qual JSON consome.
- Matriz planejada originalmente não é a matriz implementada. Use exclusivamente a tabela “Contrato HTTP efetivamente registrado” até os endpoints/papéis futuros serem implementados e testados.
- Integridade referencial proposta: sessão no PostgreSQL com `user_id` e `client_id` nullable, FKs reais e CHECK XOR exigindo exatamente um principal. Preserva os modelos separados sem FK polimórfica. A proposta é preferencial, sujeita à validação de compatibilidade no planejamento; não implica adoção de tabela base de identidade.
- Detecção de reuse: persistir hashes de evidência de cada Refresh Token rotacionado, sem armazenar valores em claro, até a expiração absoluta da sessão. A rotação e gravação da evidência devem ocorrer em transação PostgreSQL, serializando por sessão (por exemplo, lock de linha ou atualização condicional); apresentação de qualquer hash rotacionado revoga a sessão. A implementação deve impedir que duas requisições concorrentes consumam o mesmo token como duas rotações válidas.
- Argon2id está instalado e tem testes de hash/verificação; benchmark no container e orçamento de produção continuam pendentes.
- Os detalhes de ferramentas Spec Kit não são contrato funcional desta feature.

## Critérios originalmente propostos (não equivalem a evidência de conclusão)

- `admin` tem acesso administrativo completo, incluindo gestão de usuários internos e clientes.
- `user` pode criar, consultar e atualizar clientes, mas não excluí-los; pode executar CRUD de estoque, categorias, pedidos e orçamentos, e gerir movimentações de estoque e etapas de produção.
- `client` pode consultar e atualizar somente os próprios dados autorizados e consultar somente os próprios pedidos e orçamentos.
- A suíte automatizada verifica login válido/inválido de `User` e `Client`, login Google válido/inválido e rejeição de contas inativas.
- Tokens expirados, sessões expiradas e sessões revogadas são recusados; sessão revogada invalida imediatamente o Access Token ainda não expirado.
- Access Token JWT expira em 15 minutos; Refresh Token e sessão expiram absolutamente em 7 dias desde o login, sem extensão por rotação ou timeout adicional por inatividade inicialmente.
- Renovação válida consulta e altera o estado da sessão em PostgreSQL, rotaciona o Refresh Token atomicamente e mantém hashes de todos os tokens rotacionados até a expiração absoluta; reuse de qualquer um deles revoga a sessão.
- Duas renovações concorrentes com o mesmo Refresh Token não podem resultar em duas rotações aceitas; os testes de integração verificam serialização/transação PostgreSQL.
- Revogação persistida invalida imediatamente Access Tokens ainda não expirados nas rotas protegidas.
- Revogar uma sessão de dispositivo não encerra outra sessão independente; logout invalida a sessão selecionada.
- `admin` tem acesso administrativo completo, incluindo gestão de usuários internos e clientes; `user` pode gerir clientes sem excluí-los, executar CRUD de estoque, categorias, pedidos e orçamentos, e gerir movimentações de estoque e etapas de produção.
- `client` pode consultar/atualizar somente os próprios dados autorizados e consultar somente os próprios pedidos e orçamentos; tentativas de acessar ou alterar dados de outra conta são negadas pelo backend.
- `User` e `Client` permanecem identidades separadas; clientes não acessam recursos administrativos ou dados de outros clientes; cadastro público não cria `admin`.
- Rate limiting responde HTTP 429 após o limite definido e falhas de autenticação não revelam existência ou estado da conta.
- Cookies seguem política centralizada; produção usa `HttpOnly` e `Secure`; mutações sem validação CSRF/Origin aprovada são rejeitadas.
- Senhas novas/alteradas são armazenadas como Argon2id e verificadas corretamente; não ocorre migração automática nem exclusão de dados.
- Logs e respostas não contêm senhas, hashes, tokens, cookies ou segredos; dados pessoais não necessários à resposta ou ao diagnóstico não são expostos.
- Testes de integração verificam FKs reais e constraint XOR proposta (se validada no planejamento), transações PostgreSQL, histórico hash-only de todos os tokens rotacionados, concorrência, revogação imediata e isolamento entre sessões e entre `User`/`Client`.

> Para matriz efetiva, limitações e status de validação, consultar “Contrato HTTP efetivamente
> registrado” acima e `tasks.md`. Itens desta lista sem teste/evidência registrados permanecem
> pendentes; não são declarações de que os cenários foram executados.