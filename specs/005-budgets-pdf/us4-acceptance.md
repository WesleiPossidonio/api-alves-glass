# Checkpoint US4 — exclusão definitiva

## Estado vigente — 2026-11-18

**US4 ACEITA — pronta para iniciar US5.** T047–T052 concluídas; G1 e
US1–US3 permanecem aceitos. T053 não iniciada.

## Escopo implementado

Raiz: `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/`.

- `src/app/services/BudgetPdfDeleteService.js`: confirmação estrita de UUID,
  If-Match, DELETE independente, descoberta de setor, autorização corrente,
  advisory exclusivo/linha, revisão, locks ordenados de todos os objetos do
  owner, segunda autorização antes das escritas, remove CAS e enqueue atômicos.
- `src/app/repositories/BudgetPdfObjectRepository.js`: métodos
  `lockOwnerObjects` e `enqueueOwnerCleanup`. Incluem uploads em curso, READY,
  ambos slots, órfãos e claims anteriores. Invalidam leases/tokens não terminais;
  preservam REMOVED e o registry técnico para reconciliar PUT tardio.
  Recusam enqueue enquanto existir orçamento/referência vigente.
- `src/app/controllers/BudgetPdfController.js`: DELETE com query allowlist,
  actor da sessão, revisão do header e envelope de erros sanitizado.
- `src/app/meddleawares/budgetPdfHttp.js`: somente `DELETE /budgets/:id`, no
  mount administrativo já existente em `src/routes.js`; Origin, auth/CSRF,
  requireUser. Sem upload, endpoint cliente ou caminho alternativo.

Resposta contratual: HTTP202 `{id,deleted:true,cleanupPending:true}`. Significa
remoção comercial confirmada e limpeza física pendente; não promete bytes já
removidos. Repetição do DELETE retorna404. Não emite nova revisão/ETag de recurso
inexistente; If-Match obrigatório na entrada. Cache privado/no-store preservado.

BudgetPdfCleanupWorker e adaptador de storage existentes reutilizados sem
alteração. Nenhuma chamada MinIO no serviço/controller de exclusão. Não há
transação distribuída, lixeira, soft-delete ou histórico consultável.

## Ambiente e segurança

Run **db1126fff37e** reutilizado após verificação Docker e remota. Manifesto:
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/resources.json`.

Preflight inicial exit0 em
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/t022-ops-6d0b591aaabc/preflight.log`.
PostgreSQL17, identidade/recibos remotos, bucket privado, política restrita,
rede/volumes/IDs exatos e ausência de portas publicados conferidos pelos guards
existentes. Imagem validada `alves-glass-api:feature005-qpdf-20261117040200-verified`;
código atual montado sobre suas dependências. Node22 ESM e Yarn Classic.
Sem migrations, fresh/upgrade, infraestrutura adicional ou acesso a outros runs.

## Evidências funcionais e lifecycle

`tests/unit/budgets/delete.test.js` e
`tests/contracts/budgets/delete.test.js`: confirmação obrigatória, mismatch,
allowlist, ator interno, revisão428/412, permissão independente, ordem de locks,
revalidação e rollback, 202 mínimo, erros sanitizados e repetição404.

`tests/integration/budgets/deletion-recovery.integration.test.js`:

1. Privado, publicado e ambos slots: SQL sem orçamento após202; URLs antigas,
   downloads interno/portal e detalhes404; listas não incluem excluído.
2. Sem cookie401; cliente403; Origin/CSRF403; confirmação e mass assignment400;
   If-Match428/412. READ/CREATE_EDIT/REPLACE_PDF/PUBLISH não concedem DELETE.
3. DELETE isolado funciona sem READ; outro setor, membership/permissão revogadas
   e identidade inativa negam exclusão. Orçamento de outro cliente/setor intacto.
4. Falha injetada após DELETE SQL e enqueue reais provoca rollback integral:
   orçamento, slots, objetos e tokens anteriores permanecem, bytes intactos.
