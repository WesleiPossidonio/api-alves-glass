# Relatórios HTTP (implementação local; G6 em validação)

- `GET /reports/stock?from=YYYY-MM-DD&to=YYYY-MM-DD` retorna agregados por material/unidade.
- `GET /reports/stock/statement?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=25&cursor=...` retorna eventos
  por keyset. Ambos aceitam filtros `warehouseId`, `sectorId`, `materialId`, `type`, `withdrawnBy`,
  `receivedBy`, `performedBy` e `authorizedBy`; intervalo é `[from,to)` em `America/Sao_Paulo`,
  máximo 12 meses civis. Endpoints exigem sessão persistida de `admin` ou `user`; grants são
  reconsultados em cada chamada.
- Exporte `STOCK_REPORT_CURSOR_SECRET` com pelo menos 32 bytes antes de habilitar extrato paginado;
  ausência ou tamanho menor falha fechado (não há fallback).
  Cursor é HMAC autenticado, vinculado à consulta/escopo e preserva `asOf`; não representa snapshot
  transacional completo (commit tardio/timestamp retroativo não é coberto).
- T042 não está liberada: aguarda validação operacional G5 e aprovação específica do desenho de
  migration `minio_cleanup_jobs` em `contracts/stock-api.md`. Não criar bucket, ajustar permissões ou
  aplicar migration sem os respectivos gates.
- Preparação de mídia usa `MINIO_PUBLIC_BUCKET` e `MINIO_PRIVATE_BUCKET` distintos para imagens;
  `MINIO_USE_SSL=true` habilita TLS. Configurar esses valores após validação operacional; o upload
  legado de documentos continua usando `MINIO_BUCKET`.
- A proposta de DDL concreta para referência de imagem em Material, `minio_cleanup_jobs` e
  `minio_upload_intents` está em `docs/feature-003-minio-cleanup-migration-proposal.md`. Aguarda revisão;
  não há migration aplicável nem endpoint de imagem habilitado.
- O plano/Compose proposto para banco efêmero independente está em
  `docs/feature-003-postgres-disposable-environment-plan.md` e `deploy/feature003-test/compose.yml`.
  Não iniciar Docker antes de autorização explícita do plano; o Compose não usa volumes existentes.
# Quickstart de implementação — Feature 003

Este é um roteiro para futura implementação, não um comando executado. Use apenas ambiente local
descartável explicitamente autorizado. Não apontar testes para banco de rebuild, produção ou banco
com dados a preservar.

PostgreSQL 17 é a versão oficial adotada pela Alves Glass API e a versão-alvo desta feature.

## Pré-condições

1. Cadastro de Material recebe `initialQuantity` decimal em string e grava Material, saldo e único
   `OPENING` atomicamente. A regra oficial substitui a abertura separada e dispensa aprovação G1
   adicional para este cadastro; zero é permitido.
2. Aprovar ciclo de vida do PIN, designação de responsáveis, prazos de retenção G4, dado distintivo
   do retirante e magnitude máxima quantitativa. G5 e G6 já têm regras funcionais aprovadas conforme
   `spec.md`; mídia ainda exige validação operacional, relatórios exigem implementação e testes.
3. Confirmar que o banco de teste PostgreSQL 17 é isolado e reconciliável; não alterar Docker
   Compose ou infraestrutura nesta feature.
4. Confirmar Node runtime real; Feature 002 documenta Node 22, enquanto `package.json` não fixa
   engines.
5. Confirmar que a Constituição 2.0.0 vigente está aprovada. Não alterar migrations legadas.

## Sequência de validação futura

```sh
yarn install --frozen-lockfile
yarn db:migrate:status
yarn test
```

Não executar `yarn db:migrate` até que o ambiente alvo seja validado, migration revisada e aprovação
operacional registrada. A aplicação não deve aplicar migrations no startup.

Integração HTTP/PostgreSQL deve seguir o isolamento de `tests/support/database` e variáveis de
feature; definir novo opt-in explícito (ex.: `RUN_POSTGRES_STOCK_INTEGRATION=1`) somente após revisar
target identity/allowlist. Não relaxar os gates de identidade existentes. Os testes devem criar e
limpar somente recursos de sua própria execução; nunca truncar tabelas indiscriminadamente.

## Cenários mínimos de verificação

- migration nova sobe em DB PostgreSQL descartável e constraints/índices correspondem ao modelo;
  down só em ambiente efêmero sem dados que precisem ser preservados.
- user sem setor e user de outro setor não leem nem alteram recursos; admin tem escopo global.
- Cadastro inicial valida `initialQuantity` por string/unidade e grava OPENING uma única vez;
  falha em qualquer escrita reverte material, saldo e evento.
