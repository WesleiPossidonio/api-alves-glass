# US1 — rodada T023–T026 (2026-11-17)

## Estado e limite

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
branch `feature/005-budgets-pdf`, alterações anteriores preservadas. G1 aceito,
sem reaplicar migrations, fresh/upgrade ou reprovisionar T021. Nenhum endpoint,
controller ou multipart novo; esses itens pertencem expressamente a T027/T028.
Tabela `budget`, migrations aceitas, Features003/004, rotas, Dockerfile,
package.json e lockfile não modificados nesta rodada.

| Tarefa | Estado e evidência                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T023   | Concluída: testes de criação/compensação, autor real, qpdf antes registry/PUT, intenção commit antes PUT, falhas READY/ATTACHED/UNIQUE/armazenamento, revogação, abort, cleanup indisponível e commit ambíguo. Vermelho inicial preservado.                                                                                                                                                                                                                                   |
| T024   | Arquivo de contratos escrito e verde; aceite **parcial**, checkbox conservadoramente aberto. Guards existentes comprovados isoladamente e em pipeline de teste (sessão live, Origin, CSRF assinado, requireUser antes acesso ao corpo); DTO estrito, resposta mínima/ETag e ausência de vazamentos demonstrados nos serviços. HTTP201/Location/ETag real, multipart na rota e ausência no portal via HTTP aguardam T027/T028/portal. Não há endpoint fictício nem teste skip. |
| T025   | Concluída: serviço de cadastro real, reautorização no commit, bytes qpdf, intenção durável, PUT/stat, pares pending/data/created_by atômicos, revision1, duplicate409, compensation e reconciliação sem exclusão indevida.                                                                                                                                                                                                                                                    |
| T026   | Concluída: serviço de listagem/detalhe READ setorial sem filtro de autor, busca textual exata, keyset25/100, HMAC scoped, DTO allowlist e ocultação de existência.                                                                                                                                                                                                                                                                                                            |

T024 é dependência de **escrita dos testes** para T025, satisfeita antes da
implementação; seu aceite HTTP ponta a ponta não foi falsamente declarado.
Parada após esta rodada. T027 não iniciada.

## Implementação

Arquivos novos sob a raiz absoluta indicada acima:

- `src/app/services/BudgetPdfCreateService.js`: `create(input, actor, bytes, {signal})`;
- `src/app/services/BudgetPdfReadService.js`: `list(input, actor)` e `detail(id, actor)`;
- `tests/unit/budgets/create.test.js`;
- `tests/unit/budgets/admin-http.test.js`;
- `tests/support/budgets/create-scenario.js`;
- `tests/integration/budgets/us1-create-read.integration.test.js`;
- este relatório.

Arquivos modificados:

- `src/app/repositories/BudgetPdfRepository.js`: referências globais com SHARE,
  descoberta de detalhe, consulta keyset parametrizada, posição com microsegundos;
- `src/app/repositories/BudgetPdfObjectRepository.js`: enqueue de compensação
  limitado ao token e objeto sem referências, nunca ATTACHED;
- `tests/support/budgets/integration-cli.js`: inclui a nova suíte no migrated;
- `specs/005-budgets-pdf/tasks.md`: estado desta rodada.

Actor é contexto confiável `{id,type:'user'}`, não corpo da requisição. Role,
status, membership e grants vêm do PostgreSQL pelo autorizador G1, não de actor.role.
CREATE_EDIT não implica READ. Admin global e manager seguem o autorizador aceito.
Clientes não atravessam serviços internos; privado continua sem slot publicado e
é negado pelo autorizador de portal existente.

Cadastro retorna somente `{id,revision,pendingDocumentId}`. Não publica, não cria
itens/preços e não entrega DTO completo por possuir CREATE_EDIT. Não há DELETE
físico na compensação: enqueue durável, ou intent com lease expirável se DB falhar.
Uma confirmação de commit perdida não enfileira objeto ATTACHED; busca autorizada
por número recupera o resultado. Revogação e perda de membership durante PUT
impedem attach. Erros saem pelos códigos sanitizados existentes.

Leitura usa allowlist do DTO aprovado, sem joins Client/credenciais/registry;
READ revalidado em cada página, inclusive com cursor válido. Detail descobre
setor, autoriza e só então toma lock compartilhado; mudança concorrente de setor
falha fechada sem inverter ordem de guards. Expired publicado é civil São Paulo.
Paginação mantém microsegundos PostgreSQL, evitando perda de linhas que diferem
abaixo de1ms, e desempata por UUID. Teste real insere timestamps controlados com
empates sem editar identidade protegida.

