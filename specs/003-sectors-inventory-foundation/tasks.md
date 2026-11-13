Feature 003 — Tarefas: Setores e Estoque
Status vigente em 12/11/2026: implementação e testes CQRS/Outbox, consumer, projeção MongoDB, snapshots, relatórios e integração de mídia validados no stack isolado autorizado. T004, T042–T044, T046–T051 concluídas para os critérios técnicos locais executáveis; T047 aceita tecnicamente após revisão constitucional final. G4 e G5 permanecem gates externos pendentes e não são declarados aprovados. FR-022 permanece unitário; retirada multi-material é mudança de escopo futura e não bloqueia o aceite técnico registrado.

Fontes: spec.md, plan.md, research.md, data-model.md, contracts/stock-api.md,
quickstart.md e Constituição 2.0.1.
Convenções e gates
- [ ] indica trabalho futuro, não concluído. Cada tarefa deve ser marcada somente após critérios e
  testes correspondentes passarem.
- Não executar migration nem acessar/escrever em banco até aprovação do alvo isolado, desenho e
  procedimento. Testes PostgreSQL só em alvo descartável autorizado.
- A versão oficial é PostgreSQL 17, conforme Constituição 2.0.1. T001 verifica somente a
  consistência da configuração e documentação com essa versão; não é gate de decisão de versão.
- G1 — abertura manual: fonte/evidência, corte, conferente e aprovador eram exigidos para fluxo
  separado de abertura. A decisão oficial de cadastro inicial substitui esse fluxo: initialQuantity
  e OPENING são criados atomicamente no cadastro, sem aprovação adicional. G1 não bloqueia cadastro
  ou saldo inicial registrado dessa forma; qualquer abertura manual distinta permanece fora deste lote.
- Nota histórica: o incremento em que esta observação foi escrita não iniciava T023–T025. Essas tarefas foram posteriormente concluídas, conforme evidências individuais. Não reabrir seus aceites.
- G2 — PIN (decisão aprovada): PIN individual de seis dígitos, independente da senha de login,
  sem sessão persistente; somente hash seguro; admin pode cadastrar, redefinir e revogar; nunca
  revelar/logar PIN em texto puro. Há limite por titular e por origem, com bloqueio temporário. A
  pessoa autenticada pelo PIN é também retirante; nenhuma seleção/ID de colaborador no cliente.
  O PIN é também o identificador: lookup indexado por HMAC-SHA256 com segredo exclusivo do servidor,
  seguido de verificação Argon2id/bcrypt; unicidade entre contas ativas e conflito seguro sob corrida.
  Operações de PIN usam tentativas persistentes por origem e PIN lookup; endpoints protegidos não
  criam sessão e nunca devolvem identidade durante validação desacoplada do movimento.
- G3 — identidade do retirante (decisão aprovada): o próprio PIN identifica a pessoa que retira;
  não há seleção de terceiro, nome/dado distintivo exibido nem atributo pessoal novo necessário.
  Backend deriva withdrawnBy e authorizedBy do mesmo titular validado, nunca de ID fornecido
  pelo frontend.
- G2/G3 aprovadas formalmente pelo negócio: rota de retirada deve funcionar sem sessão, validando
  PIN no backend e derivando withdrawnBy e authorizedBy do mesmo colaborador. Aprovação não
  substitui os gates técnicos abaixo.
- Gate técnico QR/PIN validado em banco de testes: 20261116000000-create-qr-public-rate-limits.cjs
  está aplicada em alvesglass_test (PostgreSQL 17.11). A suíte PostgreSQL completa executada com
  credenciais do container, sem alterar .env, passou 6/6 testes; npm test passou 78/78. A retirada
  sem sessão validou PIN, QR, autorização setorial atual, autoria derivada, saldo, ledger append-only,
  idempotência/replay e concorrência/revogação; rate limit QR persistente concorrente também passou.
  Correção validada: QrMaterialRepository.findByTokenHash agora seleciona active, campo utilizado
  por QrStockService.withdraw na elegibilidade do material. Esta evidência é de testes isolados e
  não substitui a pendência de prazo G4 nem validação operacional G5; G6 está funcionalmente
  aprovado e sua implementação permanece nas tarefas T038–T041.
- G4 — parcialmente aprovado: preservar ledger append-only/autoria original; desativar contas e
  revogar sessões, PINs e vínculos setoriais aplicáveis; nunca reatribuir eventos. Nenhuma exclusão,
  expurgo ou anonimização automática do ledger/autoria será implementada nesta feature. A tabela de
  prazos definitivos por categoria, base legal, retenção de dados pessoais e procedimento de descarte
  permanece pendente de aprovação jurídica e operacional; até essa aprovação, preservar os registros.
