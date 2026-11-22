# T022 — execução operacional em 2026-11-17

## Fechamento das matrizes — estado vigente: G1 LIBERADO (2026-11-17)

Esta seção prevalece sobre os estados históricos de bloqueio preservados abaixo.
T007–T022 atendidos no escopo aprovado de fundação. Não autoriza iniciar T023
automaticamente. PostgreSQL17 apenas; produção continua um banco principal
compartilhado entre módulos. Nenhum endpoint/história/deploy/commit foi criado.

### Preparação, destino e evidências

Worktree/branch reconfirmados; snapshot pré-rodada em
`/tmp/feature005-t022-final-before.json`. Run `35eb2feadec9`, PostgreSQL17.11,
MinIO/bucket/usuários limitados e identidades Docker/volumes/rede autenticados pelo
runner existente. Preflight inicial:
`/tmp/feature005-t022-final-preflight.log`.
Não houve reset do banco principal, remoção de volumes ou perda de evidências.
Fixtures novas têm UUIDs próprios; cenários schema usam bancos novos exclusivos
criados pelo runner após preflight. Nenhum serviço de outro projeto foi alterado.

### Cinco matrizes e pendências anteriores

| Pendência             | Cenário real / resultado                                                                                                                                                                                                                                                                          | Evidência                                                                                       | Aceite   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| Autorização comercial | Admin global; manager setorial/revogação; cinco grants independentes/auditados; MANAGE_PERMISSIONS admin-only; self-grant/appointment/elevation negados; membership/status; READ não autor; cliente publicado próprio; concessão/revogação/operação serializadas por locks observados em pg_locks | `authorization-matrix.integration.test.js`: 6 subtestes + pai                                   | Atendido |
| Constraints/lifecycle | Texto exato/zeros/case/Unicode/setor; identidade/autoria/metadata imutáveis; revisão obsoleta; par PDF/data publicado atomicamente; estado terminal sem reanexação; FKs/slots/validade/ATTACHED deferred e rollback                                                                               | `lifecycle-matrix.integration.test.js`: 12 subtestes + pai, combinado com schema T007 existente | Atendido |
| Corridas              | Attach primeiro/cleanup primeiro; upload revisionado perde para substituição; publish/cleanup; stream shared lock vs detach/DELETE; dois executores; token vencido; executor vivo com lease expirado em transação não pode ser roubado e CAS final falha                                          | Mesmo arquivo; barreiras explícitas, pg_locks não concedidos e DB/MinIO reais                   | Atendido |
| Transporte            | Proxy HTTP local repassa requests MinIO assinados e corta sockets PUT antes/depois de commit remoto; GET/Range após bytes reais; timeout/abort e recuperação; sem referência/publicação indevida; streams/sockets fechados                                                                        | `transport-matrix.integration.test.js`: 6 subtestes + pai                                       | Atendido |
| Recursos/recuperação  | Dois qpdf/PUT concorrentes sob cgroup; terceiro qpdf recusado; falhas repetidas/timeouts; medição real; SIGKILL de executor descartável após DELETE/stat e antes de CAS PostgreSQL; restart via entrypoint worker, fencing/idempotência                                                           | `resource-pressure.integration.test.js` e `process-kill.integration.test.js`: 1 teste cada      | Atendido |

Novos arquivos de teste estão sob o caminho absoluto
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/integration/budgets/`.
Helpers novos sob
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/`:
`matrix-fixture.js`, `transport-fault.js`, `kill-executor.js`.
Runner migrated agora inclui as cinco suítes novas, sem seleção manual implícita.

### Interrupção real

