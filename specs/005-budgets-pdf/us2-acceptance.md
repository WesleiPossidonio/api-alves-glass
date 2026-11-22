# Checkpoint US2 — download autenticado

## Resultado vigente

**US2 ACEITA — pronta para iniciar US3.** T038 e T039 revisada concluídas. O único bloqueio foi resolvido pela correção pontual expressamente autorizada do teste compartilhado de configuração. T040/US3 não iniciada.

Escopo aprovado: exclusivamente download autenticado `Content-Disposition: attachment`. Viewer/inline adiado para melhoria futura com gate próprio. O gate anterior não foi executado nem aprovado. Sem provisionamento de navegador.

## Implementação e evidência

- Endpoints e BudgetPdfStreamService reutilizados; controller fixa attachment e application/pdf, valida filename UUID.pdf e preserva cache restritivo, nosniff, CSP sandbox, Vary Cookie, streaming e Range. Query `disposition` não é aceita nem pelo HTTP nem pelo serviço; header do pedido não altera a entrega.
- Autenticação, autorização, ownership, qpdf, armazenamento privado, locks e lifecycle preservados. Sem URL pública/pré-assinada ou redirect de entrega.
- T038: publicação por POST real; fixture prepara A publicado e B pendente com hash/data distintos, sem implementar US3. Falha injetada exclusivamente no teste **depois** do CAS e do enqueueDetached real causa HTTP503 e rollback PostgreSQL. A/data/revisão anterior à tentativa e B pendente permanecem; A continua ATTACHED. GET HTTP confirma validade e SHA-256 de A.
- Restart: harness Node com routers/controllers/autenticação/repositórios reais é encerrado com SIGKILL, e outro processo com PID diferente é iniciado sobre o mesmo PG17/MinIO. GET antes/depois confirma mesmo PDF/data/hash; segundo processo encerra com SIGTERM/exit0. É restart do processo da aplicação HTTP Feature005 sob harness, não deploy/restart de produção ou de containers.
- T039 HTTP real: sem cookie401, outro cliente404, privado404, slot pendente escolhido pelo cliente400; bytes de B nunca servidos no portal. Downloads200/206/416, attachment, application/pdf, filename, no-store, nosniff, CSP e Vary. Queries inline/attachment/response-content-disposition rejeitadas400; header inline ignorado em favor de attachment. Sessão revogada401, membership revogada403; Range revalida acesso.
- Preflight remoto comprova PostgreSQL17, recibos de identidade, bucket/listagem anônimos403 e credencial sem alteração de política. Preflight Docker comprova rede interna, identidades, recursos limitados e ausência de portas publicadas.

## Resultados finais

| Verificação                                          | Passou | Falhou | Exit |
| ---------------------------------------------------- | -----: | -----: | ---: |
| Unitários Feature005                                 |    114 |      0 |    0 |
| Contratos Feature005                                 |      9 |      0 |    0 |
| Runner migrated completo com T038/T039 HTTP          |     93 |      0 |    0 |
| Regressões auth/OS/configuração/persistência/estoque |    231 |      0 |    0 |

Sem skips/TODO/cancelamentos nessas execuções. Contagens não somam reruns.

**Bloqueio resolvido:** somente a asserção em `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/unit/configuration/persistence-container-isolation.test.js:58` mudou, de `^FROM node:22-alpine$` para `^FROM node:22-alpine@sha256:[a-f0-9]{64}$`. Preserva Node.js22, Alpine e exige digest SHA-256 hexadecimal de 64 caracteres, com âncoras de linha; não aceita tags/versões/distribuições distintas nem digest incompleto. As demais asserções permaneceram byte a byte iguais. Dockerfile e digest existentes intactos.

Teste isolado **3/3, exit0**; regressão pertinente **231/231, exit0**. `node --check` e `git diff --check` passaram. Prettier executado: documentos e linha alterada (convenção existente sem ponto e vírgula) aprovados. O check do arquivo compartilhado inteiro aponta formatação **preexistente**, reproduzida também no conteúdo anterior; não foi feita reformatação fora da única asserção autorizada. Esta ressalva não é falha funcional nem novo bloqueio de aceite.