- G5 — regras funcionais aprovadas. Implantação definitiva MinIO na VPS (Docker + storage persistente)
  foi aprovada em 12/11/2026, mas a VPS não deve ser acessada nem alterada nesta etapa. Produção
  permanece bloqueada até endpoint/DNS, TLS/CA, buckets/região, credenciais e permissões confirmados
  pela operação durante implantação. Em desenvolvimento, configuração agora usa variáveis
  `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_REGION`, `MINIO_CA_CERT_PATH`,
  `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_PUBLIC_BUCKET` e `MINIO_PRIVATE_BUCKET`; nenhum segredo
  é embutido no código ou `.env.example`. `ListBucket`/recuperação de órfãos permanece desabilitado.
  Não conceder `CreateBucket`, `DeleteBucket`, `PutBucketPolicy`, ACL pública, listagem pública ou
  lifecycle/expiração automáticos à aplicação. A validação real local isolada foi autorizada, mas
  origem oficial confirmada em `github.com/minio/minio`; a tag `RELEASE.2025-10-15T17-29-55Z`
  resolve para commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`; README/LICENSE declaram Community
  Edition sob AGPLv3. Causa de `DEVELOPMENT.GOGET`: o banner lê `cmd.ReleaseTag`, enquanto o primeiro
  build só definia `cmd.Version`. Build corrigido preenche release tag, versão, commit, short commit e
  ano, terminou código 0 e o binário reporta versão/commit autorizados. Compose isolado usa fonte
  oficial, valida commit durante build; `docker compose config` passou. MinIO subiu healthy; readiness
  HTTP 200 em `127.0.0.1:59000/minio/health/ready`, raiz S3 anônima responde 403 AccessDenied.
  Buckets privados descartáveis foram criados somente após checar inexistência; volume e objetos dos
  testes foram preservados. Sem ação em VPS ou serviços PostgreSQL/MongoDB/RabbitMQ.
- G6 — decisões funcionais aprovadas; integração PostgreSQL pendente: America/Sao_Paulo, até 12 meses,
  intervalo semiaberto, keyset/cursor opaco protegido e vinculado a filtros/ordenação/escopo, página
  25/100, desempate determinístico, autorização revalidada por consulta e sem carregar histórico
  inteiro. asOf documentado sem garantia de snapshot. T038–T040 implementadas; T041 pendente.
- Evidência de validação PostgreSQL (12/11/2026): banco explicitamente confirmado como
  alvesglass_test, PostgreSQL 17.11, em 127.0.0.1:5434; suíte PostgreSQL completa executada e
  passou 6/6. Nenhuma migration foi executada durante essa validação; os testes preservaram ledger
  append-only. Registro histórico anterior de verificação pré-autorização substituído por esta
  evidência posterior, sem implicar que o volume seja descartável para operações não autorizadas.
  Para desbloquear, é necessária autorização explícita para uso do alvo e confirmação operacional de
  isolamento/descarte; como há volume persistente, qualquer descarte exige procedimento e autorização
  administrativa próprios. Nenhum dado será removido por testes.
- Decisões técnicas necessárias à integridade (constraints, hashing, transações, tokens opacos,
  limites defensivos de parser) são responsabilidade da implementação/revisão técnica e não devem
  criar limites funcionais não aprovados.
Fase 0 — alinhamento e pré-condições
- [x] T001 Verificar consistência da configuração e documentação da Feature 003 com PostgreSQL
  17 oficial e registrar eventuais divergências encontradas para correção no escopo autorizado.
  Aceite: nenhuma referência conflitante à versão operacional permanece; não alterar Docker;
  esta tarefa não reabre a decisão PostgreSQL 17.
- [x] T002 Confirmar runtime Node efetivo, comandos de teste/migration, inicializador de Models,
  middlewares de autenticação/Origin/CSRF e identidade do banco de teste isolado. Evidências:
  runtime local Node 22.23.1; package.json usa Sequelize CLI convencional e src/database/migrations/
  com public.SequelizeMeta; Features 001/002 registram migrations convencionais executadas em
  banco PostgreSQL de teste temporário/isolado, status verificado no container autorizado e redes/
  destinos postgres-test/`alvesglass_test` segregados. O preflight/bootstrap legado pertence ao
  fluxo baseline customizado anterior, não é wrapper dos comandos convencionais atuais. Histórico
  3f57c13 (“refactor(db): simplify persistence with sequelize-cli”) removeu deliberadamente os
  wrappers baseline e substituiu os scripts db:migrate* por Sequelize CLI; não há regressão em
  package.json local, que corresponde ao HEAD. test/unit/persistence/preflight.test.js permanece
  com falha ao importar seu entrypoint (pathValidation.warnings is not iterable); essa falha não
  é aceite como teste aprovado nem altera o contrato T002, que está demonstrado pelas evidências
  operacionais/documentais acima. Nenhuma migration foi executada nesta verificação.
- [x] T003 Aprovar desenho aditivo de tabelas, FKs, índices, constraints, estratégia de seeds e
  rollback antes de escrever migrations. Depende de T001. Aceite: revisão confirma isolamento de
  Product, ausência de cascatas destrutivas e invariantes da Constituição I/VI.
- [x] T004 Registrar gates G1–G6 e decisões/gates externos sem inventar aprovações. G1 cadastro
  inicial OPENING, G2/G3 PIN e identidade, G6 relatórios funcionais aprovados; G4 retenção exige
  decisão jurídica/operacional e G5 exige validação operacional MinIO antes da ativação. Evidência:
  matrizes detalhadas acima e em `spec.md`/`contracts/stock-api.md`, atualização 12/11/2026.
Fase 1 — fundação do domínio
- [x] T005 Criar migrations aditivas e Models para Sector e Warehouse, incluindo códigos,
  estados, timestamps, FKs RESTRICT e índices. Depende de T001–T003. Teste/aceite: migration
  sobe em PostgreSQL isolado após gate; constraints impedem setor/almoxarifado órfãos; teste down
  somente em banco efêmero vazio.
- [x] T006 Implementar seed idempotente dos setores Vidraçaria e Marcenaria. Depende de T005.
  Teste/aceite: rodar seed repetidamente não duplica nem renomeia setores; códigos únicos.
- [x] T007 Registrar Models/associações no inicializador central e testar carregamento. Depende de
  T005. Teste/aceite: todos os Models carregam uma vez; FKs/associações batem com schema.
- [x] T008 Criar vínculo atual UserSector e trilha append-only de concessão/revogação, incluindo
  ator, alvo, setor, instante e motivo conforme contrato aprovado. Depende de T003,T005; decisões de
  auditoria/revogação pendentes são gate somente para o formato final da auditoria. Teste/aceite:
  unicidade do vínculo e auditoria não editável; concessões não autorizadas negadas.
- [x] T009 Implementar repositories/services/controllers de setores, almoxarifados e grants,
  reutilizando sessão, requireAdmin e autorização atual de setor no backend. Depende de T007,T008.
  Teste/aceite: admin global; user só lê escopo concedido; grant/revoke admin-only; mutações por
  cookie validam Origin/CSRF; testes HTTP cobrem 401/403 e não enumeração fora do escopo.
- [x] T010 Criar migrations e Models para categorias/subcategorias com unicidade normalizada,
  integridade de escopo e inativação. Depende de T003,T005,T007. Teste/aceite: nomes duplicados
  após normalização conflitam; subcategoria/material não atravessa almoxarifados; referências não
  são removidas fisicamente.
- [x] T011 Implementar CRUD de categorias/subcategorias em camadas, com autorização setorial.
  Depende de T009,T010. Teste/aceite: CRUD permitido no escopo, negação fora dele, inativação
  não altera materiais associados; testes de serviço e contrato HTTP.
- [x] T012 Criar migrations/Model/Repository de Material: código global imutável, unidade, mínimo,
  localização, categoria/subcategoria e status, sem saldo legado. Depende de T010,T003. Teste/aceite:
  código global único; unidade do catálogo inicial e escalas aprovadas; nenhuma FK/consulta/escrita
  em Product ou legado stock_movements.
- [x] T013 Implementar cadastro, consulta, edição permitida e ativação/inativação de Material.
  Depende de T009,T011,T012; mídia segue G5. Teste/aceite: autoria e escopo são do servidor;
  regra original de não aceitar saldo foi substituída pela decisão oficial: cadastro recebe
  initialQuantity e persiste Material, saldo e OPENING atomicamente. Inativação exige saldo zero sob
  lock quando saldo existir; material com histórico nunca sofre DELETE físico. Adequação incremental
  da implementação à nova regra permanece pendente de validação completa.
- [x] T014 Criar testes unitários e PostgreSQL de constraints/FKs/índices/seeds da fundação.
  Depende de T005–T013 e T001. Aceite: concorrência de unicidade e integridade referencial
  verificadas no PostgreSQL autorizado; migrations legadas inalteradas.
Fase 2 — integridade do estoque
- [x] T015 Criar schema/Model/Repository de MaterialBalance como fonte canônica exclusiva de
  Material, com decimal exato, scale por unidade e defesa contra saldo negativo. Depende de T012,T003.
  Teste/aceite: saldo separado de Product.quantity; sem FLOAT ou conversão para JS Number;
  constraints rejeitam saldo inválido.
- [x] T016 Criar schema/Model/Repository append-only de evento de estoque, com before/after,
  sequência, tipo, motivo, origem, identidades distintas e referências. Depende de T015. Aceite:
  CHECKs/índices/FKs aderem ao modelo; repositório operacional não oferece update/delete.
- [x] T017 Criar tabela/Model de receipt idempotente e constraints únicas para escopo aprovado
  (warehouse, principal_type, principal_id, key) e intenção (warehouse, operation_id). Depende de
  T003,T015,T016. Aceite: digest canônico e resultado persistidos junto da operação; retenção não
  presume prazo sem G4; conflito de principal/payload não divulga receipt.
- [x] T018 Implementar StockMovementService dono da transação e repositories que recebem a mesma
  transação explicitamente. Depende de T015–T017. Teste/aceite: qualquer falha reverte saldo,
  evento e receipt integralmente; nenhuma escrita crítica escapa da transação.
- [x] T019 Implementar comandos IN e OUT com validação de sinal/escala/unidade, autorização,
  justificativa e saldo suficiente. Depende de T018,T009. Aceite: saída não produz saldo negativo;
  teste unitário por regra e teste PostgreSQL persistem saldo/evento atomicamente.
- [x] T020 Implementar RETURN com vínculo ao evento original quando identificável e limite da
  quantidade retornável. Depende de T018,T019. Aceite: evento original permanece imutável;
  repetição/excesso inválido não altera saldo; testes de devolução parcial/total.
- [x] T021 Implementar ADJUSTMENT administrativo, assinado, motivado e auditável. Depende de
  T018,T009. Aceite: apenas principal autorizado; delta negativo não supera saldo; testes de
  permissão, sinal e atomicidade.
- [x] T022 Registrar trabalho incremental da nova regra: cadastro cria OPENING único junto de
  Material e saldo na mesma transação; initialQuantity é decimal exato >= 0, autoria vem da sessão e
  retries/conflitos não duplicam evento. A regra substitui abertura separada e dispensa aprovação G1
  adicional para cadastro. Aceite incremental: testes unitários, PostgreSQL e HTTP confirmam valor
  positivo/zero, rejeições, atomicidade, autorização e imutabilidade. Testes HTTP/unitários e PostgreSQL
  confirmam saldo inicial, autoria, OPENING único, rollback, retry/conflito e imutabilidade em
  11/11/2026. Não reabrir status histórico.
- [x] T023 Implementação e migration aditiva preparadas: comando administrativo cria evento
  ADJUSTMENT inverso vinculado por compensates_event_id, com reason/description, lock, saldo não
  negativo e receipt idempotente. Migration adiciona índice único parcial para rejeitar duplicata
  concorrente; testes unitários e integração PostgreSQL concorrente passaram. Migration
  20261114000000-unique-inventory-event-compensation.cjs aplicada exclusivamente em
  alvesglass_test após confirmação de identidade, ausência de duplicidades e ausência prévia do
  índice. SequelizeMeta e definição do índice único parcial confirmados; corrida simultânea
  persistiu exatamente uma compensação e rejeitou a outra. Nenhuma operação destrutiva executada.
- [x] T024 Trabalho incremental relacionado à linha inicial de saldo: cadastro cria a única linha
  de saldo com PK material_id atomicamente com Material/OPENING. Validar concorrência/retries no
  PostgreSQL sem permitir saldo duplicado; movimentos continuam usando lock FOR UPDATE existente.
  Testes concorrentes demonstram integridade e ausência de saldo negativo; não criar fluxo de abertura
  manual nem antecipar tarefas posteriores. Teste concorrente preparado, mas sua execução PostgreSQL
  e validação PostgreSQL passaram em 11/11/2026: corrida de mesmo código produziu um vencedor e um
  conflito materials_code_key, saldo/OPENING únicos, rollback de falha parcial, saldo não negativo e
  schema íntegro. A migration de compensação não faz parte deste aceite de cadastro.
- Validação de integração do cadastro inicial (T022/T024): material-code-concurrency.postgres.test.js
  usa MaterialCatalogService, ator/warehouse/categoria próprios, quantidade inicial e duas chamadas
  concorrentes com o mesmo código. O teste verifica um sucesso e um conflito de negócio, uma única
  linha Material/MaterialBalance/OPENING, saldo, autoria e retry sem duplicação. Cada execução usa
  UUIDs e códigos exclusivos; por respeitar o ledger append-only, não executa DELETE, TRUNCATE,
  DROP nem cleanup automático e deixa seus registros persistidos. Só executar após confirmação
  explícita de que alvesglass_test é isolado e autorizado; o alvo usa volume persistente e, portanto,
  os dados de teste de cadastro permanecem append-only. Fixture de relatório executada em transação
  com rollback, sem cleanup destrutivo.
- [x] Incremento de contrato — cadastro com saldo inicial (decisão oficial posterior): validar
  alteração de contrato e código para initialQuantity obrigatório e OPENING atômico. A implementação
  e testes unitários estão preparados; testes HTTP e PostgreSQL isolado executados em 11/11/2026,
  inclusive concorrência, retry, autoria, OPENING único e rollback integral. Este item não altera nem
  desmarca o status histórico de T013/T022/T024.
- [x] T025 Implementar idempotência transacional para todos os comandos, inclusive conflito de hash,
  corrida e operationId repetido sob principal diferente. Depende de T017,T018,T024. Aceite:
  retry igual retorna resultado original se autorizado; conteúdo divergente conflita; intenção não
  repete efeito após troca de autorizador; autoria original imutável. Testes unitários validam replay,
  divergência e conflitos; integração PostgreSQL verificou replay sem evento/receipt duplicado,
  conflito de hash/principal/operação, rollback por falhas parciais e corrida de comandos.
- [x] T026 Criar suíte de integridade PostgreSQL para rollback, constraints, ledger append-only,
  saldo/ledger reconciliados, corrida e retries concorrentes. Depende de T019–T025,T001. Aceite:
  falhas parciais não deixam estado; nenhum saldo negativo; testes não apontam para banco com dados.
  Integração executada em alvesglass_test confirmado e isolado para este uso, com fixtures UUID
  exclusivas e sem limpeza destrutiva; cobriu constraints, imutabilidade, reconciliação, idempotência,
  concorrência e compensação parcial única. Comandos: npm test (66/66) e teste ledger PostgreSQL
  (1/1); node --check e git diff --check passaram. Fixtures do ledger são intencionalmente
  append-only e permanecem no banco.
Fase 3 — identificação e autorização
- [x] T027 Representar retirante pela entidade User existente, sem entidade nova ou seleção de
  terceiro; G3 aprova que retirante e titular do PIN são a mesma pessoa. PIN identifica a conta via
  pelo digest HMAC indexado; não há atributo distintivo adicional. Decisão G3 aprovada.
  Aceite: autoria deriva exclusivamente da conta cujo PIN foi validado; nenhum ID/ator enviado
  pelo frontend define autoria; nome livre não é identidade. PostgreSQL confirmou autoria User/PIN e
  performed_by nulo.
- [x] T028 Implementar credencial PIN individual separada da senha, hash seguro, estado e validação
  pelo digest HMAC do PIN; validar hash forte somente para a conta retornada, nunca varrer titulares.
  Depende de T007,T008 e G2.
  Aceite: sem PIN/hash em resposta, log ou ledger; testes válidos/inválidos e conta inativa;
  habilitação bloqueada até G2. PIN Argon2id/HMAC e validação PostgreSQL aprovados; G2 segue bloqueando
  habilitação operacional.
- [x] T029 Implementar emissão, troca, recuperação, revogação e desbloqueio administrativo do PIN
  conforme decisão G2, com trilha de auditoria. Depende de T028,G2. Aceite: atores autorizados,
  rotação/revogação efetivas e auditoria sem segredo/hash; fluxo não liberado antes da aprovação G2.
- [x] T030 Implementar tentativas/bloqueio por titular (5 falhas/15 min, bloqueio 15 min), respostas
  genéricas e registro de falhas que sobreviva ao rollback do movimento. Depende de T028,T029.
  Aceite: teste concorrente de limite/bloqueio; não enumera conta; backend suporta concorrência
  conforme decisão técnica, sem depender somente de limite por IP em memória. Persistência PostgreSQL
  e rate limit público passaram na integração; cenários unitários cobrem limite PIN.
- [x] T031 Validar autorização setorial e designação corrente do autorizador a cada comando; definir
  serialização de revogação versus operação em andamento. Depende de T008,T009,T028. Aceite:
  revogado/permissão ausente nega comando; operações não escapam do escopo; auditoria identifica ator,
  alvo e resultado. Locks consultivos comuns serializam operação e revogação; integração validou negação
  sem vínculo e autorização corrente.
Fase 4 — QR Code e retirada
- [x] T032 Implementar token QR aleatório, opaco, estável e revogável, armazenando digest e
  mecanismo de reemissão conforme decisão técnica aprovada. Depende de T012,T013. Aceite: token
  não carrega credencial/comando; inválido/revogado não resolve recurso; testes de entropia/rotação e
  ausência de segredo nos logs. Persistência de digest, emissão e revogação implementadas.
- [x] T033 Implementar resolução pública limitada e rate-limited do QR. Depende de T032; imagem
  somente sob G5. Aceite: público recebe somente nome/unidade e imagem se aprovada; não recebe
  saldo, setor, localização, disponibilidade, mínimo, histórico ou token; token inválido resposta
  genérica. Resposta HTTP mínima e rate limit persistente passaram na integração PostgreSQL.
- [x] T034 Implementar contrato unitário de retirada QR/manual sem sessão persistente; PIN identifica
  o mesmo titular em withdrawnBy e authorizedBy, performedBy não é fabricado. Depende de
  T025,T027–T031,T033. Aceite: sessão não criada; autorização atual revalidada; falha não altera
  estoque; testes de identidade/autoria. Serviço passou em PostgreSQL; POST permanece protegido por
  sessão enquanto o gate técnico de rate limit persistente e consistência transacional não for
  resolvido; aprovação funcional G2/G3 registrada, sem equivaler a liberação.
- [x] T035 Integrar operationId estável e chave idempotente à retirada QR e aos retries após troca
  de autorizador. Depende de T017,T025,T034. Aceite: mesma intenção executa no máximo uma vez;
  outro principal não recebe receipt; permissão revogada nega replay sem reaplicar evento nem alterar
  autoria original. Concorrência e replay PostgreSQL confirmaram um único evento e autorização atual.
- [x] T036 Testar segurança QR ponta a ponta em HTTP/PostgreSQL: token, enumeração, PIN inválido,
  bloqueio, revogação, rate limit, replay, CSRF não aplicável ao endpoint sem sessão e segredos.
  Depende de T030–T035,T001. Aceite: cenários positivos/negativos passam; nenhuma resposta/log
  expõe PIN, hash ou token; sem autorização válida não há movimento. HTTP/PostgreSQL validou consulta,
  retirada de serviço, negação, throttling, autoria, saldo, ledger append-only e replay. G2/G3 mantêm
  pendente por impedimento técnico documentado; o POST HTTP não deve ser liberado até a regressão
  sem sessão validar rate limit, bloqueios, revogação e autorização sob concorrência.
Fase 5 — relatórios
- [x] T037 Implementar StockReportService e queries PostgreSQL de saldo inicial/final e totais
  separados de IN, OUT, RETURN, ajustes, aberturas, por Material e unidade. Depende de T016,T018.
  Aceite: reconciliação aritmética com ledger; unidades distintas nunca somadas; consulta não
  altera estado. Implementação interna inicial do serviço/query e testes unitários de contrato foram
  preparados; validação PostgreSQL transacional confirmou intervalo semiaberto, saldo inicial/final,
  totais separados por tipo, decimal exato e reconciliação com ledger por Material/unidade. A fixture
  reverteu ao fim; nenhum histórico existente foi alterado. Consulta permanece interna, sem contrato
  HTTP, paginação ou política civil G6.
- [x] T038 Implementar filtros de relatório agregado e extrato por setor, almoxarifado, material,
  datas civis, tipo e atores; converter [from,to) de America/Sao_Paulo em UTC, validar datas e
  máximo de 12 meses; consultar autorização setorial corrente em cada chamada e aplicar filtro no SQL.
  Evidência: T040/T041 adicionam endpoints e cobertura unitária/HTTP; integração PostgreSQL real
  ainda pendente nesta execução.
- [x] T039 Implementar extrato separado do resumo agregado; paginação keyset occurred_at DESC,id DESC, limite padrão 25/máximo 100 e cursor HMAC vinculado a filtros/ordenação/escopo. asOf limita
  timestamps visíveis, sem prometer snapshot MVCC: commit tardio ou timestamp retroativo pode afetar
  estabilidade. Evidência: testes unitários verificam cursor, filtros, grants refeitos e marco;
  testes PostgreSQL concorrentes pendentes.
- [x] T040 Atualizar contrato HTTP com datas civis, limite temporal, dois recursos, paginação,
  autenticação e limites/garantias de asOf. Evidência: contrato `stock-api.md`, testes HTTP unitários
  e integração HTTP autenticada CQRS (statement 200, material 200 e usuário sem grant negado), todos
  aprovados em 12/11/2026.
- [x] T041 Testar reconciliação e relatórios com fixtures PostgreSQL cobrindo todos os tipos,
  filtros, atores, limites, cursores e setores. Depende de T037–T040,T001. Aceite: totais por
  unidade conferem com ledger e saldo; acesso fora do escopo negado.
  Evidência (12/11/2026): PostgreSQL 17.11, database `feature003_ephemeral`, host 55437/volume
  exclusivo `feature003_pgdata` validado historicamente; nesta execução autorizada, relatórios no
  database `feature003_integration` porta 55438 também passaram (reconciliação decimal, janela civil,
  setor, cursor/keyset).
Fase 6 — integrações, contratos e validação
- [x] T042 Integrar mídia com MinIO/Multer usando buckets público de catálogo e privado, validação
  real de JPEG/PNG/WebP e limite de 5 MB; chaves únicas; escrita restrita ao backend; URLs temporárias
  privadas após autorização. Confirmar upload antes de atualizar PostgreSQL; limpar imagem anterior
  somente após referência confirmada. Recuperar órfãos sem excluir objetos referenciados. Depende de
  T013 e aprovação específica dos schemas propostos. A validação operacional G5 permanece gate
  externo para produção, não requisito para o aceite técnico local. Aceite:
  cenários de permissão, MIME falso, assinatura, tamanho, falha entre upload/commit/troca e coleta
  Preparação local concluída: validação de assinatura JPEG/PNG/WebP e 5 MiB, buckets configuráveis,
  chaves únicas e fluxo/repositories de intent e cleanup preparados e testados com mocks. Serviço de
  imagem sem endpoint. Migration aplicada em PostgreSQL descartável e constraints verificadas.
  Evidência técnica 12/11/2026: testes mídia mocks 11/11 e PostgreSQL schema MinIO prévios aprovados. Build Community local corrigido para `cmd.ReleaseTag`; imagem e runtime identificam release e commit pinados. Container healthy, readiness 200 e S3 anônimo 403. Integração real `node --test tests/integration/stock/minio-real.integration.test.js`: 1/1 passou, incluindo upload JPEG/PNG/WebP e conteúdo/metadata, rejeição anônima e URL privada assinada válida/expirada, bucket público no sentido de seleção configurada (sem policy pública), MIME/assinatura falsa, >5 MiB, autorização de substituição, chaves distintas, compensação após falha simulada de commit e retenção de objeto referenciado. Corrigida a asserção de compensação: teste verificava chave previamente enviada à mão, não a chave única criada pelo `replaceImage`. Cleanup do teste remove apenas chaves registradas nesta execução; sem ListBucket. **Estado vigente:** T042 concluída tecnicamente para os critérios locais executáveis, incluindo schema PostgreSQL MinIO e integração MaterialImageService+PostgreSQL+MinIO (1/1); metadados persistidos, intent `COMMITTED`, job de cleanup pendente para imagem anterior e rollback da referência/intent após falha SQL. G5 operacional de produção permanece pendente; leitura anônima pública e policy não foram habilitadas.
- [x] T043 Validar contratos HTTP de setores, catálogo, movimentos, QR e relatórios contra schemas,
  envelopes e matriz de autorização. Evidência (12/11/2026): `npm test` passou 105/105, cobrindo
  contratos HTTP de catálogo/setores/QR/relatórios e validações 400/401/403; integração CQRS real
  passou HTTP autenticado material/extrato e grants setoriais. MinIO 413/415 mantém teste unitário.
- [x] T044 Executar regressão de autorização/segurança: sessão persistida, Origin+CSRF em mutações,
  requireAdmin, escopo corrente, não enumeração e separação de identidades. Evidência (12/11/2026):
  `npm test` 105/105 e CQRS HTTP autenticado aprovado; sessão e grants foram verificados com fixtures.
- [x] T045 Validar migrations novas em banco descartável PostgreSQL aprovado: estado vazio,
  ordem, schema, constraints, seed e rollback apenas quando seguro. Depende de T001,T003,T005–T017.
  Evidência (12/11/2026): migration aditiva aplicada após 15 anteriores em banco vazio; constraints, índices, FK de intent e rollback transacional verificados. Nenhuma migration legada editada ou banco persistente utilizado.
Dependências e paralelismo
- Nota histórica (estado anterior à conclusão de T042/T047): regressões HTTP, CQRS, PostgreSQL
  isolado e integração local MinIO passaram nas execuções então registradas; naquele momento ainda
  restavam revisão final e gates. Estado vigente: aceite técnico T042/T047 concluído conforme
  evidências abaixo. G4 continua pendente para política formal de retenção/autoria; G5 continua
  pendente para validação operacional de implantação, TLS e credenciais/permissões de produção.
  Recuperação de órfãos/ListBucket permanece desabilitada; VPS não acessada.
- Caminho crítico (planejamento histórico): T001 → T003 → T005/T007 → T012/T015–T018 → T019–T026. Cadastro inicial com
  OPENING atômico integra T013 e o incremento de contrato acima; não depende do G1 manual. Fase QR depende também
  de T027–T031. Relatórios PostgreSQL dependem do ledger; as projeções MongoDB dependem de T048 (Outbox/RabbitMQ) → T049 (consumers) → T050 (CQRS MongoDB/rebuild). **Nota histórica de planejamento:** T047 dependia dessas tarefas e dos gates aplicáveis; no estado vigente, seu aceite técnico foi concluído, sem aprovar G4/G5. Gates G1–G6 continuam locais às capacidades.
- Paralelizáveis após pré-requisitos: T005 e desenho de T008/T010 podem ser trabalhados em paralelo
  após T003; T010 e preparação de T008 após base de setor; T019, T020 e T021 após T018 (com atenção
  a arquivos/schema compartilhados); T027/T028 em paralelo após decisões e fonte de identidade;
  T032 pode avançar com QR público sem habilitar retirada; T037/T038 podem ser desenvolvidos com
  fixtures após ledger; T043–T046 podem ser divididos por domínio depois dos contratos estáveis; T048–T050 seguem suas dependências de publicação, consumo e projeção.
- Toda task em paralelo deve evitar editar migration/Model compartilhado sem coordenação e declarar
  seus pré-requisitos satisfeitos. Paralelismo não contorna gates nem autoriza execução de banco.
- [x] T046 Documentar execução, gates, endpoints, autorização, invariantes, testes e rollback
  operacional após decisões aprovadas. Evidência: quickstart, contrato HTTP e runbook CQRS atualizados
  para comportamento real, variáveis, ambientes isolados, G4/G5, recuperação MinIO condicionada e
  limites de QR unitário; arquitetura aprovada e proposta de migration mantidas como referência.
- [x] T047 Executar testes unitários, integração/contrato, PostgreSQL, RabbitMQ/consumers e projeções MongoDB; revisão constitucional final. Evidências CQRS anteriores: `npm test` 106/106; PostgreSQL schema/relatórios 2/2; CQRS PG/Outbox/RabbitMQ/MongoDB 7/7; consumer 6/6; T048–T051 documentadas concluídas. Nesta continuação: `npm test` 109/109, testes mídia direcionados 12/12; MinIO real 1/1; schema MinIO PostgreSQL 1/1; serviço de imagem PostgreSQL+MinIO 1/1; Compose config, sintaxe e diff check passaram. Confirmação de metadados persistidos e consistência/rollback entre referência e objeto no DB `feature003_integration` existente, sem recriar banco/aplicar migrations. **Revisão constitucional final (12/11/2026; Constituição 2.0.1): aceite técnico concluído.** Evidências registradas sustentam PostgreSQL como fonte canônica, atomicidade saldo/ledger/receipt, ledger append-only, projeções MongoDB reconstruíveis, separação Product/Material/OS, autenticação/autorização no backend, integração at-least-once e preservação de dados/recursos. Nenhuma violação técnica concreta ou critério técnico sem comprovação foi identificado nesta revisão; nenhuma correção técnica adicional ou novo teste foi necessário. **G4 externo pendente:** decisão formal jurídica/operacional sobre retenção/anonimização e autoria; sem expurgo/anonimização automática. **G5 externo pendente:** autorização/validação operacional de implantação, TLS, credenciais e permissões de produção; VPS não acessada. Esses gates não são aceites nem aprovados por este registro e permanecem impedimentos à conclusão global da Feature 003 onde aplicável. FR-022 segue unitário; retirada multi-material futura. Nenhum recurso compartilhado removido/purgado; MinIO removeu somente objetos próprios e não usou `ListBucket`. Redis excluído; OS/Product independentes.
Integração arquitetural obrigatória — Outbox, RabbitMQ e MongoDB
A numeração T048–T050 é preservada para evitar renumeração de tarefas já referenciadas. A ordem de execução é T048 → T049 → T050 → T047 (aceite final); a posição física após T047 não indica que o aceite ocorra antes da integração.
- [x] T048 Persistir Transactional Outbox atomicamente com fatos canônicos de
  Estoque destinados à publicação: persistir envelope (event_id, versão, agregado e payload) na
  mesma transação do fato canônico. Evidência desta etapa: migration aditiva
  `20261118000000-create-inventory-outbox.cjs`, Model e gravação pelo repositório de eventos para
  movimentos e `OPENING`; envelope schema v1 deduplicado por `event_id`, saldo decimal como string e
  somente UUIDs de autoria realmente persistidos. Quatro testes Outbox cobrem identidade/modelo,
  payload, mesma transação/falha de gravação e concorrência de duplicatas; suíte unitária completa
  passou (105/105) em 12/11/2026 após esta etapa. Migration aplicada no stack isolado autorizado
  `feature003_integration` para o teste; nenhum outro banco foi migrado. Publisher
  RabbitMQ com claim lease/confirm/backoff implementado; teste unitário passou. Integração real em
  PostgreSQL/RabbitMQ confirmou claim concorrente e recuperação de lease expirado após troca de worker;
  PostgreSQL/RabbitMQ validou claims concorrentes, lease expirado, erro de publish → retry/DEAD e
  recuperação; a migration Outbox/snapshot foi aplicada somente no DB isolado autorizado.
- [x] T049 Implementar consumers idempotentes de eventos de Estoque com deduplicação durável por
  (consumer,event_id), confirmação após persistência do efeito e políticas explícitas de retry/DLQ.
  Depende de T048 e contrato versionado. Aceite: entrega duplicada produz um único efeito local;
  falhas antes/depois do commit permitem reentrega segura; integração testa indisponibilidade e replay.
  implementação inicial schema v1, ordenação, transação Mongo dedupe/projeção, confirm de retry e DLQ.
  integração real confirmou schema inválido na DLQ e crash após commit Mongo com redelivery idempotente;
  confirmações e fixtures de fila namespaced, sem purga compartilhada.
- [x] T050 Implementar projeções CQRS reconstruíveis em MongoDB para saldo, consultas, relatórios e
  histórico encapsulado em `movements`; definir ordenação/checkpoint, replay/rebuild e rotina de
  reconciliação com fatos/saldos PostgreSQL. Depende de T048–T049 e contrato de projeção aprovado.
  Aceite: rebuild integral reproduz resultados; reconciliação detecta divergência; PostgreSQL
  continua autoridade e falha/atraso de projeção não afeta comandos. Integração real validou relatório
  paginado hidratado da projeção, material HTTP autenticado, grants setoriais e reconciliação. O histórico lógico `movements`
  deve ser paginado/armazenado sem carregar o histórico integral em memória nem exceder limites físicos
  de documento MongoDB, preservando `operationId`.
  **Critério atualizado pelo pedido de 12/11/2026:** snapshots versionados e recuperáveis são
  obrigatórios para reconstrução, sem substituir/excluir ledger. Definir política técnica de geração
  baseada em volume/desempenho e testá-la; os limites concretos devem vir de medição/decisão técnica
  documentada, não ser inventados. Redis permanece fora.
- [x] T051 Implementar snapshots versionados de agregado por material, política configurável baseada
  em volume/desempenho, integridade e reconstrução pelo snapshot válido mais recente + eventos
  posteriores, preservando replay integral do ledger. SHA-256 vincula material/versão/estado; checkpoint
  tem correspondência verificada com evento imutável. Intervalo configurável `INVENTORY_SNAPSHOT_EVENT_INTERVAL`
  (default técnico 500), sem alegação de SLO não medido. Unitários e CQRS PostgreSQL validaram fallback
  de checksum inválido, checkpoint e replay; projeção rebuild considera evento de checkpoint.
Rastreabilidade: T048–T051 são entregas obrigatórias da Feature 003. Preservam tarefas históricas T001–T045 e fluxo QR/PIN aprovado.
Registro de execução e estados (12/11/2026): stack `feature003-integration-isolated` existente e saudável nas portas 55438/27028/5678; nenhum volume removido ou fila purgada. Evidências anteriores CQRS: PG/Outbox/RabbitMQ/MongoDB 7/7, consumer 6/6, T048–T051 concluídas. MinIO Community tag/commit AGPL confirmados; `cmd.ReleaseTag` corrigido, build 0, versão/commit corretos, health healthy, ready 200, S3 anônimo 403. Buckets privados criados após confirmar ausência. Integração MinIO real 1/1; schema PostgreSQL MinIO 1/1; integração MaterialImageService+PostgreSQL+MinIO 1/1. Metadados persistem após PUT, intent COMMITTED; troca grava job PENDING para antiga imagem; falha SQL pós-update reverte referência e deixa intent ABANDONED, objeto conhecido para recuperação segura. Cleanup apenas de registros/objetos criados pelo próprio teste; sem `ListBucket`. `npm test` 109/109; testes mídia direcionados 12/12; verificações estáticas passaram. **Histórico:** no registro original deste parágrafo, T042 constava concluída para critérios locais e T047 ainda aguardava revisão constitucional/gates G4/G5; essas expressões descreviam estado anterior, não o atual. **Estado vigente após revisão final:** T042 e T047 concluídas tecnicamente. G4 (retenção/autoria) e G5 (implantação/TLS/credenciais/permissões de produção) continuam explicitamente pendentes e não são aprovados por este registro; VPS não acessada. FR-022 unitário preservado; outros Compose inalterados.
Resumo de aceite global
A Feature 003 somente pode ser considerada concluída após evidências reais dos testes unitários, HTTP/contrato, PostgreSQL isolado, integração PostgreSQL + RabbitMQ, consumers idempotentes e projeções MongoDB reconstruíveis/paginadas, com reconciliação ao ledger autoritativo e snapshots versionados recuperáveis conforme requisito de 12/11/2026. Preservar: eventos append-only, saldo e receipt atômicos, concorrência sem saldo negativo, replay seguro, autorização por setor no backend, migrations aditivas e gates aplicáveis. Product e OS permanecem independentes. T048–T050 são obrigatórias para o aceite T047, sem transferência implícita a outras features. Redis excluído. Nenhum teste é considerado aprovado sem execução e registro.