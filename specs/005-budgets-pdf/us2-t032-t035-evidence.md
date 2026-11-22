# US2 — T032–T035 — 2026-11-17

## Estado e limite

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
branch `feature/005-budgets-pdf`. T032, T034 e T035 concluídas no nível de serviços.
T033 concluída **somente como escrita e execução red-first**: oito testes TODO
executam e reportam módulo T036 ausente; não são streaming aprovado nem skips.
O checkbox de T033 não certifica seus cenários funcionais, que devem ficar verdes
em T036. Interface do harness proposta: BudgetPdfStreamService.stream(input,
response, {signal}); ajustar o harness à composição de T036 sem reduzir os cenários.
Não foi implementado stub de sucesso, streaming, controller ou rota US2.
**US2 NÃO ACEITA**: T036–T039 continuam abertas. G1 e aceite US1 preservados.

## Implementação efetiva

### T034 — BudgetPdfPublishService

`publish(id, {pendingDocumentId}, actor, {ifMatch, signal})` recebe ator do contexto
confiável da sessão, não do corpo. Valida UUIDs/allowlist e ETag forte do contrato;
ausência428, stale412, ausência de pendente409. Reutiliza autorização comercial:
PUBLISH não pressupõe READ/CREATE_EDIT, admin global; gerente e colaborador exigem
membership/autoridade corrente do setor.

Primeira transação: descoberta, guard de autorização, owner advisory exclusivo,
linha do orçamento e objetos ordenados; relê setor, revisão e candidato vigente.
Exige ATTACHED, owner correto, lease limpo, confirmação, hash/tipo/tamanho válidos.
Depois de liberar a transação, stat privado pelo BudgetPdfStorageService confirma
existência/tamanho. Não há chamada MinIO na transação principal de escrita.
Segunda transação repete autorização e locks, revisão e candidato, confere prova
imutável e CAS: move par PDF/data pendente ao publicado, limpa par pendente,
fixa first_published_at apenas se ausente e incrementa revisão. Enfileira objeto
anterior como CLEANUP_PENDING na mesma transação, somente se não referenciado.
Falha rollback mantém todos os pares/estados anteriores. Nenhum PUT/DELETE físico.
Resultado mínimo `{id,revision}`, sem DTO/READ implícito.

Existência no storage é amostrada por stat; não é transação distribuída. O protocolo
impede cleanup de ATTACHED. Remoção fora do protocolo após stat continua incidente
operacional, não uma garantia de atomicidade PostgreSQL/MinIO. Não acrescentado
I/O externo dentro da transação para tentar prometer garantia impossível.

Identidade após primeira publicação permanece protegida pelos triggers G1:
client_id, sector_id, commercial_number e primeiro marco imutáveis. Nenhum serviço
novo de edição/substituição/exclusão foi introduzido.

### T035 — ClientBudgetPdfService

`list({limit,cursor}, actor)` e `detail(id, actor)` exigem type client e identidade
do contexto autenticado. Nenhum clientId/filtro técnico recebido do usuário.
Queries limitam client_id e published_object_id, sem filtrar vencidos. Detalhe
revalida ownership/publicação após lock compartilhado e usa label corrente do setor.
DTO allowlist: id, administrativeName, commercialNumber, sector {id,name},
validityDate publicada e expired São Paulo. Sem autor, pending, revision, registry,
bucket/key ou URL. Privado/ausente/outro cliente retornam notFound404 uniforme.
Lista vazia é `{items:[],nextCursor:null}`; limites25/100 e HMAC TTL15min com
escopo client:published e identidade cliente, precisão de microsegundos no keyset.
Segredo cursor deve ser explícito >=32bytes; nenhuma credencial produtiva criada.
Sessão/cookies/revogação de sessão pertencem ao transporte existente e à futura
composição T037; não alegar que o serviço sozinho autentica um cookie HTTP.

## Testes e red-first

- `/tmp/feature005-t032-red.log`: antes dos serviços, falha por módulo T034 ausente
  e oito TODOs por módulo T036 ausente. Falha relevante preservada.
- `/tmp/feature005-t032-green.log`: primeira implementação teve uma falha no
  rollback do fake unitário, que não removia propriedades novas; fake corrigido
  para restaurar snapshot exato, sem mudar produção para satisfazê-lo.
