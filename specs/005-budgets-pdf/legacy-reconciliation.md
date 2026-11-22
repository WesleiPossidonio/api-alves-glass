# T030 — Inventário e reconciliação do legado

## T064 — ensaio de restauração isolada (2026-11-21)

Aceite técnico **T064** no run novo `7aac9fa67b8e`. Manifesto e recibo remoto
verificados pelo provisionador existente; rede interna sem portas publicadas,
PostgreSQL17/MinIO e volumes novos exclusivos. Migrations até
`20261130000000` aplicadas somente ao banco novo; nenhum recurso antigo alterado.
Evidências privadas em
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/7aac9fa67b8e/`:
`t064-source.dump` (pg_dump formato custom, 206100 bytes, SHA-256 em
`t064-dump.sha256`), `t064-seed.log`, `t064-restored.log`,
`t064-copy-worker.log`, `t064-worker-done.log` e exits respectivos **0**.

- Fixture sintética: 1 linha legado `budget`, 1 orçamento novo, 1 registry
  `ATTACHED`, usuário, setor e cliente existentes, PDF real no bucket privado.
  Identidade/relacionamentos e SHA-256 de bytes foram conferidos; o registro
  legado não contém setor/autoria/número comercial nem é importado ou publicado.
- `pg_restore --single-transaction --exit-on-error` restaurou em banco **separado**
  `feature005_test_7aac9fa67b8e_fixture_48416d1d1018`, dentro do mesmo
  PostgreSQL isolado. A identidade remota foi provisionada antes; a lista de
  restauração excluiu somente o schema técnico do recibo (nunca tabelas de
  domínio). Uma primeira tentativa de restaurá-lo por cima do recibo falhou
  sem alterações, conforme `t064-restore.log`; o restore filtrado passou
  (`t064-restore-attempt3.exit=0`). A comparação **antes de qualquer job**
  passou 1/1: contagens 1/1/1, hashes completos de linhas legado/novo/registry
  e SHA-256 do PDF lido no MinIO coincidiram. O bucket foi mantido privado e
  revalidado; os bytes são preservados por este exercício, não se alega
  restauração física do volume MinIO a partir do pg_dump.
- Exclusão do cliente do orçamento novo foi rejeitada por FK RESTRICT sem
  alterar cliente, legado ou orçamento (`t064-client-restrict.log`). O down
  protegido em banco populado foi negado (`BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES`),
  sem executar down ou destruir dados (`t064-down-guard.log`); o down real em
  fixture vazia já foi ensaiado em `schema.postgres.test.js`.
- Na **cópia**, criou-se uma chave de limpeza exclusiva não referenciada, com
  registry durável. CLI real do worker (`BUDGETS_WORKER_RUN_ONCE=1`) executou
  com preflight remoto: `budgetWorkerReady`, `budgetWorkerTick completed:1`,
  `budgetWorkerStopped`, exit 0. Objeto exclusivo ausente, job `REMOVED`, PDF
  referenciado legível e checksums de orçamento/legado inalterados após tick.
  Origem terminou com contagens 1/1/1; cópia, 1/1/2 (job terminal adicional).
- Testes focais: `t064-seed`, `t064-restored`, `t064-prepare-job`,
  `t064-worker-ready`, `t064-worker-done`: **5/5 aprovados, 0 falhas,
  0 skips**; CLI worker **exit 0**. Falhas intermediárias do harness em runs
  distintos estão preservadas: provisionamento incompleto `2895dfd69f46`,
  fixture que violou o estado inicial do registry e tentativa com identidade
  repetida `5ea4139075e8`; não usadas como evidência de aceite. Correção
  apenas no teste focal para respeitar UPLOADING→READY→ATTACHED e exigir
  origem vazia. Não houve modificação em migrations, contratos ou produção.

Dados reais/importação/cutover seguem fora deste ensaio e exigem aprovação
própria. Nenhum down em banco populado, deploy ou importação foi realizado.

---

Data: 2026-11-17. Procedimento, **não importação**. Raiz dos caminhos abaixo:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`.

