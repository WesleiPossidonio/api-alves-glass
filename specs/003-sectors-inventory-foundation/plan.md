# Implementation Plan: Setores e Estoque

**Branch**: `003-sectors-inventory-foundation` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Especificação consolidada da Feature 003 e Constituição 2.0.1.

## Summary

Planejar o novo domínio de estoque Material no PostgreSQL, sem associação ou sincronização com
`Product`. A implementação seguirá o monólito Express existente, seus Models Sequelize e camadas
Controller → Service → Repository → Model. Cada comando de estoque deve persistir saldo, evento
append-only e resultado de idempotência numa única transação. Saídas e ajustes negativos serão
serializados por linha de saldo; autorização setorial é validada no servidor. O fluxo de retirada
por QR é pontual, sem sessão, identifica o autorizador antes de validar seu PIN e registra a
This plan does not execute implementation. **Regras de negócio ainda pendentes permanecem gates para
execução das tarefas afetadas**, especialmente onboarding/recuperação de PIN, prazos de retenção,
dado distintivo exibido para desambiguar retirantes e contratação operacional (SLO/volume). G5 tem
regras funcionais aprovadas, mas depende de validação operacional de MinIO, buckets, credenciais e
permissões. G6 tem decisões funcionais aprovadas (`America/Sao_Paulo`, 12 meses, paginação e limites);
cursor protegido e marco de leitura são decisões de implementação ainda a desenhar, não gates de
negócio. Onde o contrato já está decidido, o plano não o reabre.
contrato já está decidido, o plano não o reabre.

## Technical Context

**Language/Version**: Node.js ESM; Feature 002 documenta Node 22. Confirmar runtime de execução no
ambiente de implementação, pois `package.json` não declara `engines` (verificação operacional, não
pendência de negócio).
**Primary Dependencies**: Express 5, Sequelize 6, `sequelize-cli` convencional, `pg`, Yup, Node
`node:test`; MinIO/Multer já existem para mídia.
**Storage**: PostgreSQL 17 canônico. Reutilizar MinIO e Multer existentes para imagem, sujeito à
confirmação do bucket, credenciais, política de acesso e retenção; não introduzir outro storage.
**Testing**: `node:test`; testes unitários em `tests/unit`, integração HTTP/PostgreSQL em
`tests/integration`, migrations convencionais em `src/database/migrations` e metadata
`public.SequelizeMeta`.
**Target Platform**: API Express existente; nenhum serviço/infra adicional.
**Project Type**: API monolítica Node.js.
**Performance Goals**: SLO, volume e limites de concorrência não definidos; não inventar metas.
**Constraints**: Constituição 2.0.0; PostgreSQL 17; migrations aditivas, não editar migration aplicada, saldo e
evento atomicamente, append-only, idempotência transacional, precisão decimal exata, segregação de
setor, Product separado, Origin+CSRF em mutações autenticadas por cookie. QR não é credencial.
**Scale/Scope**: dois setores iniciais; múltiplos almoxarifados por setor; consultas e ledger
PostgreSQL para a entrega da Feature 003. Esta fronteira não cancela a arquitetura aprovada de
  Event Sourcing/CQRS para Estoque e OS, nem a previsão de Outbox/RabbitMQ e projeções MongoDB.
  A Feature 003 não declara esses componentes entregues; ver
  `docs/architecture/approved-domain-architecture.md`.
Não inclui integração automática entre OS e estoque nem Redis no domínio de estoque.

### Arquitetura aprovada e aceite obrigatório

- Event Sourcing: `InventoryEvent` é o histórico canônico append-only de `OPENING`, entradas, saídas,
  devoluções, ajustes e compensações; o saldo atual é uma visão transacional PostgreSQL, reconstruível
  pelos eventos e mantida atomicamente para consistência operacional.
- CQRS: comandos permanecem no PostgreSQL; consultas usam projeções de leitura MongoDB reconstruíveis.
  O extrato/histórico é exposto sob `movements`, com relatórios e consultas reconciliáveis ao ledger.
