# US1 — T027/T028 e aceite HTTP de T024 — 2026-11-17

## Estado vigente

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
branch `feature/005-budgets-pdf`. T027/T028 concluídas; critérios HTTP
administrativos de T024 demonstrados. Critério de portal futuro continua
explicitamente pendente de US2, não implementado nem certificado por esta rodada.
T029/T030/T031 não iniciadas: **US1 ainda sem checkpoint integral/ativação externa**.
Não há autorização automática para US2. G1 preservado com regressão verde.

## Transporte entregue

- POST `/budgets`: multipart cinco campos administrativos e `file`,201 mínimo,
  Location e ETag forte; privado sem publicação.
- GET `/budgets`: READ setorial, filtros e cursor HMAC scoped, DTO allowlist.
- GET `/budgets/:id`: READ corrente,404 invisível/ausente, DTO e ETag.

Controller sem Models/MinIO, identidade exclusivamente do contexto autenticado.
Router exclusivo montado antes do auth genérico já existente, reutilizando
**o mesmo auth, requireUser e verificador CSRF**. Como auth legado acopla CSRF
à autenticação, a primeira chamada usa visão read-only da requisição para validar
sessão; segue requireUser e depois auth original na mutação para CSRF e nova
checagem de sessão. Não duplica JWT, banco de sessões ou algoritmo CSRF.
Origin explícito obrigatório; proteção antecede qualquer multipart. Autorização
comercial permanece nos Services e é revalidada transacionalmente.

Upload exclusivo Multer, sem configuração de upload legada: arquivo<=10MiB,
corpo<=11MiB inclusive chunked,1 arquivo,5 campos, nomes/tipos estritos,
campos duplicados recusados. Parser aceita sentinel de1byte para distinguir
exato10MiB de excesso; tamanho final estritamente verificado antes do Service.
Limite parts7 evita evento de limite ao atingir exatamente seis partes válidas;
files1/fields5 e allowlist continuam limitando conteúdo. Memória limitada a dois
uploads ativos; nenhum temporário de transporte em disco. Timeout30s até resposta,
abort do request/response propagado ao Service, liberação de buffers/slot e parser;
qpdf mantém seus temporários privados próprios. Controller nunca faz DELETE físico.

Erros JSON `{error:{code,message,requestId}}`, códigos públicos estáveis sem stack,
saída qpdf ou credenciais. Cache no-store. `validation` vira invalidInput e
notFound vira budgetNotFound. Erros do auth traduzidos só neste router.
App possui adaptadores de erro CORS/JSON restritos ao prefixo budgets para não
retornar HTML500/stack nesses negativos; comportamento003/004/legado preservado.

Configuração explícita: `BUDGETS_CURSOR_SECRET`,>=32bytes. Ausente/curto torna
listagem503 storageUnavailable, sem fallback para segredo JWT/MinIO ou aleatório.
Não criado segredo produtivo. `/budged` continua exatamente como antes; transição
410/rollout não antecipada. Nenhuma rota de publicação/substituição/delete/portal.

## Arquivos desta rodada (relativos à raiz absoluta acima)

Novos:

- `src/app/controllers/BudgetPdfController.js`;
- `src/app/meddleawares/budgetPdfUpload.js`;
- `src/app/meddleawares/budgetPdfHttp.js`;
- `tests/contracts/budgets/us1-transport.test.js`;
- `tests/unit/budgets/rss-exit.test.js`;
- `tests/integration/budgets/us1-http.integration.test.js`;
- `tests/integration/budgets/validator-observation.integration.test.js`;
- este relatório.

Alterados:

- `src/routes.js`: somente import e montagem do router;
- `src/app.js`: adapters de erro limitados ao prefixo novo;
- `src/app/services/BudgetPdfValidationService.js`: corrida de RSS comprovada;
- `tests/unit/budgets/admin-http.test.js`: contrato controller real;
- `tests/integration/budgets/foundation.integration.test.js`: prioridade da fixture
  de claim, sem purgar evidências antigas;
- `tests/support/budgets/integration-cli.js`: seleção explícita HTTP/investigação;
- `specs/005-budgets-pdf/tasks.md` e status do contrato HTTP.

## HTTP real

Suíte abre listener Express real em loopback e envia fetch/http multipart.
Sessions persistidas em auth_sessions reais, JWT e CSRF assinados pelo mecanismo
existente; nenhum stub de auth/repository. Testa também `src/app.js`/`src/routes.js`
reais: POST201 e GET200, Origin malicioso403 e JSON malformado400 sanitizados.
Demais negativos exercitam o mesmo router de produção com Services/DB/MinIO reais.
Contador prova **zero invocações multipart** nas rejeições de sessão/CSRF/cliente.

Cobertura:201/Location/ETag, sessão ausente/inválida/revogada, CSRF ausente/forjado,
Origin ausente/malicioso, cliente bloqueado, CREATE_EDIT sem READ, READ outro
autor, número00042 vs42 e duplicidade409, PDF ausente/falso/malformado/excesso e
exato10MiB, arquivos/campos duplicados e desconhecidos, datas/cliente inválidos,
timeout/abort/cap chunked, recuperação da capacidade, keyset/filtros/escopo,
READ revogado entre páginas, DTO e erros sem vazamento, falha de socket PUT após
commit MinIO sem orçamento parcial e com registry CLEANUP_PENDING.
Sem apresentação de chamadas diretas a Services como evidência HTTP.