Checkpoint IPC: `externalDeleteConfirmedBeforeDatabaseCAS`. O filho completou
DELETE e stat ausente reais, mantendo transação PostgreSQL aberta e claim durável
anterior CLEANING. O pai recebeu checkpoint, enviou **SIGKILL**, aguardou exit
com signal SIGKILL; PostgreSQL reverteu a transação interrompida. Registro
continuou CLEANING; após expiração explícita do lease da fixture, o entrypoint
real `run.js worker` reiniciado concluiu REMOVED por not-found, token antigo
retornou stale e nenhuma referência ficou inconsistente. Só o processo filho
descartável foi morto; PostgreSQL, MinIO e containers não foram interrompidos.
Não é a injeção de exceção da primeira rodada. A expiração foi antecipada em SQL
após morte comprovada, não é alegação de espera cronológica de2min.

### Métricas objetivas — último migrated verde

- Janela de pressão: **2321ms** (ensaio limitado, não benchmark prolongado).
- Pico amostrado memória cgroup: **194297856 bytes** (~185.3MiB).
- `memory.peak` cgroup: **212852736 bytes** (~203MiB), teto512MiB.
- Pico observado filhos qpdf: **2**; RSS qpdf observado: **9224192 bytes** (~8.8MiB).
- Temporários privados observados: **20971520 bytes** (20MiB), teto64MiB.
- 8 validações aceitas em4 rodadas; 4 recusas por concorrência; 5 timeouts
  controlados; 2 uploads reais de10MiB concorrentes.
- Recuperação posterior validada; **0 filhos e 0 temporários remanescentes**.

Métricas são picos amostrados, exceto memory.peak do kernel; não provam um limite
superior universal para todo PDF. Limites produtivos não foram enfraquecidos.
Container UID1000,512MiB/1CPU/64PIDs/read-only/tmpfs64MiB preservado.

### Defeitos encontrados e correções

1. **Corrida real no watchdog qpdf** sob pressão: `/proc` pode desaparecer antes
   de Node entregar exit/close. `linuxRssBytes` agora aceita RSS0 somente para
   zombie comprovado ou ENOENT acompanhado de ESRCH em kill(pid,0). Erro em
   processo vivo continua fail-closed. Exit/close continuam obrigatórios antes de
   apagar temporário; timeout/RSS/concorrência não foram relaxados. A suíte real
   de pressão repetida constitui regressão, além das unidades existentes.
2. **Repetibilidade do teste prefixo**: dados preservados ultrapassaram25 objetos;
   teste antigo olhava só primeira página e falhou sem alcançar fixture nova.
   Agora percorre páginas explicitamente, como o teste registry da rodada
   anterior. Nenhuma asserção removida, nenhum purge de evidências.
3. Helper proxy agora aguarda eventos close de todos os sockets antes de afirmar
   ausência de sockets órfãos; server.close isoladamente não garantia callbacks
   dos sockets já destruídos. Correção de fixture, não mudança de storage.

4. **Fixture unitária de tamanho** usava deadline100ms para copiar/hashing/ler
   10MiB sob cgroup1CPU, misturando elegibilidade de tamanho com benchmark de I/O.
   Falhou por validatorTimeout em uma reexecução; somente esse cenário recebe
   deadline de teste2000ms. Testes dedicados de timeout agregado continuam com
   seus deadlines curtos, sem mudança de limites produtivos ou asserções.
   Falha preservada em `/tmp/feature005-t022-final-unit-deadline-failed.log`;
   reexecução integral posterior70/70 e contratos5/5 verdes.

Tentativas iniciais falhas preservadas em
`/tmp/feature005-t022-final-failures-first.log`,
`/tmp/feature005-t022-final-transport.log` e
`/tmp/feature005-t021-7gg672ji/t022-ops-12f544dd8d8d/migrated.log`.
Não são contabilizadas como verdes/skips. Nenhuma migration aplicada foi editada.

### Validação final e reprodução

| Execução                 | Aprovados | Falhos | Ignorados |
| ------------------------ | --------: | -----: | --------: |
| `yarn test:budgets:unit` |        70 |      0 |         0 |
| Contratos fundação       |         5 |      0 |         0 |
| Runner fresh             |         1 |      0 |         0 |
| Runner upgrade           |         1 |      0 |         0 |
| Runner migrated completo |        57 |      0 |         0 |