- Transactional Outbox grava, na mesma transação PostgreSQL do fato canônico destinado à publicação,
  o envelope de integração. RabbitMQ publica assincronamente com entrega at-least-once; consumers
  deduplicam por identidade do evento e suportam falha, retry e reentrega sem duplicar efeitos.
  Snapshots versionados são exigidos pelo critério de aceite registrado
  em 12/11/2026; não substituem nem removem o ledger. Redis não integra a arquitetura da Feature 003.
- Esta descrição fixa a arquitetura obrigatória para concluir a Feature 003, sem reabrir tarefas
  já concluídos nem declara componentes de mensageria/projeção implementados. T048–T050 e suas
  validações são pré-requisitos de T047; T051 valida snapshots versionados exigidos para recuperação.
- Sequência e dependências
  além da Feature 003 só podem ser ajustadas com as fontes originais aprovadas das features pertinentes.

## Constitution Check

| Princípio | Resultado | Plano/condição |
|---|---|---|
| I — integridade transacional | PASS condicionado a testes PostgreSQL 17 reais | Cadastro grava Material, saldo inicial e OPENING numa transação; movimentações mantêm saldo, evento e receipt atômicos; lock da linha de saldo; constraints para saldo e quantidades. Correção só por evento compensatório. |
| II — domínios independentes | PASS | Material não referencia/sincroniza Product; referência de OS é texto sem efeito. |
| III — sessão/autorização | PASS | Reutilizar `authMiddlewares`, `requireAdmin` e política de Origin+CSRF para mutações com cookie. PIN QR identifica autorizador, não cria sessão. |
| IV — idempotência | PASS | Unicidade aprovada por almoxarifado + principal efetivo (`performedBy` autenticado ou `authorizedBy` no QR) + chave do cliente. Adicionar `operationId` estável e único por almoxarifado para a intenção lógica; retry QR após troca de autorizador revalida autorização, não duplica evento nem troca autoria original. Hash canônico e resultado ficam na transação. |
| V — testes | PASS planejado | Unitários e HTTP/PostgreSQL; corrida, falha parcial, replay e constraints exercitados em DB descartável. |
| VI — migrations | PASS condicionado a preflight | Só migrations novas aditivas por sequelize-cli; nenhum `sync()` nem alteração destrutiva/automática de dados legados. |
| VII — compatibilidade de API | PASS | Rotas atuais preservadas; acrescentar endpoints de domínio sob autenticação adequada. |

**Gate antes de implementação**: decisões pendentes bloqueiam apenas as capacidades que dependem
delas, não a decomposição de tasks. Precisão e escopo de unicidade estão aprovados. `operationId`
estável e único por almoxarifado impede retry duplicado após troca de autorizador; revalidar acesso
antes de devolver receipt e, se revogado, negar replay sem alterar evento/saldo.

## Project Structure

### Documentation (this feature)

```text
specs/003-sectors-inventory-foundation/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    └── stock-api.md
```

### Source Code (implementation targets; not created by this planning action)

```text
src/
├── routes.js
├── app/
│   ├── controllers/       # Sectors, Warehouses, Materials, StockMovements, StockReports, QR
│   ├── services/          # StockMovementService, StockReportService, sector/material/PIN services
│   ├── repositories/      # repositories accept transaction options
│   ├── models/            # Sector, UserSector, Warehouse, taxonomy, Material, balance, event, PIN/audit
│   └── middlewares/       # existing app/meddleawares pattern; no parallel framework
├── config/                # existing multer/MinIO configuration only
└── database/migrations/   # one or more additive Sequelize CLI migrations
tests/
├── unit/stock/
├── integration/stock-*.postgres.test.js
└── contract/stock-api.test.js
```

**Structure Decision**: manter um único Express API e convenções atuais. Os nomes acima são
propostas de destino, não arquivos criados. Repositories recebem `{ transaction }`; Services abrem
e encerram transações; Controllers validam formato e traduzem erros, sem conter regra de saldo.

## Implementation Sequence (planning only)

### Aprovação G2/G3 e limite desta etapa

