# Preparação dos gates T062–T065 (sem autorização implícita)

> **Preparação histórica:** o aceite final de T062 consta no fim deste arquivo
> e em `t062-scope-review.md`; T063–T066 foram aceitas depois, conforme
> `security-validation.md`, `legacy-reconciliation.md`, `quickstart.md` e
> `plan.md`. As instruções condicionais abaixo não são bloqueios vigentes nem
> autorização para repetir integrações ou acessar ambientes 003/004.

## T062: execução antiga necessária

- Aplicação atual: `tests/integration/budgets/domain-isolation.integration.test.js`
  e regressões auth/OS/estoque compartilhadas já aceitas no run Feature 005;
  nenhuma das suites substitui testes CQRS reais dos módulos antigos.
- OS: `tests/integration/service-orders/*.integration.test.js` inclui testes
  recovery de PostgreSQL 17 (`feature004_recovery_integration`), MongoDB 8
  (`feature004_recovery_integration`) e RabbitMQ 4 em rede do projeto
  `feature004-recovery-20261113`. O teste de recovery confere identidade,
  imagem, labels e saúde; não iniciar sua escrita sem autorização do dono.
- Estoque: `tests/integration/stock/cqrs-real.integration.test.js` exige
  `feature003_integration` em PostgreSQL, MongoDB de Feature 003 e RabbitMQ
  próprios; `material-image-postgres-minio.integration.test.js` também exige
  PostgreSQL/MinIO da Feature 003. Testes `.postgres.test.js` isolados não
  equivalem a essas integrações reais.

Autorização mínima: declaração explícita de execução dos testes antigos **nesses
ambientes próprios** (ou ambiente isolado equivalente com suas identidades
verificáveis), credenciais próprias entregues em canal privado e preflight de
database/user, container/image/labels/rede/volumes/saúde de PG/Mongo/Rabbit/MinIO
conforme cada suíte, antes de qualquer escrita. O manifesto Feature 005
`db1126fff37e` autoriza apenas seu PostgreSQL/MinIO e não concede acesso 003/004.
Não provisionar nem consultar containers/dados de 003/004 por presunção.

## T063–T065: preparação sem antecipar dependências

- T063 depende de T062, agora que T061 passou. `security-validation.md` contém
  evidência prévia por superfície; complementar gate integral apenas quando
  regressões antigas estiverem autorizadas e concluídas. O ensaio T061 confirma
  alertas sanitizados e bloqueio de RSS sob pressão, não supervisor produtivo.
- T064 depende de aprovação T063. Preparar IDs sintéticos exclusivos e destino
  de restauração separado do banco principal; capturar contagens e SHA-256 de
  snapshot PostgreSQL/registry e objetos privados antes de restaurar. Revalidar
  manifesto, ownership/ACL, checksums e slots publicado/pendente na cópia;
  iniciar worker real na cópia somente após configurar recibo/identidade
  verificados, conferir que jobs pendentes retomam sem apagar objetos referenciados
  e manter cleanup durante rollback. Não usar `db:drop`, `sync`, down ou sobrescrita
  no banco de integração existente. O teste JSON anterior em
  `legacy-reconciliation.integration.test.js` não prova restauração integral.
- T065: matriz individual 42 RF/10 RNF/8 SC já preparada em
  `traceability-review.md`. Após T064, executar quickstart ponta a ponta das
  cinco jornadas, falhas/restart/races, conferir cada lacuna e reconciliar os
  resultados. Checklist documental não substitui execução nem skip prova gate.

No preparo original, nenhuma operação de T062–T065 dependente de autorização foi
executada. **Atualização posterior (21/11/2026 UTC):** regressões T062 foram
executadas em recursos novos `t062-*`, sem reutilizar containers/volumes 003/004
antigos. PR5 1/1; estoque 003 CQRS 7/7 e PG–MinIO/MinIO/schema/reports 1/1
cada; recovery 004 inicialmente 7/9, duas falhas, zero skips. RF31 passou em
reexecução após criação das identidades exigidas, mas RF32 voltou a falhar na
publicação (0/1). Identidades, preflights, logs e diagnóstico completos em
`t062-scope-review.md`. Isto **não conclui T062**; T063–T066 continuam bloqueadas.

**Atualização seguinte (21/11/2026 UTC):** RF31 e RF32 passaram isoladamente em
bancos novos (1/1 cada), e as nove recovery passaram em terceiro banco novo
(**9/9, zero falhas, zero skips**). A fixture de identidade é transacional e
rollback-only; o stub RF32 agora delega os listeners ao canal de confirmação
RabbitMQ real. Registros e isolamento em `t062-scope-review.md`. Recomenda-se
aceite de T062 após revisão das evidências; T063–T066 não foram iniciadas.

**Aceite técnico final (21/11/2026 UTC):** revisão dos logs e preflights existentes
confirmou todos os critérios originais da T062. Matriz final em
`t062-scope-review.md`; checkbox T062 `[x]` em `tasks.md`. Os bloqueios T062
anteriores neste arquivo são históricos. T061 já estava `[x]`; a dependência de
T063 está satisfeita para **iniciar o gate**, não para aprová-lo. T063–T066
permanecem `[ ]`; nenhuma execução de T063, deploy ou liberação foi realizada.