Os totais Node incluem testes-pai. Somatório das execuções finais acima:134,
não confundir com número de cenários distintos nem somar tentativas repetidas.

- `/tmp/feature005-t022-final-unit.log` e `/tmp/feature005-t022-final-contract.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-12f544dd8d8d/{fresh,upgrade}.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-61762769a885/{preflight,migrated}.log`;
- `/tmp/feature005-t022-final-migrated-verified.log` (exit0);
- node --check/Prettier/git diff --check executados nos arquivos desta rodada;
  verificação final de preservação/identidades em `/tmp/feature005-t022-final-checks.log`.

Reproduzir pelos comandos já versionados: `operational-runner.py --manifest
/tmp/feature005-t021-7gg672ji/resources.json --scenario all --approve-fixtures`
(caminho absoluto do script na seção de runner abaixo). Fresh/upgrade criam novas
fixtures e não tentam migrar principal incompatível. Preflights negativos estão
na suíte bootstrap, inclusive versão16, recibo, credenciais, ator e schema errados.

### Reconciliação individual T007–T022 e fronteira do gate

| Itens     | Evidência de aceite                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T007–T011 | Fresh/upgrade/down vazio e down com dados recusado; schema e negativos, novas matrizes lifecycle/atomicidade/identidade/registry |
| T012      | Cinco Models sem sync, colunas/nullability/DATEONLY/BIGINT e uso real em integrações                                             |
| T013      | CAS/revision/leases, locks ordenados, claim e dois slots, concorrência real observada                                            |
| T014      | Matriz comercial completa desta rodada e unidades; sem alterar auth003/OS                                                        |
| T015      | Matriz sintética real, limites, temporários e falhas; watchdog corrigido e regressão real                                        |
| T016      | Build fixado e imagem/API/qpdf já comprovados em G0, smoke12.3.2 não-root reexecutado; Dockerfile preservado                     |
| T017      | PUT validado, privacidade/Range/hash/tamanho, abort/deadline e transportes reais                                                 |
| T018–T019 | Bootstrap/claims/fencing/retry/reconciliação/tardio, concorrência e SIGKILL/restart reais                                        |
| T020      | 5 contratos fundação e unidades de datas/entrada/ETag/cursor/erros                                                               |
| T021      | Identidades, exclusividade, ACL, credenciais e limites revalidados                                                               |
| T022      | Integrações e gates desta seção, sem bloqueante concreto restante da fundação                                                    |

**G1 LIBERADO exclusivamente para a fundação aprovada.** Testes HTTP/CSRF/multipart,
endpoints/US1+ e aceite final de produto pertencem a T023+; não executados aqui.
TLS/segredos/deploy/políticas de produção e benchmark prolongado não foram
certificados pelo ambiente isolado, mas não são novos bloqueios arbitrários de G1.
Limitação Yarn1/SIGTERM continua documentada: daemon usa entrypoint Node;
script Yarn real foi provado em single-tick. Não há worker habilitado em produção.

---

## Rodada posterior — bootstrap, runners e contratos (2026-11-17)

Esta seção atualiza os bloqueantes operacionais listados no histórico abaixo;
não declara encerradas as demais matrizes de T022. **G1 continua BLOQUEADO**.

### Bootstrap real

`budgets:cleanup-worker` mantém o script existente e agora usa bootstrap
integration-only em `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/worker-cli.js`.
Opt-ins `RUN_BUDGETS_INTEGRATION`, `BUDGETS_GATE_EXECUTION_APPROVED` e
`BUDGETS_WORKER_EXECUTION_APPROVED` obrigatórios, `NODE_ENV=test`, major17,
credenciais limitadas e recibos remotos exigidos. Nenhum fallback de produção.
Preflight read-only verifica banco/owner/papel/recibo, MinIO/recibo/anônimo403,
credencial sem leitura de policy e schema migrado antes de inicializar Models
ou executar operações do worker. Sockets de preflight são necessários para
comprovar identidade; nenhuma operação de lifecycle os antecede.