- Primeira integração `/tmp/feature005-t021-7gg672ji/t022-ops-e95d519259f4/migrated.log`:
  81 aprovados/5 falhos contando pai, nenhum skip. Helper G1 deixava lease em
  ATTACHED; publicação recusou corretamente. Fixture US2 limpa lease tal como o
  cadastro real, sem alterar helper G1 nem enfraquecer validação do serviço.
- `/tmp/feature005-t034-focused.log`: seis aprovados após ajuste da fixture.
  Posteriormente acrescentado cenário gerencial/identidade e regressões unitárias.

### Estado final, não somar reexecuções

| Execução               | Aprovados | Falhos | Skips | TODO |
| ---------------------- | --------: | -----: | ----: | ---: |
| yarn test:budgets:unit |        96 |      0 |     0 |    8 |
| Contratos              |         9 |      0 |     0 |    0 |
| Migrated integrado     |        87 |      0 |     0 |    0 |

Contagens incluem testes-pai. Integração US2: sete testes (pai + seis subtestes),
incluídos nos87; usa serviços reais/PG17/MinIO, **não é HTTP US2 nem stream**.
Os80 anteriores de fundação/US1/HTTP/qpdf/legado/worker continuam passando.
Cobertura inclui PUBLISH isolado, gerente setorial/admin global, revogação de grant
e membership entre stat/commit, isolamento setorial, dois publishers um vencedor,
stale412/noPending409, candidato não confirmado e objeto ausente, rollback após CAS,
rollback de cleanup do anterior, primeiro marco preservado e ausência de DELETE.
Portal cobre privado/outro cliente404, vencido visível, DTO estrito, label setor,
paginação e cursor de outro cliente rejeitado. Unitários cobrem troca de owner/
publicação após lock e virada São Paulo (01:00UTC ainda data anterior).

T033 contém oito contratos executáveis pendentes: reautorizar cada pedido, locks
até fim/abort, Range206/416, headers/disposition UUID, sem304/URL externa, falhas
pré-header503 e pós-header abort, cliente sem pending, quatro streams e timeout60s
(deadline curto injetado no ensaio). Nenhum desses comportamentos está certificado.

### Evidências finais

- `/tmp/feature005-t035-unit.log`
- `/tmp/feature005-t035-contract.log`
- `/tmp/feature005-t035-migrated.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-3a1f53a553dd/preflight.log`
- `/tmp/feature005-t021-7gg672ji/t022-ops-3a1f53a553dd/migrated.log`
- `/tmp/feature005-t035-checks.log`: sintaxe, Prettier, diff, preservação e identidades.

Run autorizado35eb2feadec9; preflights Docker exatos e remoto aprovados antes da
integração. PostgreSQL17 exclusivamente, MinIO privado, nenhuma outra rede/banco/
bucket de projeto. Manifesto/credenciais não reproduzidos. Evidências anteriores
preservadas. Sem fresh/upgrade/rollback nesta rodada: migrations não alteradas.
Sem recertificar integrações externas completas003/004 ou viewer inline (T039).

## Arquivos desta rodada

Raiz absoluta é a worktree no início deste relatório. Novos:

- src/app/services/BudgetPdfPublishService.js
- src/app/services/ClientBudgetPdfService.js
- tests/unit/budgets/publish-portal.test.js
- tests/unit/budgets/stream.test.js
- tests/contracts/budgets/us2-service-boundary.test.js
- tests/integration/budgets/us2-services.integration.test.js
- specs/005-budgets-pdf/us2-t032-t035-evidence.md

Modificados: src/app/repositories/BudgetPdfRepository.js (queries portal),
src/app/repositories/BudgetPdfObjectRepository.js (enqueueDetached protegido),
tests/support/budgets/integration-cli.js (seleção US2 serviços),
specs/005-budgets-pdf/tasks.md e contracts/http-api.md (status, sem novos contratos
funcionais). Rotas, controllers, migrations, budget legado,003/004 e mudanças
locais anteriores preservados por hashes contra `/tmp/feature005-t032-before.json`.

## Próximo limite

T036 está apta a começar em nova rodada: tornar T033 verde, preservando storage
privado, Range, locks, abort/deadline e limite de streams. Depois T037 compõe HTTP,
T038 integra transporte/stream e T039 decide aceite US2/inline. Não há autorização
para dizer que o cliente já consulta ou baixa por HTTP nesta entrega.
Sem aprovação/recusa comercial, deploy, commit, push ou PR. Parada após T035.