G2/G3 estão formalmente aprovadas: QR é identificador não secreto de um material; consulta pública
expõe apenas dados mínimos e tem rate limit persistente; retirada não exige sessão e usa PIN individual
de seis dígitos como identidade, com HMAC lookup + hash seguro. Backend define setor e identidade;
`withdrawnBy` e `authorizedBy` são o mesmo usuário. Cada comando é uma retirada `OUT` de um material.
Esta aprovação funcional não autoriza migration adicional nem prova prontidão de segurança. A revisão
identificou que o schema atual de tentativas não oferece contadores independentes adequados para o
rate limit QR público e PIN; até solução aditiva autorizada e testes de concorrência/HTTP, retirada
sem sessão permanece não liberável até aplicação autorizada da migration e aprovação das regressões
HTTP/PostgreSQL.

1. Fechar gates de negócio e verificar ambiente PostgreSQL de teste isolado; inventariar schema e
   dados sem gravar neles.
2. Desenhar e revisar migrations aditivas para setores, autorização, almoxarifado, catálogo,
   unidade, saldo, evento, idempotência, PIN/auditoria e constraints/índices.
3. Registrar Models e associações no inicializador central `src/database/index.js`; adicionar
   repositories com opções de transação e testes de constraints.
4. Implementar autorização de setores e cadastro (incluindo inativação e mídia) antes das
   mutações de estoque.
5. Implementar PIN individual e auditoria; identificar o autorizador primeiro, proteger
   tentativas/bloqueio e impedir busca de titular por comparação do PIN entre contas.
6. Implementar `StockMovementService` transacional, tipos e referências, idempotência com chave de
   escopo aprovado e ID estável da intenção, além do lock de
   saldo; primeiro testes unitários, depois integração concorrente em PostgreSQL real.
6. Expor contratos HTTP e fluxo QR; cobrir sessão/CSRF nas rotas administrativas e rota de retirada
   PIN sem sessão, sem preencher `performedBy` artificial. A rota pública de retirada só é elegível
   após controles persistentes independentes e validação concorrente em PostgreSQL.
8. Implementar `StockReportService`, reconciliação e paginação determinística; definir fuso/limites
   operacionais antes de liberar API, sem bloquear tasks das consultas internas.
9. Executar teste de migration up/down apenas em DB descartável; regressão unitária e integração;
   revisar rollback operacional e política de retenção antes de deploy.

## Known Risks

- Inicializador central importa Models explicitamente; omitir registro de um Model quebra runtime.
- Sequelize/PostgreSQL pode devolver `NUMERIC` como string; não converter saldo para `Number`.
- Migrations atuais são históricas e contêm cascades no legado; novas tabelas precisam política
  própria de `RESTRICT`/`SET NULL` consistente com histórico imutável.
- Rate limiting atual de autenticação é em memória e por IP/rota, não basta por si só para limite
  por titular de PIN em múltiplas instâncias; backend de armazenamento/bloqueio precisa decisão
  técnica compatível com infraestrutura existente e política operacional.
- Reutilizar MinIO/Multer atuais. MinIO usa `memoryStorage`, limite corrente 10 MiB e MIME baseado
  na configuração do cliente; não há validação de assinatura nem limpeza de órfãos. Feature aplica
  G5 (5 MB, conteúdo validado e ciclo seguro de dois buckets); validar buckets/credenciais/permissões
  operacionalmente antes de liberar upload, sem reabrir decisões funcionais.
- A tabela legado `stock_movements` pertence a `Product`; não reutilizar nem renomear.

## Readiness for /speckit.tasks

**Pronto para `/speckit.tasks`, com gates por capacidade.** Pendências de negócio devem ser tarefas
de decisão/aceite e bloquear somente abertura, onboarding de PIN, retenção/anonimização, exibição
de dado distintivo e liberação de mídia/relatórios conforme aplicável. Não impedem decompor schema,
catálogo, movimentos comuns, transações, concorrência, idempotência ou testes. Precisão, PostgreSQL
17 e escopo idempotente estão fechados. Não executei `/speckit.tasks` nesta revisão.

## Complexity Tracking

Não há violação constitucional nem nova infraestrutura. Não se aplica.