Ator técnico opcional: se informado, precisa ser User ativo `role=user`, sem
membership/manager/grants. Bootstrap nunca cria usuário. Sem ator, desconhecidos
continuam apenas alertados. Não há dependência de cursor comercial no cleanup;
nenhum segredo de paginação é criado artificialmente para iniciar esse worker.

O entrypoint real do serviço e o runner tratam SIGTERM/SIGINT com AbortSignal,
aguardam trabalho e fechamento do pool, logs fixos sem SDK/stack/senha. Falha
operacional observada pelo bootstrap retorna21 em vez de falso sucesso.
`BUDGETS_WORKER_RUN_ONCE=1` executa um ciclo real e encerra: não é mock.

`worker-bootstrap.integration.test.js` prova: execução literal de
`yarn budgets:cleanup-worker` em single-tick remove objeto exclusivo e persiste
REMOVED; runner Node encerra por SIGTERM/SIGINT; serviço direto encerra por
SIGTERM; fresh/upgrade recusam banco principal já migrado; opt-in/major/recibo,
senha PostgreSQL, segredo MinIO e ator inválidos nunca chegam a ready.

**Limitação observada do wrapper:** Yarn1 retornou1 quando ele próprio recebeu
SIGTERM, embora o worker tenha emitido stopped. Isso não é registrado como
saída0. Para daemon controlado usar entrypoint Node/runner; o script Yarn foi
comprovado com encerramento explícito single-tick. Não há serviço Docker qpdf.

### Runner reproduzível

Executar no host, sem env implícito ou script temporário:

```sh
python3 /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/operational-runner.py \
  --manifest /tmp/feature005-t021-7gg672ji/resources.json \
  --scenario all --approve-fixtures
```

O runner valida manifesto privado, identidade Docker exata/rede/volumes e
preflight remoto do banco principal antes de criar fixtures. Cada execução cria
diretório exclusivo0700 de evidências; envs/logs0600. Não remove banco/volume,
não reutiliza fixture anterior e não faz reset. Bootstrap PostgreSQL via docker
exec é restrito ao container cuja identidade foi verificada; testes usam papel
limitado. As fixtures têm nome UUID-sufixado e recibo protegido vinculado ao run;
o nome/banco/owner é validado separadamente. Não são banco de produção por módulo.

- `fresh`: public vazio autenticado, baseline + quatro migrations, tabelas novas
  vazias e SequelizeMeta conferidos; nenhuma fixture legada anterior à cadeia005.
- `upgrade`: outra fixture public vazio, baseline, down vazio protegido/reapply,
  dados legados, cadeia005 posterior e negativos/down com dados recusado.
- `migrated`: exige migration final/tabelas; não lança migration. Executa foundation,
  runtime e bootstrap real. Página de25 do reconciliador percorrida explicitamente
  no teste para suportar acúmulo de evidências terminais de execuções anteriores.

Saídas:20 preflight/declaração,21 falha de execução,22 asserção/suíte falha,
0 somente sucesso. Regressões unitárias verificam propagação. Uma tentativa real
com falha de paginação retornou22, evidência preservada. Recusa Docker com outro
executor anexado à rede também foi preservada; isolamento não foi relaxado.

### Contratos e correções

Nova suíte `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/contracts/budgets/foundation.test.js`:
entrada estrita/Unicode/número exato, erros sanitizados/status, ETag forte e bigint,
428/412, datas gregorianas/civil São Paulo, paginação25/100, cursor HMAC por
ator/escopo/filtros e TTL15min. Sem rotas fictícias; contratos HTTP continuam
futuros e **não executados**.

Defeito encontrado e corrigido em `publicBudgetError`: erro sem code caía no
default validation400; agora retorna storageUnavailable503 sanitizado. Regressão
unitária adicionada. Outra correção foi no teste repetível de registry: uma
única página não prova que o UUID novo foi visitado após acumular >25 terminais;
o teste agora percorre páginas sem apagar evidências. Corrigido também ciclo de
import no entrypoint direto, validado pela integração correspondente.

