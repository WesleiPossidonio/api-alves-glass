# US2 — T036 — Streaming protegido — 2026-11-17

## Estado

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
branch `feature/005-budgets-pdf`. T036 concluída. Oito testes T033 verdes no nível
de serviço/descritor, sem TODO ou skip. **US2 ainda não aceita**; T037–T039 abertas.
Não foram criados controllers, rotas ou endpoints de download/publicação/portal.

## Interface e separação de transporte

BudgetPdfStreamService.stream(input, destination, {signal,onReady}) recebe Writable
e contexto de ator confiável do futuro transporte. Input allowlist id,actor,slot,
range,disposition,ifNoneMatch; slot somente para usuário interno, published/pending.
Cliente não pode enviar slot (nem published), clientId, key, documentId ou bucket.
O serviço não verifica cookie/JWT: T037 deve compor auth/requireClient/requireUser.
Cliente só publicado próprio, privado/ausente/outro cliente notFound404 uniforme;
interno exige READ setorial corrente, independente de autoria/CREATE_EDIT/PUBLISH.
Não existe filtro de vencimento.

onReady recebe descritor imutável de status200/206/416, size/length/contentRange,
contentType PDF, disposition, filename baseado somente no UUID, no-store, Vary
Cookie, sandbox, nosniff e Accept-Ranges. Nenhum identificador de storage/cleanup
é exposto. O serviço **não escreve headers HTTP**: T037 deve traduzir o descritor
e envelopar erros sanitizados antes de headers, sem Express res.send que gere304.
ifNoneMatch nunca pula autorização nem produz304. Este descritor e sua projeção
por adaptador local de teste NÃO comprovam headers/cookies/HTTP real ou viewer.
Essas dependências continuam explicitamente T037/T038/T039.

## Lifecycle e recursos

Reutiliza READ COMMITTED e ordem global: autorização comercial/User/UserSector
quando interno → advisory compartilhado do orçamento → FOR SHARE orçamento →
FOR SHARE objeto. Repo lockObjects ganhou opção shared mantendo default UPDATE
para todos os chamadores existentes. Nova leitura após lock resolve slot vigente;
mudança de setor descoberta antes/depois do lock falha fechada sem inverter guards.
Cliente revalida ownership após lock. Registry sozinho não autoriza documento.

Locks ficam retidos durante stat, GET e pipeline até fim/abort. Publicação/cleanup
usam o mesmo owner advisory exclusivo, portanto não trocam/apagam enquanto leitores
protegidos estão ativos. Não criado lease/registry paralelo nem alteradas migrations.
Após commit de troca, novo pedido resolve só slot novo; antigo não selecionável
por documentId. Sessão/membership externos não recolhem bytes já entregues;
novos pedidos devem autenticar novamente em T037 e sempre reautorizam no serviço.

Leitura usa exclusivamente BudgetPdfStorageService.stat/get com configuração de
bucket privado e chave canônica já existentes. Range único fechado, aberto e sufixo,
clamp final; inválido/múltiplo/inseguro/fora da faixa retorna descritor416 sem GET.
Stat/tamanho do registry consistentes, pipeline com backpressure e contador exato:
truncamento/excesso falham, nunca usam pendente como fallback. Não há buffer do PDF
inteiro; somente primeiro chunk e buffers limitados do pipeline. Primeiro chunk é
aguardado antes de onReady para preservar JSON503 se GET falhar antes dos bytes.
Após início de entrega falha destrói destino; nenhum JSON misturado ao PDF.

Limite global de quatro operações de stream por processo (inclusive instâncias
diferentes); storage conserva seu próprio limite aceito. Prazo default60s, curto
injetável até60s em testes; AbortSignal, erro/close do destino e timeout destroem
source/pipeline, finalizam transação e liberam slot/listeners/timer. Enquanto SQL
está bloqueado, cancelamento é observado após a espera limitada pelo lock_timeout
G1 de5s; não introduz cancelamento paralelo de queries nem liberação prematura de
transação em uso. Sessão/pool/HTTP de autenticação sob pressão ficam para T039.

## T033 e ajustes do harness

Todos os oito cenários originais foram mantidos e tornados obrigatórios (sem
existsSync/TODO). Storage real usa get, não read; harness corrigido. Concorrência
agora usa quatro sources/destinos independentes em vez de compartilhar um Writable.
Reautorização usa novo destino, não um Writable já concluído. Headers esperados
continuam assertados por projeção local do descritor; não é transporte antecipado.
Quatro complementos: Range extremos, truncamento/excesso, pre-abort/input proibido
e falha GET antes do primeiro byte sem onReady/destruir destino JSON-capaz.

