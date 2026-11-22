# T065 — quickstart ponta a ponta e rastreabilidade (2026-11-21)

**Aceite técnico T065 após T064**: run novo `7aac9fa67b8e`, manifesto,
contêineres e preflight remotos verificados. Comando desde a raiz do worktree:
`node tests/support/budgets/operational-runner.js --manifest
/home/wpossidonio/.local/state/alves-glass/integration/feature005/7aac9fa67b8e/resources.json
--scenario migrated`. Exit **0**; log e exit privados
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/7aac9fa67b8e/t022-ops-f6a534184f23/migrated.log`/`.exit`:
**124/124 testes aprovados, 0 falhas, 0 skips, 0 TODO**. A cadeia de migrations
foi aplicada previamente pelo runner `--scenario prepare-schema
--approve-schema` (exit 0) no mesmo run novo.

| Jornada | Execução HTTP/PG17/MinIO e falhas verificadas |
| --- | --- |
| US1 — privado/criação/leitura | `us1-http`, `us1-create-read`, `foundation`: sessão real, arquivo validado, número textual, concorrência/duplicata, privado antes de publicar. |
| US2 — publicação/portal | `publication-portal`, `us2-services`, `us2-stream`: publicação manual, ownership, data civil, PDF/validade, Range e revogação. |
| US3 — substituição/edição | `replacement`, `authorization-races`: slots vigente/pendente, falha antes de troca, restart real, locks e publicação manual. |
| US4 — exclusão | `deletion-recovery`, `process-kill`, `lifecycle-matrix`: confirmação, recuperação física, SIGKILL, concorrência e objeto antigo inacessível. |
| US5 — poderes setoriais | `permissions`, `authorization-matrix`, `domain-isolation`: seis operações, gerente/delegado, auditoria, perda de membership e isolamento OS/estoque. |

Matriz individual existente `traceability-review.md` confrontada com o texto
de `spec.md`: **42 RF, 10 RNF e 8 SC**, IDs 001..N sem lacuna ou repetição.
RF-001..007/SC-001..002: US1 e schema; RF-008..012/036..038,
RNF-001/004/009, SC-003/005: publicação, portal e T063; RF-013..024,
RNF-002/003, SC-004/006: substituição, validade, transações e corridas;
RF-025..028/SC-008: exclusão/worker/recovery e T064; RF-029..035,
RNF-007/SC-007: concessões e regressões T062; RF-039..042/RNF-008:
legado preservado, migrations aditivas e backup T064; RNF-005/006/010:
inspeção de camadas, logs de T061 e suítes reais acima. Não converter a
checklist de qualidade da especificação em prova de execução: evidência técnica
está nos logs e gates citados; o checklist continua documental.

Gates reutilizados sem reexecutar: T061 11/11; T062 234/234 regressões locais,
003 CQRS 7/7 + quatro integrações 1/1, PR5 1/1, 004 recovery 9/9;
T063 124/124, 138/138 e 19/19 e build Docker exit 0/qpdf 12.3.2-r0;
T064 backup pg_dump/pg_restore em destino novo, hashes/bytes iguais, FK
RESTRICT/down protegidos, worker da cópia e 5/5 focais. Nenhum skip obrigatório
foi usado como prova. Ensaios negativos e falhas históricas estão preservados,
não representam falha vigente.

**Limites pré-produção**, não declarados ativos: usuário não-root no Dockerfile
por padrão, supervisor/entrega de alertas, gestão de segredos, limites de
recursos, monitoramento e backup operacional. Consumidores externos de
`/budged` permanecem desconhecidos; desativação, importação de dados reais,
deploy/cutover e viewer inline são iniciativas separadas, não aceite T065.

---

# T061 — aceite operacional no run isolado `db1126fff37e` (2026-11-19)

Manifesto privado e identidade Docker verificados novamente, preflight remoto
PG17/MinIO concluído antes do acesso operacional. Runner `--scenario t061`, imagem
API do manifesto, UID1000, read-only, cgroup 512 MiB/1 CPU/64 PIDs e tmpfs64 MiB.
Timeout externo de 180 s exclusivo do cenário. Log/exit privados preservados em `t022-ops-cd3b77b9408b/t061.log` / `.exit` (0):
**11/11 testes, 0 falhas, 0 skipped/TODO**. Testes novos em
`tests/integration/budgets/t061-worker.integration.test.js`, junto de
`resource-pressure`, `worker-bootstrap` e `process-kill` pertinentes. Os runs
intermediários falhos permanecem no diretório privado: fixtures violaram primeiro
o guard de estado inicial e depois a imutabilidade de `created_at`; corrigidos
somente no teste, sem modificar migrations. Um PUT sintético da primeira tentativa
falha pode ter ficado sem registry; não houve DELETE amplo de objetos de terceiros.
Um ensaio de `/tmp` noexec e um monitor que encontrou ESRCH também foram corrigidos
no harness; nenhum desses erros foi mascarado como teste aprovado.

| Critério                   | Observação real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backlog/lotes/idempotência | 27 jobs exclusivos, lote1=25, lote2=2; todos 27 `REMOVED` com `attempts=1`, leases nulos e 27 objetos ausentes no MinIO; terceiro tick `completed:0`. Registro terminal permanece; sem duplicação de processamento.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Dez falhas externas        | Proxy HTTP exclusivo interrompeu **10 DELETEs reais** do SDK MinIO para a chave exclusiva; MinIO compartilhado permaneceu ativo. A cada tentativa, CLI saiu 21 e persistiu `CLEANUP_PENDING`, `last_error_code=storageUnavailable`, lease liberado e objeto ainda presente. Backoff observado (ms até próxima tentativa): 5319, 10281, 20554, 40307, 80203, 160704, 320268, 640157, 1280715, 2560589. Apenas no teste, a fixture adiantou `next_attempt_at` entre reinícios para manter duração finita; o backoff durável foi medido **antes** de cada ajuste. Após restabelecer transporte, tentativa 11 removeu objeto; zero objetos da fixture remanescentes e zero advisory locks retidos. Não há limite contratual de dez tentativas máximas: >=10 é limiar de **alerta**, não desistência. |
| Alertas                    | CLI real emitiu `budgetCleanupBacklogOverOneHour` e, após a décima falha, `budgetCleanupTenErrors`. Eventos sanitizados; emissão não prova encaminhamento a monitoramento produtivo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Overshoot                  | Subprocesso Node real de ensaio, alimentado com alocação limitada a 32 MiB, atingiu RSS observado de **33.472.512 B** e foi encerrado pelo watchdog existente ao superar teto reduzido de 12.582.912 B em **88 ms**; não é alegação de limite duro por processo. Cgroup `memory.peak` **169.394.176 B**, abaixo dos 536.870.912 B. Prova de limite do conjunto é do cgroup.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Pool/locks                 | Pool PostgreSQL `max=1`: segundo acesso esperou **425 ms**, reutilizando a conexão. Advisory lock exclusivo de owner de fixture provocou timeout real em **5.009 ms** (`55P03`); holder liberado por rollback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| qpdf/upload/abort/restart  | `resource-pressure`: pico amostrado cgroup 167.202.816 B, 2 filhos qpdf, RSS qpdf 9.408.512 B, tmp 20.971.520 B; 8 validações aceitas, 4 recusas por concorrência, 5 timeouts, 2 uploads simultâneos e zero filhos/temporários remanescentes. `worker-bootstrap` e `process-kill` cobrem sinais e retomada; `transport-matrix`/`authorization-races` aceitos anteriormente cobrem abort/stream/Range.                                                                                                                                                                                                                                                                                                                                                                                            |

T061 concluída somente como **gate de ensaio em integração**, não como habilitação
produtiva. O monitor do teste mediu RSS do processo filho e memória cgroup; CPU,
PIDs e tmpfs permaneceram sob limites declarados do runner. Supervisor, consumo dos
eventos e hardening da imagem com UID não-root por padrão seguem pré-deploy.
As 57 iterações `completed:0` da rodada anterior continuam histórico, não foram
contadas como prova de backlog. A matriz individual T065 está em
`traceability-review.md`; quickstart ponta a ponta ainda depende de T064.

---

# Complemento T061/T065 — histórico anterior (sem aceite dos gates naquela rodada)

Run autorizado `db1126fff37e`: verificação de manifesto/identidades e preflight
remoto passaram. CLI real do cleanup executada pelo cenário `worker` do runner,
com limites do container (512 MiB RAM/swap, 1 CPU, 64 PIDs, tmpfs 64 MiB);
57 eventos `budgetWorkerTick` com `completed:0`, `budgetWorkerReady` e
`budgetWorkerStopped`, saída 0 após SIGINT. Log privado preservado em
`t022-ops-bafde201cb0b/worker.log`. Isso demonstra inicialização e parada
controlada, **não** backlog, dez erros reais, recuperação sob falha ou entrega
de alertas a monitoramento. Faltam métricas de overshoot por filho, pool reduzido,
lock extremo de 5 s e retry controlado em fixtures exclusivas. Não modificar
objetos do banco compartilhado para forçar esses resultados.

Matriz individual preparatória: `traceability-review.md` (42 RF, 10 RNF,
8 SC). O quickstart ponta a ponta depende do gate T064 e não foi executado nesta
rodada. O resultado do runner `unit` com preflight foi 137/137, sem skips, em
`t022-ops-af277bd00464/unit.log` (privado); contratos/migrated/regressões
aceitos anteriormente não foram repetidos. Uma tentativa no host falhou por
ausência de `sequelize` no `node_modules` local; não é falha da suíte executada
na imagem autorizada.

---

# Revisão T060–T066 — decisão de escopo posterior (2026-11-19)

Decisão aprovada: POST /budged e tabela budget continuam sem mudança nesta
feature; desativação e comunicação de consumidores foram **retiradas** de T060,
não cumpridas. `legacy-http.test.js` e a integração de legado exercitam
composição/negação de cliente, esquema e preservação de linhas. Externos
desconhecidos, nenhum cliente comunicado; não há cutover/importação. As referências
históricas abaixo registram a hipótese anterior, não o contrato vigente.

T061: ensaio real `resource-pressure.integration.test.js` no runner migrated
(cgroup 512MiB, 1 CPU, 64 PIDs, tmpfs64MiB, UID1000): no último rerun verde
observado antes da mudança de alertas, pico amostrado cgroup 198340608 bytes,
memory.peak 219729920 bytes, 2 filhos qpdf, RSS máximo observado 8900608
bytes, temporários 20971520 bytes; 8 validações aceitas, 4 recusadas por
concorrência, 5 timeouts e 2 PUTs de 10MiB simultâneos; zero resíduos.
Watchdog RSS256MiB amostra a cada50ms, não é limite duro por filho; cgroup
contém o processo como um todo no ensaio. Upload 2, stream 4/60s, lock5s,
MinIO30s, timeout qpdf10s; provas de abort/Range/restart em
`transport-matrix`, `authorization-races`, `resource-pressure` e
`worker-bootstrap`. `cleanupAlertCodes` emite apenas códigos para backlog >1h
e tentativas >=10; CLI consulta agregados após cada tick. Sem stdout/stderr
bruto, cookies, chaves, PDF ou URL. O supervisor/encaminhamento dos eventos
e dimensionamento para produção continuam condicionantes pré-deploy, não
comprovação de monitoramento produtivo.

T062: `domain-isolation.integration.test.js` compara contagens de OS,
outbox, estoque e budget antes/depois de attach/delete/cleanup reais; não há
import de broker/MongoDB nos serviços comerciais. Regressões unitárias
compartilhadas 234/234; integrações antigas dependentes de ambientes próprios
não foram executadas e não devem ser chamadas verdes. Ver relatório final para
falhas e reruns.

Checkpoint final desta rodada: T060 concluída com critérios revisados; T061–T066
abertas por critérios ainda não comprovados, discriminados em `final-review.md`.
Último migrated após correção do bootstrap do worker: **124/124**, exit0,
`t022-ops-329b768ed0ad/migrated.log` no diretório privado do run autorizado;
unitários **137/137**, contratos **18/18**, regressões **234/234**, todos exit0,
sem skips. Reruns falhos e respectivas causas não foram omitidos.

---

# Histórico: revisão bloqueada na hipótese anterior (2026-11-18)

Checkpoint e resultados desta revisão em `final-review.md`. T060 exige consumidores
de `/budged` inventariados e comunicados; os registros T001/T030 declaram que
isso não ocorreu. A solicitação atual exige preservar a rota. Não foi ativado
410, nem realizado rollout. Por dependência, T060–T066 permanecem abertos.
Após preflights do run autorizado `db1126fff37e`, as suítes existentes foram
reexecutadas: unidade 135/135, contratos 18/18, migrated 122/122 e regressões
234/234 (sem skips); logs e exits privados descritos em `final-review.md`.
Essas execuções não comprovam os ensaios adicionais T061–T065. Não houve
fresh/upgrade, integração antiga com broker/MongoDB, importação ou deploy.

---

# Execução vigente US5 — 2026-11-18

**US5 ACEITA — T053–T059 concluídas.** Gerência comercial setorial e seis
operações independentes implementadas. Apenas administrador nomeia gerente ou
concede MANAGE_PERMISSIONS; gerente e delegado com MANAGE_PERMISSIONS concedem
somente as cinco operações comerciais a colaboradores ativos com membership do
setor. Admin tem acesso global, mas não pode autoconceder. GET restrito a gestores
autorizados; PUT/DELETE usam sessão, Origin/CSRF e allowlists UUID/enum/query/body.
Mudança efetiva e auditoria são atômicas; repetição responde
`{changed:false,auditId:null}`. A listagem inclui `effective`, diferenciando
grant persistido e autoridade corrente após alteração de membership/estado.
Não se criam roles ou membership nem se alteram poderes OS/estoque.

Run autorizado `db1126fff37e`, manifesto privado em
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/resources.json`.
Preflights Docker e remoto concluídos. Evidências finais (todos exit0) no mesmo
diretório privado:

| Suite                                        | Resultado | Evidência                                                                             |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| Unidade Feature 005                          | 135/135   | `us5-unit-accepted.log` e `.exit`                                                     |
| Contratos Feature 005                        | 18/18     | `us5-contract-accepted.log` e `.exit`                                                 |
| Integração PostgreSQL17/MinIO migrated       | 122/122   | `t022-ops-e484f232ca1e/migrated.log`, `us5-migrated-checkpoint-summary.log` e `.exit` |
| Regressões auth/003/004/estoque/configuração | 234/234   | `us5-regressions-final2.log` e `.exit`                                                |

T057 cobre HTTP real, dois setores, quatro subtestes de autorização e auditoria
imutável, grant/revoke concorrentes e idempotentes, rollback ao falhar auditoria,
perda e retorno de membership, ausência de READ implícito e seis operações.
T058 prova com stream real que guard bloqueia revogação até concluir entrega;
requisição posterior reautoriza. PUT MinIO concluído antes de revogar não anexa
arquivo após perda de permissão; cleanup preserva slot referenciado. Matriz
fundacional confirma leitura setorial independente do autor. Não se alteraram
revogadores de sessão/003 para tentar recolher bytes já entregues.

Sem migrations novas, fresh/upgrade, instalação, cutover ou deploy. T060 e a
revisão final **não iniciadas**. POST /budged legado continua como antes; retirada
depende de gate próprio. Repetir preflights do manifesto antes de reutilizar run.

---

# Histórico: execução US4 — 2026-11-18

**US4 ACEITA — pronta para iniciar US5.** T047–T052 concluídas. DELETE
transacional devolve 202 após revogar acesso e enfileirar cleanup; a remoção
física assíncrona foi comprovada em integração real, incluindo falha/retry,
PUT tardio, streams, publicação/substituição concorrentes e restart do worker.
Unitários 132/132, contratos 16/16, migrated 114/114 (US4 12/12) e
regressões 231/231, todos exit0. Detalhes e limites em
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/us4-acceptance.md`.
T053 não iniciada. Reutilizar o run somente após preflights do manifesto privado
indicados abaixo; nenhum fresh/upgrade ou recurso novo é necessário.

---

# Histórico: execução US3 — 2026-11-18

**US3 ACEITA — pronta para iniciar US4.** T040–T046 concluídas: unitários127/127,
contratos11/11, migrated102/102 (inclui US3 9/9), regressões231/231, todos exit0,
sem skips/TODO/cancelamentos. T047 permanece não iniciada.

G1/US1/US2 continuam aceitos. Não reutilizar os comandos Python ou manifestos
temporários dos registros históricos abaixo. Ferramentas operacionais vigentes:
Node.js 22 ESM, Docker e Yarn Classic 1.22.22, sem instalação no host.

Novo run exclusivo: `db1126fff37e`. Manifesto privado:
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/resources.json`.
Diretório 0700, arquivos 0600. Rede interna, volumes e credenciais dedicados;
PostgreSQL17/MinIO sem portas publicadas. Imagem API validada preservada.
Preflight remoto e Docker aprovados; migrations existentes aplicadas apenas ao
novo banco mediante `prepare-schema --approve-schema`. Não executados fresh/upgrade.