### Resultados finais desta rodada

| Execução                                       | Aprovados | Falhos | Ignorados |
| ---------------------------------------------- | --------: | -----: | --------: |
| `yarn test:budgets:unit` e runner unit         |        70 |      0 |         0 |
| Contratos de fundação pelo runner              |         5 |      0 |         0 |
| Runner fresh                                   |         1 |      0 |         0 |
| Runner upgrade                                 |         1 |      0 |         0 |
| Runner migrated (foundation/runtime/bootstrap) |        28 |      0 |         0 |

Evidências verificáveis:

- `/tmp/feature005-t022-ops-unit-final.log` (Yarn70);
- `/tmp/feature005-t021-7gg672ji/t022-ops-52ae56e105ad/unit.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-8a4bda2387e9/contract.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-2685ba848561/{preflight,fresh,upgrade,migrated}.log`;
- `/tmp/feature005-t022-ops-all-verified.log` (quatro cenários exit0);
- `/tmp/feature005-t022-ops-before.json` (snapshot de preservação).

Tentativas com falha não foram apagadas: contrato inicial expôs erro400/503;
Yarn/SIGTERM expôs comportamento do wrapper; runner anterior `t022-ops-c74a68898ac8`
retornou22 por paginação. Não contabilizá-las como ignoradas/aprovadas.

Bootstrap operacional, runner fresh/upgrade/migrated e suíte de contrato deixam
de ser bloqueantes de implementação desta rodada. Permanecem: matriz comercial
real completa; todas as constraints/transições cruzadas; corridas attach/cleanup,
stream/delete e auth; transporte interrompido durante PUT/GET/Range; interrupção
real de processo/container durante lifecycle e pressão prolongada de recursos.
T007–T018 e T022 não recebem aceite integral por esses resultados. Não iniciar T023.

---

## Histórico da primeira execução (preservado)

## Decisão: G1 BLOQUEADO

Execução autorizada da fundação, não autorização de histórias. Run T021
`35eb2feadec9`, PostgreSQL **17.11**, branch `feature/005-budgets-pdf`.
Nenhum endpoint, deploy, commit/push/PR ou worker de produção iniciado.

Os caminhos de evidência abaixo são absolutos. Logs privados permanecem fora
do Git. Não copiar envs, tokens, senhas ou manifests privados para relatórios.

## Preflight e preservação

- Worktree confirmado: `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`.
- Verificador Docker somente leitura passou antes e depois da execução:
  `/tmp/feature005-t022-infrastructure.log` e
  `/tmp/feature005-t022-infrastructure-final.log`.
- `/tmp/feature005-t022-preflight.log`: recibos autenticados PostgreSQL/MinIO,
  owner e usuário esperados, major17, papel sem superuser/createdb/createrole,
  senha inválida recusada, recibo sem escrita; bucket privado, anônimo403,
  prefixo/credenciais limitados, PUT/stat/GET/Range/list/DELETE e repetição.
- UID1000, rootfs read-only, cap-drop, no-new-privileges, rede exclusiva,
  512MiB/1CPU/64PIDs e tmpfs64MiB. Sem portas publicadas.
- Banco principal não foi removido/reconstruído. Duas fixtures adicionais foram
  criadas no **mesmo PostgreSQL17 exclusivo**, cada uma com nome aleatório,
  owner limitado e recibo independente protegido. Nenhuma foi apagada.
  Seus manifests 0600 estão no diretório privado da T021.
- Snapshot de hashes anterior: `/tmp/feature005-t022-before.json`.
  Dockerfile, lockfile, Features003/004 e migrations históricas não alterados.

## Migrations e schema real

Baseline histórico até `20261126000000-add-service-order-informational-priority.cjs`
via Sequelize CLI, seguido, em ordem, por:

1. `20261127000000-create-budget-commercial-authorization.cjs`;
2. `20261128000000-create-budget-pdf-objects.cjs`;
3. `20261129000000-create-budgets-pdf.cjs`;
4. `20261130000000-enforce-budget-pdf-lifecycle.cjs`.

Aplicadas no banco principal exclusivo e nas fixtures, com registro real em
`public.SequelizeMeta`. Novas tabelas: `budget_commercial_managers`,
`budget_commercial_permissions`, `budget_commercial_permission_audit`,
`budget_pdf_objects`, `budgets_pdf`. Legado `budget` preservado, não convertido.
Dump estrutural sem dados: `/tmp/feature005-t022-schema-obtained.sql`.

Suíte T007 expandida: cadeia do zero, down vazio das quatro migrations em ordem
inversa via CLI, reaplicação/upgrade com fixture legada preservada, down recusado
com dados (incluindo migration lifecycle), FKs RESTRICT, negativos de revisão,
identidade/autoria, slots, metadata/tamanho/hash, unicidade, auditoria append-only,
índices, collation C e FKs compostas deferred.
Evidência verde: `/tmp/feature005-t022-schema-fixture-2.log` (1/1).

O banco principal reteve o estado de uma tentativa anterior interrompida da
T007; **não** se afrouxou a exigência de estado vazio para reexecutar a cadeia
sobre ele. As integrações seguintes usam fixtures novas, sem reset.

## PostgreSQL, storage e worker reais

`foundation.integration.test.js` possui 13 subtestes mais teste-pai (14/14):

- correspondência de colunas/nullability e tipos DATEONLY/BIGINT dos cinco
  Models com schema migrado; revisão serializada como string;
- User técnico `role=user`, sem membership/admin/grants comerciais;
- grant READ e auditoria transacionais; dados reais de membership, revogação,
  isolamento entre setores e ownership do cliente/publicado;
- qpdf real antes de PUT, intenção persistida e live lease obrigatórios;
- PUT/stat/hash, leitura integral e Range real sob locks; anônimo403;
- CAS concorrente com exatamente um vencedor; revisão obsoleta e rollback;
- lock compartilhado impede escritor concorrente (timeout PostgreSQL55P03);
- publicado e pendente presentes simultaneamente, ambos protegidos de cleanup;
- lease expirado, dois claimers concorrentes sem claim duplicado, token antigo
  incapaz de finalizar, nova reivindicação e remoção idempotente;
- falha real de socket MinIO: retry persistido, objeto preservado, retomada;
- interrupção injetada **depois de DELETE real confirmado**, antes de CAS final:
  rollback mantém CLEANING, novo lease recupera not-found e conclui;
- PUT real tardio após REMOVED detectado pela reconciliação e removido novamente;
- desconhecido recente protegido; relógio avançado >24h com storage/DB reais:
  ausência de ator alerta sem apagar, ator inexistente falha FK sem registro,
  ator técnico válido registra e limpa; terminal registry preservado;
- loop `worker.run` efetivamente executado com AbortSignal, sem daemon permanente;
- consulta final sem inconsistência ATTACHED/referências e checksum lógico do
  legado inalterado.

Relógio e ponto de interrupção são injetados explicitamente; não são evidência
de queda real do container/processo nem de espera real de24h. Não houve mock de
sucesso de DB, qpdf, PUT, GET ou DELETE. Objetos exclusivos dos testes; nenhuma
limpeza bucket-wide. Objetos publicados/pendentes e evidências foram retidos.

## Runtime

`runtime.integration.test.js`: 6 subtestes mais pai (7/7), qpdf12.3.2 real,
matriz sintética (inclui senha vazia, senha exigida e warning), limite10MiB/+1,
timeout1ms controlado, watchdog RSS real via `/proc` com limite reduzido,
duas validações concorrentes e terceira recusada, temporários privados e limpos,
binário inexistente fail-closed. Tetos só reduzidos nos ensaios, não ampliados.
Esses ensaios não equivalem a benchmark de saturação prolongada nem a certificar
que todo PDF de10MiB cabe em256MiB RSS.