5. Todos os estados associados: READY, ATTACHED, UPLOADING e CLEANING são
   encaminhados/fenced; REMOVED não perde evidência técnica. Claim antigo stale.
6. Storage indisponível: conexão real com endpoint local sem listener falha;
   worker registra retry/backoff e last_error_code. Não se derruba o MinIO nem
   se usa mock como prova de remoção. Restauração do adaptador real remove os
   bytes e confirma ausência via stat e listagem MinIO do prefixo do orçamento.
7. Duas exclusões concorrentes: uma vence, outra404. Publicação/substituição
   vencedoras tornam DELETE obsoleto412; DELETE vencedor impede publicação.
8. PUT real pausado após intenção/refresh: DELETE invalida token, cleanup
   confirma ausência e marca REMOVED; PUT tardio recria apenas bytes privados,
   não orçamento/slot. Reconciliador reenfileira e remove; token antigo falha.
9. Stream real mantém lock compartilhado: pg_locks comprova DELETE bloqueado;
   bytes/slots permanecem protegidos e não elegíveis ao worker até término.
10. Revogação com guard comercial anterior é efetiva; segunda autorização antes
    de commit também rejeita grant alterado dentro da transação de teste.
11. Dois claimers não compartilham objeto/token. Subprocesso sofre SIGKILL após
    DELETE/stat reais, antes do CAS REMOVED. Após morte confirmada, teste antecipa
    expiração de lease e inicia outro processo worker: retry/not-found converge,
    claim antigo stale, objetos ausentes sem restaurar acesso.

Integração usa HTTP, sessão, PostgreSQL17, MinIO e qpdf reais. Barreiras e falhas
injetadas são instrumentação de teste, não substitutos da persistência/storage.
Após cada cenário de exclusão concluída, todos os objetos desse owner ficam
REMOVED e o prefixo MinIO vazio; registry técnico permanece deliberadamente.

## Resultados

Raiz das evidências:
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/`.

| Verificação                                          | Resultado                                       | Evidência                                                                    |
| ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Red-first T047/T048                                  | 6 falhas esperadas por serviço/métodos ausentes | us4-red.log / .exit                                                          |
| Unitários                                            | 132/132, exit0                                  | us4-unit.log / .exit                                                         |
| Contratos                                            | 16/16, exit0                                    | us4-contract.log / .exit                                                     |
| Regressões auth/OS/configuração/persistência/estoque | 231/231, exit0                                  | us4-regressions.log / .exit                                                  |
| Integração focada inicial                            | 10/10, exit0, antes dos dois complementos       | us4-focused-2.log / .exit                                                    |
| Runner migrated final, incluindo US4                 | 114/114, US4 12/12, exit0                       | us4-migrated-summary.log / .exit; t022-ops-1ff7557d8d20/migrated.log / .exit |
| node --check                                         | 8 arquivos JavaScript aprovados                 | us4-node-check.log                                                           |

Sem skips/TODO/cancelamentos nas suítes verdes. Não somar reruns ou testes T047
presentes tanto nos unitários quanto nos contratos. Red-first por import ausente
não é evidência final de aceite.

## Defeitos encontrados e corrigidos

Primeira integração falhou na verificação de listagem: `matrixFixture.client`
é helper de cliente comercial, não SDK MinIO. Corrigido apenas o teste para usar
`storage.operation` com listagem real. Log `us4-focused.log` preservado como
tentativa não verde; não se enfraqueceu a asserção de prefixo vazio. Nenhum defeito
que exigisse alteração em migrations ou Features003/004 foi encontrado.

## Restrições e parada

Sem alterações em migrations aceitas, legado/tabela budget/rota /budged,
Features003/004, viewer, gestão de permissões US5 ou infraestrutura persistente.
Sem Python, instalação host, mudança de permissões node_modules, produção,
deploy, commit, push ou PR. Alterações locais anteriores preservadas.
Encerrado após T052; T053 permanece aberta. HTTP202 distingue revogação
comercial confirmada de remoção física futura; falhas permanecem no registry
para retry e só objetos sem referências são elegíveis ao cleanup.