```sh
node /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/verify-resources.js /home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/resources.json
node /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/operational-runner.js --manifest /home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/resources.json --scenario migrated
```

Novo provisionamento, somente com autorização explícita e sem reaproveitar runs:

```sh
FEATURE005_T021_APPROVED=1 node /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/provision-isolated.js
```

O provisionador imprime o caminho privado criado; não reconstruir manifests de
runs antigos. Em falha, recursos são preservados, sem cleanup global automático.
Não executar novo provisionamento como simples substituto de um teste que falhou.

Checkpoint detalhado e resultados finais:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/us3-acceptance.md`.
T047 não iniciada.

---

# Histórico: checkpoint US2 — download autenticado

**US2 ACEITA — pronta para iniciar US3.** T038/T039 concluídas. Correção pontual autorizada da asserção de imagem Docker: teste isolado 3/3, regressões 231/231, exit 0. Reutilizadas evidências 114 unitários, 9 contratos e 93 integrações migrated sem alteração funcional ou repetição PostgreSQL/MinIO.

Attachment obrigatório; viewer/inline adiado e gate anterior não aprovado. T040 não iniciada. Resultados, ressalva de formatação preexistente e logs em `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/us2-acceptance.md`.

---

# Histórico: checkpoint T031 — 2026-11-17

**US1 ACEITA — pronta para iniciar US2.** T029/T030/T031 concluídas; T032 não iniciada.
Sem ativação externa, migração de legado, publicação, portal ou deploy.

Relatório completo e matriz dos dez critérios:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/us1-acceptance.md`.
Procedimento de legado:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/legacy-reconciliation.md`.

Resultados: 88 unitários Feature 005, 7 contratos, 80 migrated
(fundação/HTTP/PG17/MinIO/qpdf/worker/legado), 153 regressões de autenticação/OS/
persistência e 77 estoque/configuração, todos aprovados e sem skips. Contagens
incluem testes-pai; reexecuções não somadas. Worker retoma órfãos e preserva
objetos referenciados; nenhum upload publica ou entrega documento a cliente.

Reprodução da integração (somente ambiente isolado autorizado; não executar
outros containers na rede durante o preflight estrito):

```sh
python3 /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/operational-runner.py \
  --manifest /tmp/feature005-t021-7gg672ji/resources.json --scenario migrated
```

O runner verifica identidade Docker antes de abrir sockets e executa preflight
remoto. Manifesto/credenciais não devem ser copiados ao repositório. Run
35eb2feadec9, PostgreSQL 17 exclusivamente, sem reset, sem purge de evidências.
Logs finais em `/tmp/feature005-t021-7gg672ji/t022-ops-e2620f2765b8/`.
Detalhes de não executados e gate de rollout constam do relatório. Preservada
abaixo a documentação histórica; afirmações antigas de pendência não substituem
este checkpoint nem os relatórios T022/T023–T028.

---

# Fechamento G1 — estado vigente em 2026-11-17

T022 concluída no escopo aprovado: **G1 LIBERADO**. Runner completo migrated57,
fresh1/upgrade1, unidades70 e contratos5 verdes. As seções anteriores de execução
abaixo permanecem como histórico; seu bloqueio foi superado pelas matrizes reais.
Evidência, SIGKILL, métricas e reprodução:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/t022-evidence.md`.
Não resetar o banco principal já migrado; usar `operational-runner.py` e fixtures
novas explícitas. Não iniciar T023 automaticamente. Nenhum endpoint/deploy.

# Atualização operacional T022 — 2026-11-17

T022 recebeu autorização e foi parcialmente executada no run `35eb2feadec9`.
O banco principal exclusivo agora tem baseline e as quatro migrations005;
**não reexecutar preflight que exija public vazio nem a suíte fresh sobre ele**.
Identidades e isolamento foram reconfirmados. Não reprovisionar a T021 para
verificar o run. G1 continua **BLOQUEADO**, não iniciar histórias.