## Resultados separados

| Execução final                           | Aprovados | Falhos | Ignorados |
| ---------------------------------------- | --------: | -----: | --------: |
| `yarn test:budgets:unit`                 |        69 |      0 |         0 |
| Schema/upgrade/down em fixture exclusiva |         1 |      0 |         0 |
| Foundation + runtime integrados          |        21 |      0 |         0 |

Logs: `/tmp/feature005-t022-yarn-unit.log`,
`/tmp/feature005-t022-schema-fixture-2.log`,
`/tmp/feature005-t022-integration-final.log`.

Runner de contratos falhou com `BUDGET_SUITE_NOT_IMPLEMENTED`:
`/tmp/feature005-t022-contract.log`. Não há suíte dedicada nesse diretório;
unidades `contracts.test.js` verdes não a substituem. Contratos HTTP futuros não
implementados/executados, pois endpoints estão fora do escopo.

Tentativas iniciais falharam em fixtures (timestamps NOT NULL ausentes,
reuso de objeto ATTACHED no teste de UNIQUE, nome sintético de User repetido,
code setorial longo/membership incompatível com schema e expectativas de erros).
Foram corrigidas e reexecutadas; não apagar os manifests/fixtures remanescentes.
Nenhuma migration aplicada foi editada; nenhum defeito produtivo foi comprovado
que justificasse mudar regras funcionais. Guard novo de fixtures tem regressão
unitária: opt-in separado, sufixo exato, recusa de nomes divergentes.

## Reconciliação conservadora T007–T022

| Item      | Estado após esta execução                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| T007      | Ampliada e verde no PG17; não declarar cobertura exaustiva de cada constraint sem casos adicionais           |
| T008–T012 | Implementadas/aplicadas; schema/Model e negativos exercitados; aceite final vinculado à matriz completa T007 |
| T013      | CAS/locks/claims/fencing reais verdes; concorrências adicionais de auth e stream/delete pendentes            |
| T014      | Unidades verdes e autorização parcial real; matriz comercial integral em integração pendente                 |
| T015–T017 | Unidades e ensaios reais verdes; cenários adicionais de transporte/recursos pendentes                        |
| T018      | Worker API/loop real e recuperação verdes; bootstrap operacional CLI/runner ainda bloqueado                  |
| T019      | Concluída: unidades de cleanup verdes e regressões de recuperação reais                                      |
| T020      | Concluída: contratos comuns e unidades verdes; não confundir com contratos HTTP                              |
| T021      | Concluída no escopo preparação/preflight, revalidada                                                         |
| T022      | Executada parcialmente, NÃO concluída; G1 bloqueado                                                          |

### Bloqueantes ainda não comprovados

1. Bootstrap operacional seguro do worker com segredo de cursor, identidade/ACL,
   ator técnico provisionado e parâmetros encaminhados pelo runner. CLI/runner
   continuam fail-closed, e o runner integração geral não encaminha todas as
   novas aprovações/seleção de fixture. Testes direcionados não ocultam isso.
2. Matriz comercial completa com dados reais (gerente, seis grants independentes,
   autoconcessão/ampliação, status inativo, concorrência revogação/streams).
3. Todas as transições/constraints cruzadas e tipos/schema comparados
   exaustivamente; corridas attach/cleanup e stream/delete, transação abortada
   após PUT e transportes interrompidos durante PUT/GET/Range.
4. Recuperação após interrupção real do processo/container e execução prolongada
   sob pressão de recursos; falha real do binário via preflight operacional.
5. Suíte de contrato de fundação aplicável e runner de integração reproduzível
   que separe cadeia fresh/fixture de banco principal já migrado.

Não iniciar T023+ automaticamente. Encerramento desta execução de T022 com gate
bloqueado é intencional; nenhuma dependência foi dispensada.