## Estrutura e dependências examinadas

A migration histórica `src/database/migrations/20261110000200-create-orders-and-budgets.cjs`
cria `public.budget`: id UUID PK; client_id UUID nullable, FK client com
ON DELETE SET NULL; name_budget e description_budget varchar obrigatórios;
expiration_date timestamp obrigatório; total_value decimal(10,2) obrigatório;
pdf_object_name varchar nullable; created_at/updated_at timestamps obrigatórios.
O Model `src/app/models/Budget.js` mantém essa tabela e associação client_budget;
os atributos textuais do Model não repetem todas as restrições NOT NULL da migration.

`src/app/repositories/BudgetRepository.js` oferece CRUD; o Service
`src/app/services/BudgetService.js` usa diretamente o Model, não esse Repository.
Criação verifica existência do usuário, aceita PDF opcional e usa StorageService.upload
com prefixo budgets/2026 e MINIO_BUCKET. Não persiste autor, setor, número textual,
hash, registry ou publicação; não compensa PUT se a persistência falhar.
Atualização referencia budget_number/status_description/status, divergentes do Model;
não corrigir silenciosamente durante inventário. Consulta por cliente usa client_id;
consulta individual usa PK. Excluir pode remover objeto e registro pelo fluxo legado.
O Controller `src/app/controllers/BudgetController.js` valida/sanitiza campos
legados, recebe request.userId e file e possui métodos de CRUD. Na composição
`src/routes.js`, somente POST /budged está ligado a esse Controller, após auth,
requireAdmin e upload.single('file'). Métodos presentes não significam rotas expostas.
`src/config/multer.js`, `src/config/minio.js`, StorageService e cadastro global Client
continuam dependências existentes. Nenhum desses arquivos foi alterado nesta rodada.

## Correspondências e impedimentos

| Legado                         | Candidato novo                                    | Condição obrigatória                                                                                                |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| id                             | identidade de origem em manifesto restrito        | Não presumir equivalência com novo budget/document UUID; detectar colisões e registrar mapeamento explícito futuro. |
| client_id                      | client_id global                                  | Exigir cliente existente, sem inventar cliente para NULL.                                                           |
| name_budget                    | administrative_name                               | Revisão humana e validação de tamanho/conteúdo; não derivar número do nome.                                         |
| expiration_date                | validade civil                                    | Confirmar intenção/data/fuso na origem; não truncar timestamp automaticamente.                                      |
| pdf_object_name                | localização histórica                             | Chave não comprova bucket, existência, ACL, MIME, conteúdo ou hash; não copiar para registry.                       |
| created_at/updated_at          | datas históricas                                  | Conservar como evidência de origem; não fabricar autoria ou publicação.                                             |
| description_budget/total_value | sem equivalente                                   | Novo domínio é documental sem itens/preços; preservar no legado, não acrescentar campos ao DTO.                     |
| ausentes                       | setor, número comercial, autor, PDF validado, ACL | Bloqueiam incorporação até prova e decisão explícitas. Operador não vira autor histórico.                           |

Números iguais em setores diferentes são permitidos; mesmo par setor/número é
conflito. Preservar zeros, espaços e texto conforme contrato, sem normalização
destrutiva. UUID, chave compartilhada e hash igual não são prova de mesma identidade
comercial. Dois registros podem apontar ao mesmo objeto; nenhuma limpeza pode
ser deduzida apenas de contagens. ACL desconhecida impede incorporação.

## Procedimento futuro autorizado separadamente

1. Obter autorização do responsável pelo ambiente e escopo exato de leitura.
   Confirmar identidade da instância/banco/bucket, versão PostgreSQL 17 e retenção.
   Produção continua no banco compartilhado da API; este procedimento não cria
   banco produtivo exclusivo nem autoriza acesso a dados reais.
2. Em snapshot consistente READ ONLY, coletar schema, constraints, total, UUIDs
   distintos, nulos, referências de cliente órfãs, chaves ausentes/repetidas e
   correspondências já existentes. Nunca atualizar budget nem migrations.