Evidências **114/114 unitários, 9/9 contratos e 93/93 migrated** reutilizadas: conteúdo de todo `src` comparado com a cópia testada, hashes do transporte e harness conferidos. Nenhuma alteração funcional. Não repetida integração PostgreSQL/MinIO.

## Logs e reprodução

Manifesto original privado: `/tmp/feature005-t021-7gg672ji/resources.json`, run `35eb2feadec9`. Sem reset/migration/fresh/upgrade.

```sh
python3 /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/operational-runner.py --manifest /tmp/feature005-t021-7gg672ji/resources.json --scenario migrated
```

- Migrated final: `/tmp/feature005-t021-7gg672ji/t022-ops-be9ed83ef170/migrated.log` e preflight no mesmo diretório.
- Exit persistido: `/tmp/feature005-us2-revised-migrated.exit` = 0; resumo `/tmp/feature005-us2-revised-migrated.log`.
- Unitários/contratos: `/tmp/feature005-us2-check-uhwi7hio/unit-complete.log`, `contract-complete.log`, com arquivos `.exit` correspondentes.
- Regressões finais: `/tmp/feature005-us2-check-uhwi7hio/regression-accepted.log` e `/tmp/feature005-us2-check-uhwi7hio/regression-accepted.exit` = 0. Resultado anterior 230/231 permanece em `regression-final.log` como histórico.
- Teste isolado: `/tmp/feature005-us2-close-isolated.log` e `/tmp/feature005-us2-close-isolated.exit` = 0.
- Comparação/ressalva de formato: `/tmp/feature005-us2-close-format.log`.
- Cópia descartável contém mesmo código testado; hashes em `/tmp/feature005-us2-check-uhwi7hio/source-sha256.json`. Dependências completas preexistentes reutilizadas de `/tmp/feature005-t037-worktree/node_modules`, mesmo SHA-256 do yarn.lock. Nenhuma instalação.

Na cópia descartável, comandos executados:

```sh
cd /tmp/feature005-us2-check-uhwi7hio
node tests/support/budgets/run.js unit
node tests/support/budgets/run.js contract
node --test --test-concurrency=1 tests/unit/authentication/*.test.js tests/unit/service-orders/*.test.js tests/unit/configuration/*.test.js tests/unit/persistence/*.test.js unit/stock/*.test.js
```

## Tentativas anteriores — não verdes

As tentativas migrated e7d083c1b823, fe0411126b0c, df043f1c7a02, 46244e2acc02 e 4e303adf084f preservam logs de falhas do harness (snapshot sem transação, updates incompatíveis com lifecycle/revisão, uso de URL de servidor fechado). Não constituem aceite. Rollback sem escrita e simples reabertura de listener foram substituídos pelo cenário final acima. Tentativa concorrente final5 foi recusada pelo preflight (exit20); não flexibilizado isolamento.

Execuções locais iniciais falharam por dependências incompletas; primeira cópia descartável usou módulos incompletos, depois corrigidos para a instalação já existente. Regressão intermediária falhou por arquivos ausentes da cópia, posteriormente completada; a divergência real de pin remanescente foi resolvida nesta correção autorizada. Não reinterpretar resultados históricos como verde.

## Limites preservados

Nesta correção final, apenas uma asserção do teste compartilhado autorizado e tasks/quickstart/este relatório foram alterados. Sem mudanças em migrations aceitas, comportamento de Features003/004, legado, código funcional, manifesto/lockfile ou Dockerfile. Nenhum novo serviço/container persistente, browser, deploy, commit, push ou PR. Apenas containers efêmeros do runner existente e subprocessos Node de teste. O ambiente de produção não foi exercitado. Parada no checkpoint US2; T040 não iniciada.