## Integração real e concorrência

tests/integration/budgets/us2-stream.integration.test.js (pai + quatro subtestes):

1. PDF MinIO real128KiB, hash integral igual ao upload e bytes exatos para Range
   fechado/aberto/sufixo/clamp; vencido acessível,416 sem bytes.
2. Privado/outro cliente/ausente404; campos externos/slot proibidos; interno READ
   lê pending, revogação impede novo pedido. Sem cookie HTTP alegado.
3. Dois leitores reais simultâneos sob backpressure coexistem (FOR SHARE), usando
   objeto1MiB. Candidato novo é somente fixture G1, não implementação US3. Publisher
   real observado bloqueado em pg_locks no owner guard; claims não incluem publicado
   e job malformado não o remove. Primeiro leitor termina, segundo sozinho ainda
   bloqueia publisher; abort do segundo libera. Publicação então troca, enfileira
   anterior; worker real remove antigo após claim, nova leitura recebe publicado novo.
4. Abort, deadline200ms e desconexão do Writable destroem GET real, storage.streams
   retorna0, owner lock exclusivo é adquirido novamente e leitura seguinte funciona.

## Resultados finais

| Execução                                      | Aprovados | Falhos | Skips | TODO |
| --------------------------------------------- | --------: | -----: | ----: | ---: |
| yarn test:budgets:unit                        |       108 |      0 |     0 |    0 |
| Contratos                                     |         9 |      0 |     0 |    0 |
| Migrated G1/US1/US2/stream/worker/qpdf/legado |        92 |      0 |     0 |    0 |

Contagens incluem pais, sem somar reexecuções. Oito T033 + quatro complementos
estão nos108; cinco testes da integração nova estão nos92. Os87 anteriores incluem
HTTP US1 real, serviços US2, legado e fundação. Não executados fresh/upgrade/rollback
(migrations preservadas), HTTP US2/T037–T038, viewer/inline/T039 ou integrações
externas003/004; nenhuma alegação de recertificação desses ambientes.

Logs finais:

- `/tmp/feature005-t036-unit-final.log`
- `/tmp/feature005-t036-contract-final.log`
- `/tmp/feature005-t036-migrated-final.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-1dda049d6971/preflight.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-1dda049d6971/migrated.log`
- `/tmp/feature005-t036-checks.log`: sintaxe/Prettier/diff/hashes/branch/identidade.

Run35eb2feadec9, preflights Docker exatos e remotos PG17/MinIO aprovados. Manifesto
restrito e credenciais não reproduzidos. Nenhuma evidência antiga removida.

## Falhas observadas e correções

Primeiro teste focado7/8 falhou porque harness reutilizava destino concluído na
segunda requisição; corrigido para novo pedido realista, sem reduzir asserção404.
Após melhorar primeira leitura pré-header, teste de excesso foi ajustado: excesso
detectado antes de onReady deixa destino apto a JSON503, truncamento depois destrói.

Primeiro migrated em `/tmp/feature005-t021-7gg672ji/t022-ops-3bef38e7ae5c/migrated.log`:
90 aprovados/2 falhos contando pai. T036 passou; fixture de claim G1 falhou ao
reencontrar seu registro reaparecido após late PUT, pois evidências retidas excedem
um lote. Helper agora prioriza somente a fixture-alvo em CLEANUP_PENDING/CLEANING
(next_attempt_at antigo e lease expirado), sem purge ou alteração do algoritmo
produtivo. Reinício/reconciliação voltaram verdes no migrated final. G1 não reaberto.

## Arquivos e preservação

Raiz absoluta é a worktree no início. Novos:
src/app/services/BudgetPdfStreamService.js,
tests/integration/budgets/us2-stream.integration.test.js e este relatório.
Alterados: src/app/repositories/BudgetPdfObjectRepository.js (lock compartilhado),
tests/unit/budgets/stream.test.js, tests/integration/budgets/foundation.integration.test.js
(fixture claim), tests/support/budgets/integration-cli.js, specs/005-budgets-pdf/tasks.md
e contracts/http-api.md (estado de implementação).
Preservação contra `/tmp/feature005-t036-before.json`: rotas/controllers, migrations,
budget legado,003/004 e alterações locais anteriores inalterados nesta rodada.
Sem deploy/commit/push/PR. Parada após T036; T037 não iniciada.