Cursor requer segredo explícito >=32 bytes via `cursorSecret` ou serviço injetado;
nenhum fallback aleatório por processo nem reutilização silenciosa de credenciais.
Composição/configuração do transporte permanece para T027/T028. Nenhum segredo
produtivo foi criado ou exposto.

## Testes executados

Preflight de identidade existente antes de operações externas:
`/tmp/feature005-us1-preflight.log`, run `35eb2feadec9` PostgreSQL17.11/MinIO,
e novamente pelo runner migrated final. Banco principal não resetado. Fixtures
UUID novas por execução, dados e tentativas anteriores preservados.

| Execução final             | Aprovados | Falhos | Skips |
| -------------------------- | --------: | -----: | ----: |
| `yarn test:budgets:unit`   |        85 |      0 |     0 |
| Contratos fundação         |         5 |      0 |     0 |
| Runner migrated (G1 + US1) |        68 |      0 |     0 |

Totais Node incluem testes-pai. Nova suíte integrada:10 subtestes+pai=11;
unidades acrescidas:15. Total das três execuções finais:158, sem somar repetições.

Evidências:

- `/tmp/feature005-us1-t023-t024-red.log`: vermelho relevante, serviços ainda ausentes;
- `/tmp/feature005-us1-unit-final.log`:85/85;
- `/tmp/feature005-us1-contract-final.log`:5/5;
- `/tmp/feature005-us1-integration-final.log`:11/11;
- `/tmp/feature005-t021-7gg672ji/t022-ops-9e9b8b8b24f3/preflight.log`;
- `/tmp/feature005-t021-7gg672ji/t022-ops-9e9b8b8b24f3/migrated.log`:68/68;
- `/tmp/feature005-us1-migrated-final.log`: identidades Docker e exit0;
- `/tmp/feature005-us1-checks.log`: sintaxe/preservação/diff/identidades finais;
- `/tmp/feature005-us1-format.log` e logs adicionais de formatação desta rodada.

Integração real cobre qpdf/PDF malformado, assinatura/tamanho, campos obrigatórios,
cliente/setor inexistentes, zero intent nos negativos de PDF, número textual,
UNIQUE concorrente, referências finais, falha PUT após commit remoto via proxy,
falha stat, lease expirado, revogação/perda de membership durante PUT, READ
revogado após emissão de cursor e confirmação de commit perdida.

## Falhas encontradas durante desenvolvimento

- Host possui diretório node_modules, mas não dependências necessárias (sequelize);
  tentativa local de teste falhou por ambiente, não removida. Execução válida usa
  a imagem fixada existente com suas dependências, sem instalar/alterar lockfile.
- Primeira fixture omitia `user_sectors.created_at NOT NULL`: corrigida a fixture,
  sem alterar schema. Log `/tmp/feature005-us1-integration-first.log` preservado.
- Uma tentativa de cadastro concorrente obteve validatorFailed antes de atingir
  UNIQUE; causa não isolada, portanto não atribuída a runtime ou watchdog.
  Reexecução e regressão final completa passaram. Não se relaxou validator/RSS/timeouts.
  Registro em `/tmp/feature005-us1-integration-second.log`; não é alegação de
  correção de defeito G1 não reproduzido deterministicamente nesta rodada.
- Fixture de lease inicialmente passava cliente MinIO genérico ao adaptador,
  sem o contexto de transporte dedicado; ajustada para usar a factory G1 real.
  Negativos stat/lease agora comprovados independentemente. Logs anteriores
  permanecem; nenhuma falha foi convertida em skip/sucesso simulado.

Nenhum defeito comprovado exigiu alterar migrations ou regras G1. A integração
US1 usa serviços reais e proxy de transporte apenas para interrupção externa;
unidades usam doubles explícitos e não são apresentadas como prova de MinIO.

## Próximas tarefas (não executadas)

T027: controller fino, tradução request/actor, DTO/erros HTTP, multipart exclusivo
com limites/timeout/abort; T028: composição auth/requireUser/CSRF antes multipart,
Location/ETag/status e compatibilidade legada conforme planejamento. Somente
nessa composição é possível completar o aceite HTTP real de T024. Não confundir
`publicBudgetError` interno G1 com envelope HTTP final `{error:{code,message,requestId}}`;
adaptação de transporte ainda não implementada. Publicação, substituição,
exclusão e portal continuam fora desta rodada.