Relatório completo, resultados separados, schema obtido e pendências:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/t022-evidence.md`.
O restante deste documento preserva o histórico T021/anterior; afirmações de
“nenhuma migration/worker” referem-se àquelas execuções, não ao estado atual.

# Quickstart e validação futura — Feature 005

## T021 executada — 2026-11-17 — escopo vigente

**Arquitetura corrigida**: somente PostgreSQL 17 é suportado. Produção utiliza uma única instância lógica principal e o banco principal compartilhado pelos módulos da API; as tabelas aditivas de 005 convivem com `budget` legado. Não existe banco ou servidor exclusivo de orçamentos em produção. Removida a matriz indevida de versões dos documentos e do teste de schema; guard agora exige major17 antes de I/O. Constituição/Features003/004/migrations históricas não alteradas.

**T021 concluída no escopo autorizado de preparação/preflight**, não como gate de fundação. A aplicação das migrations da API e worker ativo, antes citados em T021, foram explicitamente adiados para T022, conforme pedido de não executar integrações completas agora. Nenhuma migration da API foi executada. `public` está vazio e não existe SequelizeMeta. O único schema persistente novo é o recibo técnico de identidade `feature005_test_identity`, criado no banco descartável recém-provisionado. Sondagem de permissão CREATE TABLE foi executada em transação e revertida.

### Recursos reais exclusivos de testes

Run ID: `35eb2feadec9`. Apenas um PostgreSQL criado; nenhum servidor de outra versão.

| Recurso                            | Identidade                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Rede interna sem portas publicadas | `feature005-test-35eb2feadec9-network`                                                                         |
| PostgreSQL container               | `feature005-test-35eb2feadec9-postgres`, ID `d6673c8b5fbb956a53df842d505656cd8fbd5606302b68dd1025af11af9c5460` |
| Volume PostgreSQL                  | `feature005-test-35eb2feadec9-postgres-data`                                                                   |
| Banco e usuário não-superuser      | `feature005_test_35eb2feadec9`                                                                                 |
| MinIO container                    | `feature005-test-35eb2feadec9-minio`, ID `265b18d5957777d84765335274966dd1a1341733c14aef715b48f6743565cfee`    |
| Volume MinIO                       | `feature005-test-35eb2feadec9-minio-data`                                                                      |
| Bucket e usuário MinIO limitado    | `feature005-test-35eb2feadec9`                                                                                 |

Imagens locais imutáveis por image ID:

- PostgreSQL: `sha256:eb0fb2377534e65aad04f37838956b3dfb888e1a3dd3c1acf957bc6557eb6c7d`, servidor autenticado `17.11 (Debian 17.11-1.pgdg13+2)`.
- MinIO: `sha256:95713554f0875afdab500a38ccae2fa397b461c9867105072aca2204a938d6f9`, Community `RELEASE.2025-10-15T17-29-55Z`, commit9e49d5e. Reutilização apenas de bytes da imagem local; nenhum container/volume/rede/credencial da Feature003 utilizado ou alterado.
- Runner API: `sha256:9df6780832b95564d1a5ed153eebbf36bdce8b2ef12e0f295614a977134d7440`, qpdf12.3.2 existente, sem rebuild/install.

Todos os recursos recebem label `io.alvesglass.feature005.run=35eb2feadec9`. Containers/volumes foram correlacionados por IDs/labels/mounts, e a rede interna contém somente os dois serviços novos. Ambos limitados a512MiB/1CPU/64PIDs, sem restart automático; runner efêmero também com limites, rootfs read-only, cap-drop ALL/no-new-privileges/tmpfs64MiB noexec/nosuid e UID1000. Serviços permanecem ativos para próxima autorização; volumes conservados. Não há rotinas automáticas de teardown ou purge.

### Preflights reais aprovados

- PostgreSQL autenticado: major17, database/current_user/owner corretos; sem superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS. Recibo com nonce SHA256 confere e usuário não pode alterá-lo. Senha incorreta negada com28P01. CREATE no public permitido, sondagem revertida; schema público continua vazio. Sem migrations existentes executadas.
- MinIO: administrador separado do usuário limitado. Bucket novo sem política anônima, versionamento Disabled e sem Object Lock/retention. Marcador root-owned com nonce do run confere; app pode ler, mas Put/Delete nesse marcador são negados. Credenciais inválidas negadas; criação de bucket e PUT fora de budgets-pdf/ negados.
- Anonymous GET do marcador e de objeto existente + listagem:403. PUT/stat/GET/Range/listagem por prefixo/DELETE/DELETE repetido e ausência final conferidos com SDK real. Objeto sintético do smoke removido; marcador de identidade preservado. Não foi upload comercial nem exercício completo de lifecycle.
- `listBuckets` nesta versão retorna lista filtrada ao bucket permitido mesmo com Deny ListAllMyBuckets. Preflight confere que não revela outro bucket; não se alega AccessDenied nessa operação. Sem bucket estrangeiro criado para comparação nesta etapa.
- qpdf runtime preflight/smoke real aprovado, `ready:true,version:12.3.2`, UID1000 e cgroup inspecionado dentro do runner. Não equivale a matriz completa de warnings/senha/overshoot T022.

### Código, evidências e repetição segura

- Scripts exclusivos: `tests/support/budgets/provision-isolated.py`, `verify-resources.py` e `preflight.js`; guard `environment.js`/unidades e teste schema ajustados para17 somente.
- Estado sensível: `/tmp/feature005-t021-7gg672ji` (diretório0700, envs/credenciais0600, fora do Git). Não publicar/copiar conteúdo dos envs em logs. `app.env` não possui root credentials; `provision.env` é somente bootstrap. `BUDGETS_SCHEMA_EXECUTION_APPROVED` permanece ausente.
- Manifesto: `/tmp/feature005-t021-7gg672ji/resources.json`; identidade Docker verificada em `infrastructure.json`; preflight autenticado em `verify.log`. Logs de síntese: `/tmp/feature005-t021-infrastructure.log`, `/tmp/feature005-t021-unit.log`. Snapshot de preservação: `/tmp/feature005-t021-before.json`.
- `provision-isolated.py` exige FEATURE005_T021_APPROVED=1, branch correta, nomes novos e imagens locais exatas. **Não reexecutar para validar o run atual**: criaria outro ambiente; utilize somente verify-resources.py com manifesto explícito e modo verify do preflight com app.env/rede/limites do mesmo run.
- Falhas iniciais preservaram os MESMOS recursos: arquivo IAM0600 exigiu UID1000 para leitura com cap-drop ALL; retomada explícita permitiu só bucket novo ainda vazio. Preflight foi corrigido para comportamento real de listBuckets; política recebeu Deny explícito. Nenhum recurso adicional PostgreSQL/MinIO foi criado para essas correções. Sem download de executável: tentativa de checksum de mc retornou410, abandonada; bootstrap usou import IAM rawZIP do servidor pinado, assinado com primitiva do SDK existente.
- Unidades orçamento:68 aprovadas/zero falhas/skips, incluindo guard que rejeita versões ausentes/alternativas. Prettier, node --check, compile Python e git diff --check conferidos ao final.

### Pendências e prontidão para T022

Ambiente apto a receber a próxima etapa **após autorização separada**. T022 não executada: nenhuma migration CLI/cadeia/upgrade/down, lifecycle/concorrência, worker ativo/bootstrap real, revisão integral T007 ou aceite de recuperação. G1 bloqueado. Segredo de cursor, ator técnico de reconciliação, bootstrap worker, ensaios de timeout/overshoot, build fixado e SQL de T008–T013 continuam pendentes conforme seus critérios. Recursos são temporários de testes e não modelo de produção; sem deploy/endpoints/commit/push/PR. Se `/tmp` for limpo ou recursos expirarem, refazer identidades/preflight antes de qualquer integração futura, nunca reutilizar nomes/flags como prova de ownership.

## Histórico anterior a T021 (não constitui status operacional atual)

**Raiz**: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.
**Status atual (2026-11-17)**: G0 liberado conforme evidências posteriores; T005/T006 verdes, fundação T008–T020 implementada com pendências descritas abaixo. G1 bloqueado. Nenhuma migration executada ou conexão a PostgreSQL/MinIO nesta etapa. Histórico das primeiras execuções preservado nas seções posteriores.

## Entrega limitada T016–T020 — 2026-11-17

- Worktree/branch confirmados; snapshot dos arquivos anteriores em `/tmp/feature005-t016-before.json`. Alterações anteriores preservadas, sem modificação de Features 003/004, Dockerfile, lockfile ou migrations nesta etapa.
- T016: `BudgetPdfRuntimeService.js` executa `/usr/bin/qpdf --version` com argv/env fixos e limites; exige 12.3.2 (mais restritivo que piso 12.2) e valida PDF sintético com o adaptador real. Preflight lazy/single-flight bloqueia somente uploads 005; falhas permitem nova tentativa. Dockerfile já contém Node22/base digest/APK12.3.2-r0; nenhum rebuild nesta etapa. Novo preflight real na imagem existente retornou `{ready:true,version:"12.3.2"}`. Aceite de build/contenção continua T021/T022.
- T017: `BudgetPdfStorageService.js` usa factory/config MinIO existente, com cliente dedicado e transport request/AbortSignal por AsyncLocalStorage (sem mutar cliente legado). Config aceita MINIO_PRIVATE_BUCKET ou alias isolado MINIO_BUCKET_PRIVATE, rejeita conflito/bucket público declarado. Prova WeakMap de bytes qpdf, UUID por tentativa, intenção existente/lease corrente confirmada em transação antes PUT, heartbeat15s, PUT/stat30s, stream60s/quatro concorrentes, get/range/remove privados e listagem limitada ao prefixo. Nenhuma URL/DTO público ou anexação. ACL efetivamente privada, ausência anônima, versionamento/retention e cancelamento remoto exigem MinIO real. Timeout não prova que PUT remoto foi cancelado: registry terminal permanece recuperável.
- T018: `BudgetPdfCleanupWorker.js` oferece tick/run/processClaim e reconciliadores por injeção. Poll5s/lote25/lease2min; claim commitado, depois guard orçamento/linha/objeto e token/lease PostgreSQL + ambos slots antes DELETE/stat; I/O sob lock dedicado limitado a duas chamadas30s; renovação na entrada cobre essa janela. Erro gera retry5s exponencial até1h+jitter até999ms; interrupção após DELETE conserva claim para repetição idempotente. UPLOADING expirado perde token; READY órfão usa graça24h; REMOVED não é purgado e é revisto por keyset. Prefixo é varrido em páginas25 a cada24h (um ciclo completo), sem bucket-wide delete; restart reinicia cursor de forma segura. Objetos desconhecidos com idade24h são registrados antes de limpar; requer reconcilerActorId de User técnico provisionado, pois registry exige autoria FK. Sem ator: alerta, sem remoção. Chaves malformadas: alerta, sem remoção. CLI/runner falham fechados com BUDGET_WORKER_OPERATIONAL_PREFLIGHT_REQUIRED_T021; bootstrap operacional ainda depende de identidade/ACL autorizadas. Nenhum worker real foi iniciado.
- T019: unidades com relógio/falhas injetados cobrem duas instâncias/token vencido, slots protegidos, retry, queda após delete/restart, intenção expirada, reaparecimento tardio, prefixo/graça/ator técnico e tick repetido. Testes de repository verificam SQL/ordem/limites sem alegar execução no servidor. Concorrência real/SKIP LOCKED/cancelamento de backend precisam T007/T021/T022.
- T020: `BudgetContractService.js` implementa allowlist estrita, número Unicode exato1..64 sem controles/trim/normalização, nome1..240, calendário gregoriano0001..9999, dia civil São Paulo, expiração sem excluir data de hoje, ETag forte/revisão bigint string/428/412, limit25/100, cursor HMAC-SHA256 com segredo mínimo32bytes/ator/escopo/filtros/ordem/posição/TTL15min e erros sanitizados. Sem integração de endpoints ou permissões implícitas. Provisionar segredo e chamar reautorização fora do cursor são obrigações das futuras histórias.

### Evidências e limites

- `yarn test:budgets:unit` na imagem existente `alves-glass-api:feature005-qpdf-20261117040200-verified`: **67 aprovados, zero falhas/skips**; `/tmp/feature005-t016-unit.log`. Sem rede, rootfs read-only, worktree read-only, cópia descartável em tmpfs64MiB e node_modules já presentes na imagem. Não foi ensaio de contenção operacional T021.
- Host: comando executado, mas imports bloqueados pela ausência de Sequelize/node_modules; nenhuma instalação. `/tmp/feature005-t016-host-unit.log`.
- Regressão focada configuração/migrations: **6 aprovados**, `/tmp/feature005-t016-regression.log`. Primeira tentativa do harness omitiu `.sequelizerc`; cópia corrigida, testes não alterados.
- Preflight qpdf real: `/tmp/feature005-t016-runtime.log`. Não equivale à matriz/gate T022.
- Prettier, `node --check` e `git diff --check` conferidos nos arquivos alterados.
- Checkboxes T016–T020 mantidos abertos conservadoramente: implementação/unidades não fecham dependências operacionais de T013/T014/T015. T019/T020 têm escopo unitário implementado/verde; T016/T017/T018 ainda exigem integração/boot autorizado.
- Próximo passo possível é **planejar** ambiente isolado T021, mediante autorização posterior. Antes: completar revisão/expansão T007, cadeia/upgrade/down/constraints em PostgreSQL 17, comprovar T008–T013 e autorização T014, contenção qpdf T015/T016, ACL/bucket privado T017 e recuperação/worker T018. T022 continua futuro e bloqueante. Não houve início de T021/T022 nem histórias.

## Leitura e revisão agora

Ler spec.md → research.md → data-model.md → contracts/http-api.md → contracts/storage-lifecycle.md → plan.md, todos sob /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf.

Histórico do planejamento: G-PDF fechado e tasks.md aprovado, sem reexecução de plan/tasks nesta fase. Agora somente T001–T004 autorizam suporte de testes/fixtures e comandos em package.json; imagem/validador/domínio continuam fora do escopo. Nenhum parser de aplicação ou instalação qpdf foi acrescentado. Templates/.specify e mudanças locais anteriores permanecem preservados.

## Pré-requisitos futuros — não executar agora

1. Ambiente isolado específico de 005 com nomes/volumes/buckets/rede próprios aprovados; não usar rede/volumes/referências de recuperação 004 ou infraestrutura compartilhada. Confirmar identidade do destino por configuração externa, nunca copiar secrets.
2. PostgreSQL 17 em ambiente descartável exclusivo de testes; versão única conforme decisão arquitetural; Sequelize CLI convencional/public.SequelizeMeta, cadeia completa do zero e upgrade com fixture legada. Nunca sync ou migration antiga editada.
3. MinIO privado, prefixo dedicado, conta técnica de menor privilégio, TLS fora do teste isolado, sem leitura anônima e sem retenção/versionamento incompatíveis com exclusão. Integrar qpdf na imagem Node 22 Alpine, fixar versão/revisão/base compatíveis e verificar --version; validar ambos os subprocessos, sandbox/recursos/timeout e fixtures benignas. Piso planejado 12.2 + smoke semântico, nunca aceitar só por número de versão.
4. Dados sintéticos: admin, gerente setorial, colaborador por operação e sem concessão, dois clientes, dois setores, legados incompletos. Nenhum dado/arquivo de cliente real.
5. Worker/reconciliador de orçamento com heartbeat, lease/fencing e métricas. Não executar worker atual de Material contra objetos novos presumindo referências compatíveis.

## Jornadas de demonstração futura

1. Criar privado com número 00042 e data civil; confirmar UUID/autoria, 201 mínimo e ausência no portal.
2. Publicar candidato por ação PUBLISH com If-Match; consultar portal proprietário e baixar/visualizar; outro cliente recebe 404.
3. Preparar B, depois C: B privado é substituído somente após confirmação, A publicado preservado. Falha no PUT/CAS de C mantém B; falha de limpeza de B mantém C único pendente.
4. Publicar C com validade nova: troca atômica de PDF/data, A inacessível mesmo por URL anterior e remoção eventual verificável.
5. Primeiro publish bloqueia definitivamente cliente/setor/número; nome continua corrigível. Validade nova sem arquivo é rejeitada.
6. Na data de validade em São Paulo continua válido até fim do dia; no dia seguinte expired=true sem bloquear bytes.
7. DELETE autorizado com confirmBudgetId e If-Match: 202, portal 404 imediato após commit, mesmo MinIO indisponível. Retomar worker e confirmar ausência de todos os arquivos, incluindo PUT tardio.
8. Delegar somente as cinco operações por gerente no setor; nomeação/MANAGE_PERMISSIONS por não admin e autoconcessão por qualquer ator são negadas e não alteram grants.

## Matriz de testes planejados

| Grupo                | Cobertura e critérios                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unitário domínio     | RF-001..007, número/texto exato, datas válidas/passadas, sem valores/itens, autoria da sessão                                                                                                                                                    |
| Unitário autorização | RF-029..035, admin global, manager setorial, cada grant, READ por setor sem autor, sem autoconcessão/autoelevação e auditoria                                                                                                                    |
| Unitário PDF         | DT-01: falso PDF, truncado, vazio, 10 MiB/excesso, senha, warning/recovery, matriz distinta de --requires-password/--check, timeout, ENOENT/EACCES, crash/sinal, limites de saída/RSS, shell:false, limpeza e mesmos bytes; sem extração/rewrite |
| qpdf real na imagem  | Pacote/versão fixados; plain→sondagem 2/check 0; abrível com senha vazia→sondagem 3/check 0; senha necessária→sondagem 0/rejeição; check 2/3 rejeitados; nenhum arquivo inválido chega ao MinIO; não logar saídas sensíveis                      |
| Contratos HTTP       | RF-017..024 e RF-036..038: payload strict, status/erros, CSRF/Origin, ETag/428/412, lista 25/100, cursor scope/HMAC, portal mínimo, inline/attachment/Range                                                                                      |
| PostgreSQL real      | UNIQUE corrida, constraints cruzadas/slots, trigger imutabilidade, transaction rollback, DATEONLY, grants/revokes/auditoria atômicos, cadeia migrations nova/upgrade e down protegido                                                            |
| MinIO real isolado   | PUT/stat/get/remove privado, ausência anônima, chaves únicas, novo pendente versus anterior, proxy sem presigned URL, sem apagar referenciado                                                                                                    |
| Falhas/recovery      | RF-008..016/025..028: crash depois de intenção/PUT/commit/DELETE, duas instâncias worker, lease expirado/token velho, PUT tardio depois de cleanup, órfão desconhecido/grace e retry após restart                                                |
| Corridas             | Dois cadastros iguais: único; dois uploads mesma revisão: um vence/412; publicação/upload/DELETE e grant revoke/stream sem stale attach ou arquivo perdido                                                                                       |
| Revogação            | Stream antigo termina/aborta antes commit de troca/exclusão; URL/Range posterior reautoriza e não recupera anterior; sessão/membership revogados negam próximo pedido                                                                            |
| Legado               | RF-039..042: tabela/bytes antigos preservados, nenhum número/setor/autor fictício ou publicação; POST /budged preservado sem alteração; desativação e comunicação em iniciativa futura independente                                              |
| Regressão            | Contratos/testes existentes 002/003/004 continuam válidos, nenhuma sincronização de estoque/OS, nenhum model antigo editado por conveniência                                                                                                     |

Usar node:test/assert existentes e dependency injection. O comando yarn test:budgets:unit agora executa somente os testes locais de setup sob /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/unit/budgets. Contratos e integração ainda não têm suítes; seus comandos falham explicitamente em vez de apresentar execução vazia como sucesso. Não reutilizar indiscriminadamente test:integration que inclui outras features. Nenhum comando novo provisiona serviços ou executa migrations.

## Evidência operacional para release

Registrar versões reais sem secrets, resultados/pass-fail, contagens/checksums legados, backlog/idade antes/depois, retries e falhas injetadas, ausência de leitura pública e de acesso por URL antiga. Limites de 2 uploads/4 streams por processo e pool devem ser ensaiados, não tratados como benchmark comprovado. Testar lock timeout, desconexão, abort e escassez de pool para não bloquear autenticação.

Ensaio de rollback sem drop de dados novos: desabilitar mutações, preservar confidencialidade/limpeza, reconciliar registry e backup. Não ativar endpoint legado inseguro para voltar versão. Não executar rollout/cutover ou webhook sem aprovação posterior.

## Condição de saída do planejamento

Artefatos presentes/coerentes, 42 RF preservados e Constitution Check documental concluído. A implementação de setup está limitada a T001–T004, sem fundação/domínio/HTTP. Integração/pin de qpdf, recursos, bucket, reconciliação e ensaios continuam futuros. O registro abaixo diferencia preparação local de prova operacional.

## Registro T001 — baseline e transição, sem acesso externo

Worktree confirmado: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005; branch feature/005-budgets-pdf; HEAD f89fce5570af6125657bf67ced5a14ad8a1f7db4. Estado inicial: .specify/feature.json modificado e .specify/templates/ mais specs/005-budgets-pdf/ não rastreados, preservados. Snapshot SHA-256 local dos arquivos anteriores usado para verificar ausência de alteração em src, migrations, Docker, yarn.lock e Features 003/004. Não fazer reset/checkout/clean para normalizar esse estado.

Baseline dos contratos: o registro legado é POST /budged em src/routes.js, após autenticação global, com requireAdmin e upload.single('file'). Não foi chamado nem declarado funcional. Os contratos aprovados novos continuam em contracts/http-api.md e storage-lifecycle.md, sem rotas novas implementadas. SHA-256 de src/routes.js: 2bdea9cfa078cc7a4611a9a7f9c01560dc0c4586f466d5785067a3a71119b5d4. Hash de yarn.lock: 2f319685dd4556656b36a81e999cc01bf04085a35635ef5bc1c96ed8e9ab4897. UUID, 42 RF, cinco histórias e oito SC inalterados; nenhum grant/role/contrato 003/004 foi modificado.

Inventário de consumidores **planejado**, não presumido: busca local em src/tests/docs encontrou a composição de POST /budged e métodos de BudgetController/BudgetService; documentos de auditoria citam defeitos. Não foi localizado consumidor HTTP de frontend neste backend. Consumidores externos permanecem desconhecidos: responsável pelo produto deve inventariar frontend/integrações, versões/payloads, responsáveis e janela de transição antes de futura retirada. Nenhum cliente foi comunicado ou migrado por esta execução, nem há desativação nesta feature. Sem adaptação automática do contrato legado.

Preservação/reconciliação futura: antes de copiar dados reais, inventário autorizado de contagens/UUIDs/clientes/nulos/datas com offset/setor/número/autoria/objetos/ACL; backup recuperável de PostgreSQL e objetos e ensaio de restauração isolado. Preservar tabela budget e campos monetários históricos sem novos writes comerciais; sem setor/número/autor fictício ou publicação automática. Origem de data ambígua/autoria desconhecida permanece quarentenada. Importação futura somente com mapa aprovado, idempotência, contagens/checksums antes/depois e publicação manual posterior. Não importar agora nem criar baseline customizado.

Rollback/cutover futuro: migrations novas aditivas, down protegido de tabelas não vazias, desligar mutações novas sem reativar endpoint inseguro, manter confidencialidade e executor de limpeza, reconciliar registry/bytes e backup antes de mudança de versão/dados. Nenhum restore, exclusão, migração, ACL ou operação de infraestrutura foi executado. T001 registra procedimento; T030/T064 vão detalhar/ensaiar, sem autorização implícita de dados reais.

## Registro T002 — guard inerte de isolamento

Arquivo: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/environment.js. Nenhum dotenv, import da aplicação, DNS, socket, conexão, provisionamento ou cleanup. Rejeita configuração ausente/ambígua antes de spawn/import de integração. Foi evitado suporte genérico que importa módulos ausentes de src/infrastructure; não reintroduz baseline/metadata paralelos.

Contrato declarado: NODE*ENV=test, RUN_BUDGETS_INTEGRATION=1, BUDGETS_TEST_RUN_ID hexadecimal de 8–32 caracteres. Nomes exatos derivados do runId: DB_DATABASE/DB_USERNAME=feature005_test*{runId}; MINIO_BUCKET_PRIVATE/MINIO_ACCESS_KEY=feature005-test-{runId}; BUDGETS_TEST_NETWORK=feature005-test-{runId}-network; BUDGETS_TEST_POSTGRES_VOLUME=feature005-test-{runId}-postgres-data; BUDGETS_TEST_MINIO_VOLUME=feature005-test-{runId}-minio-data. Credenciais DB_PASSWORD/MINIO_SECRET_KEY só em ambiente externo, mínimo16 caracteres, nunca registradas/retornadas pelo guard.

Endpoints allowlisted: loopback com DB_PORT=55435 e MINIO_PORT=59005, ou containers dedicados feature005-test-postgres:5432 e feature005-test-minio:9000; MINIO_USE_SSL=false somente nesse ensaio isolado. Não copiar portas/volumes/destinos atuais compartilhados. DATABASE_URL/PG\*/MINIO_BUCKET legado e configurações de broker/MongoDB conflitantes reconhecidas são rejeitadas. O runner entrega somente campos explicitamente permitidos, sem carregar .env; NODE_OPTIONS e DOTENV_CONFIG_PATH são bloqueados.

**Limite de segurança**: nomes e portas declarados não provam identidade/ownership do servidor remoto. O guard não autoriza DROP/limpeza nem certifica destino descartável; verificação autenticada de identidade/recibos/ACL e provisionamento aprovado ainda são gate T021. Nada foi conectado para testar esse contrato. Não configurar serviços existentes para satisfazê-lo nesta etapa.

## Registro T003/T004 — concluído com qpdf na imagem da API

A solicitação posterior autorizou somente a integração Docker e o aceite T003/T004.
O bloqueio histórico de qpdf ausente no host foi resolvido **na imagem**, sem instalar
nada no host. T001–T004 concluídas; G0 liberado para planejamento da fundação mediante
nova autorização. T005–T066 permanecem não iniciadas; G1 não está comprovado.

### Imagem e versionamento

Dockerfile: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/docker/dockerfile.
Uma etapa única de build/runtime; qpdf não é serviço separado. Base Node 22 Alpine
fixada no digest sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a.
Observados: Node v22.23.5, Alpine 3.24.4, Yarn Classic 1.22.22, qpdf 12.3.2,
qpdf e qpdf-libs APK 12.3.2-r0; binário executável /usr/bin/qpdf, UID efetivo 0,
preservando o usuário herdado do Dockerfile anterior. WORKDIR, CMD, permissões,
instalação frozen-lockfile e smoke de argon2 preservados. A base flutuante anterior
não fixava uma versão patch de Node; o digest congela a resolução inspecionada.

A atualização exige revisão conjunta de digest/base, revisão APK exata, build e
reexecução das fixtures. Não usar edge, fallback ou atualização silenciosa. O pin
falha se a revisão APK desaparecer do repositório: para retenção duradoura,
será necessário arquivo/mirror controlado. Dependências transitivas APK não são
um snapshot imutável completo; não se alega build bit-a-bit reproduzível.

Build isolado inicial aprovado: alves-glass-api:feature005-qpdf-20261117040200.
O ID da imagem efetivamente usada no primeiro ensaio está em qpdf-observed.json.
Rebuild com evidência e testes atualizados também aprovado:
alves-glass-api:feature005-qpdf-20261117040200-verified,
ID sha256:9df6780832b95564d1a5ed153eebbf36bdce8b2ef12e0f295614a977134d7440.
Nele, os 11 testes e os oito PDFs/três limites foram reexecutados com sucesso.
Contratos ausentes e integração/worker sem opt-in retornaram código 1, como esperado.
Nenhuma tag existente da API foi substituída, nenhum Compose alterado, e nenhum
container existente iniciado, parado ou modificado.

### Reproduzir sem iniciar API ou acessar serviços

```sh
set -eu
ROOT=/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005
cd "$ROOT"
IMAGE="alves-glass-api:feature005-qpdf-$(date +%Y%m%d%H%M%S)"
docker build --progress=plain -f "$ROOT/docker/dockerfile" -t "$IMAGE" "$ROOT"
ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --entrypoint sh "$ID" \
  -c 'node --version; yarn --version; qpdf --version; id; command -v qpdf; test -x /usr/bin/qpdf'
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=$ROOT/tests/fixtures/budgets,dst=/app/tests/fixtures/budgets,readonly" \
  --entrypoint node "$ID" /app/tests/support/budgets/verify-qpdf-fixtures.js "$ID" \
  > /tmp/feature005-qpdf-recheck.json
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint yarn "$ID" test:budgets:unit
```

Não copiar o relatório para a evidência versionada sem revisar divergências.
O verificador não escreve nas fixtures, valida hashes antes/depois, usa spawnSync
sem shell, timeout 10s, saída limitada, concorrência um e diretório temporário
privado (arquivos 0600) removido em finally. Binário ausente/timeout/sinal falham
fechado. Esse suporte é exclusivo de testes, não PdfValidationService.

### Resultado real das fixtures

| Arquivo               | --check | --requires-password | Política futura      |
| --------------------- | ------: | ------------------: | -------------------- |
| plain.pdf             |       0 |                   2 | accept               |
| password-required.pdf |       2 |                   0 | passwordRequired     |
| empty-password.pdf    |       0 |                   3 | accept               |
| warning-xref.pdf      |       3 |                   2 | invalidPdf           |
| corrupt.pdf           |       2 |                   2 | invalidPdf           |
| truncated.pdf         |       2 |                   2 | invalidPdf           |
| renamed-non-pdf.pdf   |       2 |                   2 | unsupportedMediaType |
| empty.pdf             |       2 |                   2 | invalidPdf           |

Os oito hashes e bytes originais foram preservados; nenhuma expectativa foi
ajustada. Código 2 de requires-password em arquivo inválido não autoriza aceite:
check separado deve retornar somente 0. Não usar --warning-exit-0.
A classificação HTTP do não-PDF depende futuramente da checagem de assinatura.
Limites 10485759/10485760/10485761 bytes gerados temporariamente: check=0 e
requires-password=2 em todos; o último deve ser rejeitado por tamanho, não pelo
parser. Não se alega implementação do upload nem garantia malware-free.

### Comandos e validação T004

Scripts preservados: yarn test:budgets:unit, yarn test:budgets:contract,
yarn test:budgets:integration e yarn budgets:cleanup-worker. Runner em
/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/run.js.
Unidade elimina configuração herdada de conexões e não importa clientes. Guard
precede descoberta/import/spawn de integração/worker. Suítes ausentes falham
BUDGET_SUITE_NOT_IMPLEMENTED; worker ausente falha
BUDGET_WORKER_NOT_IMPLEMENTED_T018 quando o guard é satisfeito, sem executá-lo.
Sem opt-in, integração/worker falham antes de qualquer infraestrutura.

Validação atual: 11 testes unitários aprovados, zero falhas/skips; inclui
negativos do guard, subprocessos reais do runner, rejeição de evidências
adulteradas, reprodução/hashes e limites. node --check em todos os seis JS de
setup/fixtures e git diff --check aprovados. Scripts legados/dependências e
lockfile preservados. A presença de qpdf não implementa timeout/concorrência/
temporários no serviço futuro: esses requisitos continuam obrigatórios nas
tarefas próprias, não executadas nesta etapa.

Nenhuma aplicação, endpoint, migration, PostgreSQL, MinIO ou worker iniciado.
Sem deploy, instalação no host, commit, push ou PR. T021 continua exigindo
provisionamento e identidade/ACL reais exclusivos; nomes declarados pelo guard
não provam ownership e não autorizam limpeza. G0 não substitui G1 nem libera
endpoints ou produção. Parada após T004 conforme solicitado.

## Execução de fundação limitada T005–T010 — 2026-11-17

Branch/worktree confirmados e snapshot de hashes dos arquivos preexistentes em
/tmp/feature005-foundation-before.json. Alterações anteriores preservadas; nenhuma
migration histórica, Docker, package.json, yarn.lock ou documento 003/004 alterado.
A tabela budget não foi consultada/modificada e não há cópia/seed de legado.

### Entregáveis e limites de aceite

- T005: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/unit/budgets/authorization.test.js.
  Sete testes de admin/status, manager/membership/setor, seis grants independentes,
  READ sem autor, ausência de grants OS/estoque, portal próprio/publicado e delegação
  sem autoconcessão/ampliação. Factory/repository injetável propostos nos comentários;
  não são API HTTP ou implementação aprovada de T014. Todos vermelhos com marcador
  T014_PENDING antes de import inexistente. Não demonstram segurança funcional ainda.
- T006: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/unit/budgets/pdf-validation.test.js.
  Nove testes com processo fake: probe/check distintos, assinatura/tamanho/hash,
  zero continuação para PUT nos negativos, shell:false, permissões de temporários,
  ENOENT/EACCES/erro/sinal/crash, timeout agregado, SIGKILL/await, canais 64 KiB,
  RSS 256 MiB e concorrência dois. Vermelhos T015_PENDING; não são prova do futuro
  watchdog, contenção cgroup ou segurança do adaptador real. O fake e a interface
  deverão ser exercitados/reconciliados em T015 sem enfraquecer expectativas.
- T007: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/integration/budgets/schema.postgres.test.js.
  Esqueleto executável bloqueante com cadeia CLI/public.SequelizeMeta desde baseline
  vazio, fixture legada sintética em upgrade, negativos de constraints/slots/FKs/
  índices/auditoria/imutabilidade e down com dados. Nenhum socket/DDL nesta execução.
  Ainda requer ensaio/revisão da cadeia completa, mais negativos de lifecycle e
  rollback vazio em alvos novos distintos, PostgreSQL 17; não alegar cobertura
  ou compatibilidade real já demonstrada.
- T008–T010: três migrations CommonJS novas, transacionais, schema public explícito,
  timestamp acima do máximo anterior 20261126000000; sem editar histórico.

### Persistência entregue como código, não aplicada

Diretório: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/src/database/migrations/.

1. 20261127000000-create-budget-commercial-authorization.cjs: managers, permissions
   com PKs compostas, seis operações, FKs RESTRICT, auditoria com ações enumeradas,
   proteção UPDATE/DELETE/TRUNCATE e índices. Sem roles, seed ou membership implícito.
2. 20261128000000-create-budget-pdf-objects.cjs: UUID/owner sem FK ao orçamento,
   chave única, estados/leases/retry, limites e metadados obrigatórios em READY/
   ATTACHED, datas civis e índices de recuperação. expected_revision nullable para
   criação; distinguir criação/substituição depende do caso de uso futuro, pois o
   registry sobrevive ao pai e não se pode inferir esse contexto com CHECK local.
3. 20261129000000-create-budgets-pdf.cjs: UUIDs/FKs RESTRICT, número COLLATE C único
   no setor, nome, revision, pares de slots imediatos, pertencimento composto,
   slots únicos, índices keyset e proteção do primeiro marco de publicação.
   Os demais triggers de lifecycle, identidade/autoria e revision pertencem a T011.

Cada up exige a migration anterior em public.SequelizeMeta. Cada down bloqueia
escrita com ACCESS EXCLUSIVE e recusa tabelas não vazias antes de DROP; registry
terminal também impede perda. Sem CASCADE. Nenhum comando de migration executado.
Models e Repositories não criados: são T012/T013, após T011.

### Testes observados

```sh
cd /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005
node --test tests/unit/budgets/migrations.test.js tests/unit/budgets/setup-environment.test.js tests/unit/budgets/setup-fixtures.test.js
yarn test:budgets:unit
```

- Primeira execução dos testes de migrations: quatro falhas por artefatos ausentes;
  depois da implementação: quatro verdes, com queryInterface fake, sem SQL real.
- Subconjunto local acima: **16 testes verdes, zero falhas/skips**.
- Comando completo Yarn: **32 testes, 16 verdes e 16 falhas esperadas**
  (7 T014_PENDING, 9 T015_PENDING), zero skips. Esse comando **não está verde**;
  T005/T006 são contratos red-first, não testes de implementação concluída.
- Invocação direta da integração com NODE_ENV=test: código 1,
  EXPLICIT_OPT_IN_REQUIRED, antes de import/conexão.
- Teste de subprocesso com declarações sintéticas allowlisted: código 1,
  T007_BLOCKED_T011_REQUIRED, sem importar pg/Sequelize. Worker continua ausente.
- node --check e git diff --check executados; nenhum install ou lockfile modificado.

### Pré-requisitos ainda bloqueantes para integração

Não há autorização/preparação T021: não provisionar ou adaptar containers existentes.
O teste exige T011/T012 locais, guard T002 completo, autorização operacional específica
BUDGETS_SCHEMA_EXECUTION_APPROVED=1, versão esperada BUDGETS_TEST_POSTGRES_MAJOR=17
(evidência do alvo único PostgreSQL17) e token externo BUDGETS_TEST_IDENTITY_TOKEN
(64 hex, não versionar). T021 deverá preparar recibo remoto
feature005_test_identity.receipt(run_id,token_sha256) em schema separado de public,
protegido contra escrita do usuário do teste. O preflight lê recibo autenticado,
database/current_user/owner/major e recusa superuser/CREATEDB/CREATEROLE; exige public
vazio. Nomes/flags isolados não substituem provisionamento e inspeção ACL reais.
O recibo ainda não foi criado, nem sua ACL comprovada. Não executar CLI manualmente
para contornar gates; o runner só encaminha flags explícitas após o guard.

### Segurança e prontidão

**Runtime atual UID 0/root é pendência de hardening antes de produção.** Registrar
migração futura para usuário não privilegiado, permissões de temporários/binário e
revalidação de qpdf/cgroup; nenhum ajuste Docker fora do escopo foi feito agora.
Nenhum endpoint, aplicação, banco/MinIO, worker ou container foi iniciado/modificado.
Sem deploy, commit, push ou PR. G0 histórico permanece concluído; G1 não liberado.
T011–T022 não iniciadas, dependem da revisão das migrations e dos ensaios futuros.
Parada após T010; checkbox conservador aberto em T005–T010 até prova dos critérios.

## Execução posterior T011–T015 — 2026-11-17

Esta seção supersede o status red-first da execução anterior, não seus resultados
históricos. Worktree/branch confirmados. Snapshot de preservação:
/tmp/feature005-t011-before.json. Nenhuma migration histórica, Docker, lockfile,
package.json, Feature 003/004, identidade global ou tabela budget alterada.

### Código entregue

Raiz absoluta: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.

- src/database/migrations/20261130000000-enforce-budget-pdf-lifecycle.cjs:
  triggers de identidade/autoria/created_at, revision +1, identidade pós-publish,
  publicação somente do par pendente, READY para novos slots, expected_revision,
  transições sem reanexação, metadados confirmados imutáveis, registry sobrevivente,
  proteção TRUNCATE e integridade final deferred nos dois lados. Pares/CHECKs/FKs
  T010 não duplicados. Down somente com tabelas vazias sob lock exclusivo.
- src/app/models/BudgetPdf.js, BudgetPdfObject.js, BudgetCommercialManager.js,
  BudgetCommercialPermission.js e BudgetCommercialPermissionAudit.js: mapeados e
  registrados em src/database/index.js sem sync. DATEONLY civil, BIGINT textual,
  PKs compostas, FKs RESTRICT; collation C, ownership composto e triggers são
  autoritativos nas migrations, não expressáveis por completo no metadata Sequelize.
- src/app/repositories/BudgetPdfRepository.js, BudgetPdfObjectRepository.js e
  BudgetCommercialAuthorizationRepository.js: recebem transação ativa do caso de uso;
  advisory locks por domínio/ordem, row locks, leitura após lock, CAS textual bigint,
  fencing token/lease, claim SKIP LOCKED após guard do orçamento e reference check
  publicado/pendente. Não iniciam conexões, não fazem cleanup MinIO e não usam Material.
- src/app/services/BudgetAuthorizationService.js: factory com repository real/injetável,
  admin ativo global, manager/membership/setor, seis grants independentes, READ sem
  autoria, cliente próprio/publicado, sem autoconcessão e sem delegação gerencial por
  não-admin. authorizeOperations reserva guards de múltiplos setores em ordem.
  Identidade provém da sessão existente, nunca do corpo. Não cria role global.
- src/app/services/BudgetPdfValidationService.js: factory com spawn real por default;
  assinatura binária exata, 10 MiB, snapshot dos bytes e SHA-256, dois processos
  separados, argv fixo/caminho absoluto, stdin fechado/env mínimo/shell:false,
  timeout agregado 10s, 64 KiB por canal, RSS Linux 256 MiB/50ms, duas validações
  por processo, reserva temporária máxima 64 MiB (dois arquivos <=10 MiB),
  mkdtemp0700/arquivo0600 exclusivo, abort/SIGTERM/escalada SIGKILL/await close/finally.
  Retorna bytes validados sem realizar PUT. Sweep inicial preguiçoso e método explícito
  conservam PID vivo/diretório recente/symlink; removem só prefixo dedicado antigo
  com dono local e PID comprovadamente inexistente. PID reutilizado é retido.

### Validação observada

- yarn test:budgets:unit **na imagem da API**: 43 testes, 43 aprovados, zero skips.
  Os 7+9 cenários originais T005/T006 foram preservados; sem mocks de sucesso em
  produção. Acrescidos dois cenários autorização, quatro segurança qpdf e cinco
  persistência/migration/model/locks. Corrigidas somente expectativas de avanço
  do schema local: guard agora para em T021, não na ausência anterior de T011.
- Host sem node_modules: execução direta Yarn falhou em import Sequelize nos novos
  testes de persistência. Sem install; a imagem já contém as dependências reais.
- Adaptador REAL executado nas oito fixtures via bind somente leitura na imagem
  alves-glass-api:feature005-qpdf-20261117040200-verified (qpdf12.3.2): plain e senha
  vazia aceitos, senha necessária/warning/corrupto/truncado/falso/vazio rejeitados
  conforme manifesto; hashes corretos e nenhum temporário residual.
  Container efêmero --network none --read-only --cap-drop ALL --security-opt
  no-new-privileges --memory512m --cpus1 --pids-limit64 --tmpfs /tmp de64MiB.
  Código novo montado somente leitura; imagem não reconstruída/alterada.
- Regressão focada: 11 aprovados em authorization-middleware, ownership-middleware,
  auth-session-model, sequelize-migrations e persistence-config.
- Regressão ampliada authentication/persistence/configuration: 30 aprovados e duas
  falhas, reproduzidas também na imagem anterior sem montar código novo: arquivo
  .env.persistence-containers.example ausente pelo dockerignore e teste esperando
  FROM node:22-alpine sem digest. Não corrigidos fora do escopo e não chamados verdes.
- node --check e git diff --check; Prettier da imagem usando .prettierrc existente.
  src/database/index.js recebeu somente imports/registro, preservando estilo legado.

Reproduzir unidade sem instalar dependências no host:

```sh
ROOT=/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --mount "type=bind,src=$ROOT/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$ROOT/tests,dst=/app/tests,readonly" \
  --entrypoint yarn alves-glass-api:feature005-qpdf-20261117040200-verified test:budgets:unit
