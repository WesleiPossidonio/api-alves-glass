# T029–T031 — Aceite integral US1

Data: 2026-11-17. **US1 ACEITA — pronta para iniciar US2.**
Prontidão é de desenvolvimento, não deploy, ativação externa ou autorização
para executar T032 nesta rodada. G1 não foi reaberto.

## Escopo e decisão

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
branch `feature/005-budgets-pdf`. T029/T030/T031 concluídas. Cadastro privado,
listagem e detalhe administrativos aceitos; nenhum endpoint de publicação,
download, edição, substituição, exclusão ou portal foi acrescentado. Os critérios
de entrega ao cliente/publicação permanecem US2–US5. Não exigidos para aceitar US1.

T029 reutiliza `tests/integration/budgets/us1-create-read.integration.test.js`
e `tests/integration/budgets/us1-http.integration.test.js`, em vez de duplicá-los
em create-read.integration.test.js. A segunda recebeu uma subverificação de
duplicidade concorrente e mesmo número em outro setor e sondas das rotas antigas.
T030 acrescentou `tests/integration/budgets/legacy-reconciliation.integration.test.js`
e o procedimento `specs/005-budgets-pdf/legacy-reconciliation.md`. O runner migrated
inclui essa demonstração. Nenhum código de produção foi modificado nesta rodada.

## Matriz do checkpoint

| Critério                   | Evidência executada                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Criação privada autorizada | HTTP com sessão persistida, JWT/cookies/CSRF/Origin; CREATE_EDIT sem READ cria; 201/Location/ETag/revision1 mínimos.                                                                                                                                      |
| PDF e armazenamento        | qpdf real, 10 MiB exatos aceitos, excesso/ausente/falso/corrupto rejeitados; PostgreSQL 17 e MinIO reais, stat/tamanho/hash e objeto ATTACHED. Regressões de qpdf negativo sem PUT nas suítes create/runtime/contratos.                                   |
| Identidades                | Cliente global existente, autor exclusivamente da sessão, setor com membership/grant corrente; injeção de autor e IDs inválidos recusados. Número 00042 permanece textual; mesmo número em outro setor aceito; concorrência HTTP retorna um 201 e um 409. |
| Listagem                   | READ independente de CREATE_EDIT, leitura de outro autor no setor, filtro exato, keyset/cursor HMAC scoped, revogação entre páginas efetiva.                                                                                                              |
| Detalhe                    | DTO allowlist, ETag, sem chave/bucket/stack; invisível e inexistente 404.                                                                                                                                                                                 |
| Segurança                  | Sessão/cliente/CSRF/Origin negados antes de multipart; limites de corpo/arquivo/concorrência/timeout/abort; campos/arquivos adicionais negados; segredo cursor falha fechado.                                                                             |
| Recuperação                | Falha real de socket após PUT retorna 503 sanitizado, intenção CLEANUP_PENDING sem orçamento parcial; serviços cobrem intenção/PUT/commit e perda de membership; worker real e processo morto/reiniciado retomam órfãos sem apagar referência válida.     |
| Compatibilidade            | App real: check-auth e sectors 200, client/me e user/all negam ator inadequado, /budged nega cliente; regressões de rotas/guards/serviços OS e estoque verdes.                                                                                            |
| Legado                     | Snapshot/checksum budget antes/depois; TEMP fixture 3 UUIDs, nulos/chave repetida/ambiguidades; nenhuma importação, nenhum PUT legado e rota antiga preservada.                                                                                           |
| Sem acesso antecipado      | published_object_id/first_published_at NULL, published DTO null; guard de cliente nega privado e cliente recebe 403 no router administrativo; nenhum portal novo.                                                                                         |

## Execuções finais e evidências

Run autorizado: `35eb2feadec9`. Manifesto restrito não reproduzido neste relatório.
Preflights Docker exatos e remotos PG17/MinIO obrigatórios passaram. Nenhum acesso
a produção ou a recursos de outros projetos; PostgreSQL 17 exclusivamente.

| Suíte                                                            | Aprovados | Falhos | Skips |
| ---------------------------------------------------------------- | --------: | -----: | ----: |
| Feature 005 unitários                                            |        88 |      0 |     0 |
| Contratos administrativos/fundação                               |         7 |      0 |     0 |
| Migrated final: fundação, serviços, HTTP, legado, qpdf e worker  |        80 |      0 |     0 |
| Authentication, service-orders, persistence e persistence-config |       153 |      0 |     0 |
| unit/stock e unit/configuration                                  |        77 |      0 |     0 |

Contagens node:test incluem testes-pai. Não somar reruns como cobertura nova.
Migrated final inclui 10 testes na suíte HTTP (pai + 9 subtestes) e a nova
demonstração T030. O primeiro migrated verde tinha o mesmo total antes das sondas
adicionais no subteste da aplicação; somente o último comprova o estado final.

Logs externos preservados:

- `/tmp/feature005-t029-unit.log`
- `/tmp/feature005-t029-contract.log`
- `/tmp/feature005-t029-regression.log`
- `/tmp/feature005-t029-stock.log`
- `/tmp/feature005-t031-migrated.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-e2620f2765b8/preflight.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-e2620f2765b8/migrated.log`
- Primeiro verde: `/tmp/feature005-t021-7gg672ji/t022-ops-4d71e7d834e9/migrated.log`
- `/tmp/feature005-t031-checks.log`: sintaxe, diff, hashes de preservação,
  branch/worktree, formatação e identidade final.

A primeira tentativa `/tmp/feature005-t029-migrated.log` parou com
BUDGET_OPERATIONAL_PREFLIGHT_FAILED antes de criar diretório de execução. Havia
containers efêmeros paralelos na rede que exige apenas PG/MinIO no preflight.
Não é falha de teste nem defeito da fundação; runner não foi relaxado. As duas
execuções posteriores passaram, incluindo a final sem concorrência operacional.

## Não executados e limites

Não executados fresh/upgrade/rollback nesta rodada: migrations inalteradas e
regressões migrated pertinentes executadas, sem reprovisionar/resetar recursos.
Não executadas integrações completas de 003/004 que exigem seus ambientes externos
(Mongo/Rabbit ou recursos próprios): não há autorização para acessar esses projetos.
Cobertura de compatibilidade nesta rodada é HTTP/rotas/guards e unitária, não
recertificação end-to-end de todos os módulos. persistence-container-isolation
não incluído: as duas incompatibilidades de fixture/imagem já documentadas na
rodada anterior não são alegadas como corrigidas ou novos bloqueios US1.

Nenhum inventário de dados reais, ACL histórica ou consumidor produtivo foi
executado. O procedimento T030 explicita essas dependências para eventual
reconciliação e rollout, sem importar nada. /budged permanece como antes por
restrição expressa; retirada/410 exige autorização própria. Aceite US1 não elimina
o gate de ativação externa/compatibilidade do legado.

Sem defeito de produção demonstrado nesta rodada; nenhuma correção funcional,
relaxamento de watchdog ou mudança de migrations. A correção qpdf anterior foi
regredida, sem atribuir causa conclusiva à falha histórica validatorFailed.
T032 e todas as tarefas US2–US5 continuam abertas. Sem deploy/commit/push/PR.