3. Manter manifesto detalhado criptografado/restrito, fora de logs e repositório;
   relatório público somente com totais agregados e códigos de impedimento.
   Serializar colunas em ordem fixa, ordenar por UUID e calcular SHA-256 do snapshot;
   comparar contagem/UUID/checksum antes/depois e conservar recibo de leitura.
4. Somente com autorização de storage, resolver bucket real e verificar stat,
   política/ACL e bytes via canal privado para SHA-256 e qpdf sob os limites atuais.
   Sem URL pública, sem registrar chave ou dados pessoais em evidência pública,
   sem PUT/DELETE, sem copiar bytes ao registry. Ausência de permissão ou ACL
   desconhecida = bloqueio, nunca suposição de privado.
5. Classificar cada origem: incompleto, documento ausente/inválido, ACL desconhecida,
   identidade ambígua, duplicidade comercial, pronto para revisão. Exigir aprovação
   humana de cliente/setor/número/autoria/data, mantendo proveniência e conflitos.
   Autoria/data não comprovadas continuam ambíguas; não preencher com operador/agora.
6. Repetir contagens/checksums e registrar que nenhuma origem mudou. Importação
   exige desenho e aprovação próprios, mapeamento idempotente de identidade e
   revalidação na transação; não está implementada/autorizada aqui. Mesmo no futuro,
   nenhuma incorporação implica publicação: publicação manual é outra operação.
7. Preservar /budged nesta entrega. Em futura iniciativa independente, identificar
   consumidores externos, comunicar, testar compatibilidade e aprovar transição
   antes de qualquer 410, adaptação ou desativação. Coexistência não comprova
   conformidade do legado ao módulo novo.

Dados reais, consumidores e ACL históricos de outros ambientes são dependências
**não executadas**. São bloqueios para eventual incorporação/desativação futura,
não para preservar o legado nesta feature.

## Demonstração isolada

`tests/integration/budgets/legacy-reconciliation.integration.test.js` usa o preflight
remoto existente e PostgreSQL 17 do run 35eb2feadec9. Lê schema e checksum da tabela
budget de teste; cria somente TEMP TABLE ON COMMIT DROP com três registros
sintéticos e UUIDs distintos: dois compartilham chave fictícia e um não tem cliente
nem documento. Valida total 3, UUIDs distintos 3, duplicidade de chave 2, nulos 1/1,
checksum estável e ausência das identidades no novo registry de orçamentos.
Todos permanecem bloqueados: autor/setor/número/ACL/hash não foram comprovados.
Não insere, altera ou apaga nenhuma linha de budget; não acessa documentos legados.
Verifica preservação da rota /budged e ausência de união com budget no Repository
novo. A suíte create/read também compara snapshot do legado antes/depois dos fluxos.

## T060/T064 — decisão posterior e ensaio sintético (2026-11-19)

T060 não retira /budged nesta feature. Inventário local em `src`, `tests` e
`docs`: somente composição da rota em `src/routes.js`, controller/service/model
legados e sondas em `tests/integration/budgets/us1-http.integration.test.js` e
`legacy-reconciliation.integration.test.js`; não há consumidor frontend HTTP
identificado neste repositório. Consumidores externos são **desconhecidos**,
não comunicados ou migrados, pois não haverá desativação nesta versão. A eventual
retirada exige projeto, comunicação, testes e autorização independentes.

O teste T064 restaura um backup JSON efêmero de duas linhas **sintéticas** com
contagem e SHA-256 conferidos antes/depois da recuperação. Cliente NULL permanece
NULL; setor/autoria desconhecidos não são preenchidos. Compara SHA-256 do snapshot
read-only da tabela pública `budget` antes/depois; nenhum insert/alter/delete
nela ou importação em `budgets_pdf`. O down das quatro migrations é protegido
contra tabelas não vazias (suíte `schema.postgres.test.js` em fixtures anteriores,
sem novo down no banco migrated). A política futura de restauração completa,
backup de MinIO e worker ativo deve ser ensaiada antes de qualquer cutover real;
não são autorizados por este exercício de backup de dados sintéticos.