Primeira execução HTTP vermelha em `/tmp/feature005-t028-http-first.log` (fixture
sem define.underscored para User, corrigida para espelhar config real), seguida
de vermelho funcional multipart em `/tmp/feature005-t028-http-second.log` (limite
parts recusava seis partes válidas). Contratos existentes T024 já eram red-first
na rodada anterior; a primeira suíte HTTP desta rodada foi executada após o
esqueleto do transporte, não se alega execução prévia inexistente.
Tentativa bloqueada no primeiro ensaio foi encerrada apenas no container executor
descartável identificado, sem interromper PG/MinIO ou qualquer recurso compartilhado.

## Investigação validatorFailed

1. Dez rodadas runtime frio/dois cadastros concorrentes pequenos:20 sucessos,
   não reproduziu. Log `/tmp/feature005-t028-validator.log`.
2. Regressão real reproduziu watchdog na pressão G1, preservada em
   `/tmp/feature005-t021-7gg672ji/t022-ops-285b648eb858/migrated.log`.
3. Vinte rodadas/dois PDFs10MiB: observação sanitizada de spawn,close,kill e RSS
   revelou ESRCH na leitura proc. Primeira correção tratou ESRCH como ENOENT
   somente após probe independente de PID ausente. Log
   `/tmp/feature005-t028-validator-pressure.log`.
4. Nova regressão ainda reproduziu: estado R sem VmRSS, seguido SIGTERM do
   watchdog, qpdf close0. Log
   `/tmp/feature005-t021-7gg672ji/t022-ops-0723e85ee154/migrated.log`.
   Corrigido caso de mm liberado durante saída: somente statm independente
   inteiramente zerado ou PID ausente comprovado permite RSS0. Missing RSS em
   processo vivo com memória não zerada permanece fail-closed.
5. Dois testes determinísticos cobrem ESRCH/ENOENT com PID presente/ausente,
   EPERM/EACCES, zombie, R sem RSS com memória viva ou zerada. Nenhum limite de
   timeout/RSS/concorrência foi relaxado. Exit/close ainda aguardados antes cleanup.
6. Ensaio final:20 rodadas,40 cadastros10MiB, concorrência2, pico2 filhos,
   zero órfãos, zero falhas. Logs só de códigos/fases/sinais/estado RSS; não capturam
   PDF, saída bruta, tokens ou credenciais.

A cadeia observada demonstra causa de validatorFailed no ensaio atual. Não prova
que a ocorrência histórica anterior teve a mesma causa; ela permanece preservada.

Outra falha encontrada: evidências retidas ultrapassaram25 jobs, teste de claims
antigo não alcançava fixture nova. Priorizada apenas a fixture com next_attempt_at
controlado antes da corrida real; não reduz asserções, não apaga jobs e não altera
algoritmo produtivo. Falha antiga preservada no log0723 acima.

## Validação final e evidências

Run autorizado35eb2feadec9, PostgreSQL17.11/MinIO isolados. Preflight antes dos
testes `/tmp/feature005-t028-preflight.log`; runner novamente autentica identidades
antes do migrated. Nenhuma migration editada/aplicada, nenhum reset ou nova
infraestrutura. Banco de produção compartilhado permanece arquitetura alvo.

| Execução                        | Pass | Fail | Skip |
| ------------------------------- | ---: | ---: | ---: |
| yarn test:budgets:unit          |   88 |    0 |    0 |
| Contratos fundação+HTTP         |    7 |    0 |    0 |
| Migrated G1+US1+HTTP+observação |   78 |    0 |    0 |
| HTTP final após adapter JSON    |    9 |    0 |    0 |

Totais incluem testes-pai; HTTP9 já faz parte do migrated78, não somar reexecução
como cobertura nova. Total das três suítes principais173.

- `/tmp/feature005-t028-unit-verified.log`;
- `/tmp/feature005-t028-contract-verified.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-d4d2dd8127fe/{preflight,migrated}.log`;
- `/tmp/feature005-t028-migrated-verified.log`;
- `/tmp/feature005-t028-http-final.log`;
- `/tmp/feature005-t028-checks.log`: node --check, diff/preservação/Docker finais;
- `/tmp/feature005-t028-format*.log`: Prettier arquivos novos/alterados.

src/app.js e src/routes.js têm estilo legado; preservado no entorno das mudanças,
sem reformatar Features003/004. Migrations, auth compartilhado, package.json,
lockfile, Dockerfile e configuração/upload legados preservados por hashes.

## Parecer

**T027/T028 aceitas e T024 aceita para transporte administrativo US1.** Portal
continua futuro explicitamente, sem checkbox fingindo prova HTTP de rota ausente.
O fluxo administrativo está funcional e integrado, mas **US1 integral ainda não
liberada para próxima história**: T029 integração/checklist próprio, T030 inventário
legado e T031 checkpoint permanecem abertos por escopo. Não marcar essas tarefas
por similaridade com cenários executados aqui. Sem ativação externa/deploy/commit.
Parada após T028.