- `IN`, `OUT`, `RETURN`, `ADJUSTMENT`, `OPENING` validam escala, sinal e motivo; nenhuma operação
  permite saldo negativo.
- duas saídas concorrentes disputando saldo só confirmam operações compatíveis com o saldo; o
  saldo final reconcilia com os eventos.
- retry idêntico em concorrência cria no máximo um evento e retorna resultado original; chave
  repetida com payload distinto conflita; a chave é única por
  `(warehouse, principal_type, principal_id, key)`. Uma intenção QR mantém também um identificador
  estável de operação; retry após troca de autorizador não cria segundo movimento e não substitui
  a autoria do evento original.
- QR público só expõe nome, imagem aprovada e unidade; QR não autoriza movimento.
- Retirada QR é unitária: resolve material/saldo, recebe quantidade, solicita PIN, valida titular e
  setor, registra um único OUT atômico e retorna à leitura. Não há retirada em lote.
- O PIN identifica o próprio retirante; lookup usa digest HMAC indexado e verificação Argon2id/bcrypt.
  `withdrawnBy` e `authorizedBy` derivam da identidade verificada; origem QR não cria sessão nem
  preenche `performedBy`. PIN/hash nunca aparecem em resposta/log/ledger.
- Tentativas são persistentes por PIN lookup e origem: cinco falhas em 15 minutos bloqueiam por
  15 minutos. Não comparar PIN com múltiplas contas; colisões de PIN ativo são rejeitadas.
- QR identifica Material, sem credenciais; identificação manual protegida por PIN. O backend valida
  material ativo, warehouse ativo e autorização setorial atual antes de movimentar.
- ledger recusa edição/exclusão operacional; correção e devolução preservam referência quando
  identificável.
- OPENING inicial do cadastro único, incluindo delta zero, sem operação manual posterior; nenhuma
  importação de Product legado.
- material inativa somente com saldo zero; histórico continua consultável.
- relatório por Material/unidade reconcilia saldo inicial, todos os efeitos tipados e saldo final;
  G6 aplica `America/Sao_Paulo`, até 12 meses, intervalo semiaberto, keyset 25/100, cursor opaco
  protegido/vinculado ao escopo e filtros, autorização revalidada e ordenação determinística; testar
  marco de leitura sob movimentações concorrentes.
- G5: imagem JPEG/PNG/WebP até 5 MB validada por conteúdo; bucket público só para catálogo publicado,
  arquivos privados autorizados por URL temporária; chave única. Atualizar referência só após upload
  confirmado e limpar objeto anterior/órfão sem nunca excluir objeto ainda referenciado. Executar
  somente após validar buckets, credenciais e permissões; esta etapa não cria buckets.

## Estado operacional e limites
O ledger append-only e o saldo transacional PostgreSQL são autoritativos. A implementação arquitetural
de T048–T050 grava Outbox na transação, publica at-least-once por RabbitMQ, consome com deduplicação
MongoDB e mantém projeções reconstruíveis/paginadas em `movements`; MongoDB não é fonte de saldo.
Snapshots versionados SHA-256 são checkpoints recuperáveis exigidos pelo aceite, nunca substitutos dos
eventos; configurar `INVENTORY_SNAPSHOT_EVENT_INTERVAL` (default técnico 500). Não introduzir Redis,
integração automática com OS nem sincronização com `Product`.

### CQRS em ambiente isolado
Ative `FEATURE003_CQRS_INTEGRATION=1` somente junto às credenciais do Compose
`deploy/feature003-test/compose.integration.yml` previamente autorizado. O teste exige PostgreSQL
`feature003_integration` em `127.0.0.1:55438`, MongoDB replica set em `127.0.0.1:27028` e RabbitMQ em
`127.0.0.1:5678`; ele não deve apontar para `.env` de desenvolvimento. Execute
`npm run test:integration:cqrs`. Fixtures PostgreSQL são append-only e isoladas por UUID/prefixo; não
purge filas ou coleções compartilhadas e não use `down -v`.

### Mídia G5 e gates não liberados
O serviço de imagem e o worker de cleanup estão implementados, mas rotas/worker reais permanecem
desabilitados até aprovação operacional de endpoints MinIO, buckets público/privado, credenciais,
políticas de acesso e permissões. A implementação local validada usa mocks/contratos e não cria buckets
nem altera configuração remota. Ver `docs/feature-003-minio-cleanup-migration-proposal.md`.
G4 exige decisão jurídica/operacional sobre retenção; ledger/autoria permanecem preservados, sem
expurgo automático. G2/G3 e G6 têm decisões funcionais registradas em `tasks.md`; retirada QR segue
unitária conforme FR-022, sem inferir autorização para operação multi-material.