```

### Aceite e limites

T005/T006 concluídas como escrita/validação de testes unitários reais dos Services.
T007–T010 continuam pendentes de integração e revisão completa. T011–T013 código
implementado e unidade verde, mas SQL/concorrência/locks dependem de PG17 real.
T014 implementada e matriz unitária verde; dependência T013/integração ainda aberta.
T015 implementada e qpdf real comprovado nas fixtures, sem alegar capacidade,
overshoot ou contenção dura por filho: watchdog não é cgroup. Manter T011–T015
abertas até seus critérios integrais/dependências/ensaios serem demonstrados.
T007 foi ajustada para UPLOADING -> READY -> ATTACHED, sem contornar lifecycle.

Não executar integração: T021 ainda não autorizado/preparado, recibo/ACL/identidade
remota e matriz PostgreSQL 17 ausentes. Nenhum DDL, banco, aplicação, endpoint,
MinIO ou worker iniciado. Root/UID0 da imagem continua pendência pré-produção.
G1 bloqueado por T007–T015 aceites operacionais e T016–T022 restantes (runtime
preflight, storage privado, cleanup/reconciliação, contratos, ambiente e gate).
Não instalar qpdf no host; ausência do binário falha fechada. Validação qpdf não é
sanitização/malware-free. Nenhum deploy/commit/push/PR. Parada em T015.
