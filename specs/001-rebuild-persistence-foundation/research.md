# Research: Fundação Técnica e Reconstrução da Persistência

## Decisão 1 — Baseline separado do histórico legado

**Decision**: Criar um baseline canônico em diretório e configuração próprios, preservando
`src/database/migrations/` como histórico. O executor do baseline usa apenas seu conjunto de
migrations e registro de metadados; uma pasta nova não prova equivalência a schema/histórico legado.

**Rationale**: `.sequelizerc` aponta hoje para `src/database/migrations/`. Um banco pode ter
histórico legado e schema divergente; FR-010 exige inventário e estratégia explícita.

**Alternatives considered**: editar migrations legadas (rejeitado: devem permanecer históricas);
executar uma nova pasta automaticamente contra qualquer banco (rejeitado: ignora histórico e
identidade); substituir Sequelize (rejeitado: fora do escopo).

## Decisão 2 — Bootstrap PostgreSQL em estágios protegidos

**Decision**: Separar o bootstrap em quatro etapas: (1) preflight fail-closed da instância
PostgreSQL; (2) criação protegida do banco isolado, somente se ausente; (3) preflight da identidade
efetiva completa do banco; e (4) execução do baseline. A etapa 1 exige ambiente de desenvolvimento
explícito, campos completos e comparação da identidade com allowlist de destinos autorizados e
denylist de identidades protegidas antes de conectar a banco administrativo ou emitir `CREATE
DATABASE`. A etapa 2 cria apenas o nome de banco isolado declarado, nunca faz `DROP DATABASE` nem
substitui banco existente. A etapa 3 valida host, porta, database, ambiente, perfil, conexão efetiva,
inventário do original e caminho canônico antes de invocar Sequelize CLI. Somente após esses estágios
pode haver autenticação do CLI, criação de schema ou tabela de metadados, ou DDL de migrations.

**Rationale**: `sequelize-cli` 6.6.5 autentica ao construir o migrator e, em PostgreSQL, chama
`createSchema` quando há `migrationStorageTableSchema` customizado. Validar depois seria tarde para
SC-007. `CREATE DATABASE` também altera uma instância; portanto não pode compartilhar o mesmo
preflight do banco-alvo que ainda não existe. Ausência, ambiguidade ou coincidência com a instância
ou banco original bloqueia antes de qualquer comando de bootstrap.

**Alternatives considered**: confiar só em `NODE_ENV=development`, no nome do banco ou em
confirmação interativa (todos rejeitados: não provam isolamento); deixar o CLI validar (rejeitado:
ele não conhece a identidade protegida e pode criar schema antes de uma validação externa).

**Testes obrigatórios**: fixtures de configuração devem provar que instância original, host/porta
ambíguos, perfil incompatível ou banco-alvo já existente bloqueiam bootstrap antes de `CREATE
DATABASE`; o spy/fake do executor administrativo não deve ser chamado. Em PostgreSQL isolado,
provar que a criação ocorre apenas para banco ausente no host/porta autorizados e que o fluxo de
baseline não emite `DROP DATABASE`, não recria banco existente nem toca instância original.

## Decisão 3 — Caminho de migrations é parte da identidade operacional

**Decision**: O preflight normaliza e resolve o caminho recebido e exige que ele exista e seja
exatamente o diretório canônico do executor. Para baseline, caminho legado, inexistente, de fixture
indevida ou fora do canônico retorna `blocked`; o CLI não é chamado.

**Rationale**: O CLI entrega o caminho resolvido ao Umzug. Tabela de metadata distinta não impede
descoberta de arquivos errados. O bloqueio antes do CLI evita migrations incorretas e criação
incidental de schema/metadados.

**Alternatives considered**: aceitar qualquer diretório existente, confiar no `.sequelizerc` atual
ou detectar erro após `db:migrate` (rejeitados: permitem caminho legado ou DDL/metadata precoce).

## Decisão 4 — Metadados exclusivos em `baseline_meta`
**Decision**: O baseline define explicitamente `migrationStorage: 'sequelize'`,
`migrationStorageTableName: 'SequelizeMetaBaseline'` e
`migrationStorageTableSchema: 'baseline_meta'`. A única relação de metadata válida para o baseline
é `baseline_meta.SequelizeMetaBaseline`; não há opção `public`, dependência de `search_path` ou
fallback implícito. O legado mantém caminho próprio e `public.SequelizeMeta`, sem leitura ou escrita
cruzada. O fluxo separa: (a) validação pré-CLI da configuração declarada; (b) após preflight do
banco, inspeção de `baseline_meta` se ele já existir, bloqueando objetos/estrutura divergentes sem
remoção, recriação ou sobrescrita; (c) criação do schema somente pelo CLI controlado, se ausente; e
(d) validação pós-CLI de `baseline_meta.SequelizeMetaBaseline`, com `name` não nulo/PK/única.

**Rationale**: No `sequelize-cli` 6.6.5, `umzug-helper.js` usa `sequelize`/`SequelizeMeta` como
padrões e encaminha `migrationStorageTableName` e `migrationStorageTableSchema` como `tableName` e
`schema`. `migrator.js` encaminha essas opções ao Umzug e cria schema PostgreSQL customizado após
autenticar. No Umzug 2.3.0, `SequelizeStorage` cria/sincroniza a tabela e registra cada nome como
chave primária única.

**Evidências locais**:

- `node_modules/sequelize-cli/package.json`: versão instalada 6.6.5.
- `node_modules/sequelize-cli/lib/helpers/umzug-helper.js:8-54`: defaults e opções de tabela/schema.
- `node_modules/sequelize-cli/lib/core/migrator.js:37-64`: caminho, autenticação e schema customizado.
- `node_modules/umzug/lib/storages/SequelizeStorage.js:35-150`: relação configurável e PK/unique.

**Alternatives considered**: compartilhar `SequelizeMeta`, separar somente tabela, separar somente
caminho, usar `public` ou criar storage customizado (rejeitados: não isolam integralmente, permitem
fallback implícito ou aumentam complexidade).

## Decisão 4A — Identidade operacional fail-closed

**Decision**: Operações destrutivas usam duas listas explícitas, fornecidas por configuração não
versionada: uma allowlist de destinos autorizados e uma denylist de identidades protegidas, que
inclui o banco original. Cada identidade contém, no mínimo, ambiente, host, porta, database e
perfil/identificação lógica. A operação só prossegue se o ambiente for explicitamente de
desenvolvimento, todos os campos estiverem presentes, a identidade efetiva da conexão corresponder
integralmente a exatamente um destino autorizado e não corresponder a nenhuma identidade protegida.
Ausência, ambiguidade, divergência entre configuração e conexão efetiva, ou coincidência com
identidade protegida retorna `blocked`. `NODE_ENV=development` e o nome do banco isoladamente nunca
são autorização.

**Rationale**: Host, porta ou nome de banco isolados não provam isolamento. A lista positiva impede
seleção implícita; a lista protegida bloqueia coincidência mesmo quando um valor local parece seguro.
O controle precisa ocorrer antes de conexão administrativa, `CREATE DATABASE`, criação de schema,
Sequelize CLI ou DDL.

**Informação pendente para materializar as listas**: a configuração versionada atual só referencia
`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` e `DB_DATABASE`; ela não contém registros de
destinos autorizados nem a identidade inventariada do original. O responsável deve fornecer, por
canal seguro e não versionado, os campos não sigilosos ambiente/host/porta/database/perfil de cada
destino autorizado e de cada identidade protegida, incluindo o original. Nenhum valor é inferido
neste documento. Até essa validação ocorrer, bootstrap e rebuild reais permanecem bloqueados;
fixtures isoladas do perfil `test` podem exercitar o mecanismo, mas não preenchem allowlist/denylist
operacionais nem autorizam destinos reais.

## Decisão 5 — Isolamento testado nos dois sentidos

**Decision**: Testes de integração em PostgreSQL isolado preparam fixtures controladas e provam:

1. Com `SequelizeMeta` legada preenchida, baseline usa apenas seu caminho e
   `SequelizeMetaBaseline`, sem ler/escrever tabela ou migrations legadas.
2. Com `SequelizeMetaBaseline` preenchida, executor legado de fixture usa somente seu caminho e
   `SequelizeMeta`, sem ler/escrever metadata ou migrations do baseline.
3. Em ambos os sentidos, `status`, execução e reexecução listam/escrevem somente o conjunto próprio.

**Rationale**: Isolamento é bidirecional; provar somente baseline → legado não protege o histórico
do baseline contra execução legada futura.

## Decisão 6 — Estados de migration não são sinônimos

**Decision**: Planejar e testar quatro resultados distintos:

| Estado | Pré-condição | Resultado seguro |
| --- | --- | --- |
| Aplicação em banco vazio | Banco isolado vazio, identidade e caminho aprovados | `rebuild-complete`; aplica baseline e valida schema/meta. |
| Status de banco inicializado íntegro | Observação autenticada completa prova identidade autorizada, metadata/histórico canônicos e schema consistente | `already-current`; não executa CLI, DDL ou migrations. |
| Reaplicação registrada | Migration consta em metadata consistente | `migration-already-recorded`; não altera schema. |
| Aplicação parcial/divergência | Schema e metadata não comprovam conclusão | `recovery-required`; não marca nem repete automaticamente. |
| Recriação destrutiva de banco existente | Solicitação explícita, preflight específico de instância/banco e confirmação de identidade | Fluxo separado; não é acionado por baseline nem por reexecução. |

**Rationale**: FR-011 e FR-012 proíbem confundir aplicação limpa, idempotência e recovery. Aplicar
baseline em banco vazio não é autorização para apagar/recriar banco existente. Recovery requer
inspeção do schema/histórico, diagnóstico e ação explícita aprovada; reexecução é não destrutiva.

**Alternatives considered**: repetir migration falha ou marcar conclusão para liberar pipeline
(rejeitados: podem duplicar DDL ou quebrar evidência entre schema e histórico).

## Decisão 7 — Status observacional separado do preflight de aplicação

**Decision**: Preservar T012 como preflight fail-closed exclusivo de `apply`: banco existente,
identidade efetiva autorizada e estado comprovadamente vazio antes de CLI, metadata técnica ou DDL.
Definir `status` como observação independente, autenticada e estritamente read-only de banco isolado
já inicializado. O adaptador de observação é responsabilidade da camada operacional/integrada, deve
provar a identidade efetiva autorizada e só pode retornar fatos observados de catálogo, metadata,
histórico e schema; ele não recebe capacidade de bootstrap, CLI, migration, DDL, cleanup ou recovery.

`already-current` exige prova completa: destino efetivo autorizado e não protegido; relação
qualificada `baseline_meta.SequelizeMetaBaseline` sem fallback por `search_path`; estrutura canônica
da metadata; conjunto completo/determinístico de migrations do caminho canônico; histórico observado
exatamente correspondente; e schema consistente para todas as migrations canônicas. Inconsistência
positiva e suficiente produz `recovery-required`. Ausência de identidade autenticada, destino fora
da allowlist, ambiguidade, falha de leitura ou qualquer lacuna/contradição de evidência produz
`blocked`.

**Rationale**: Um banco íntegro não satisfaz a condição de vazio de T012. Reutilizar T012 para
`status` enfraqueceria o gate de aplicação; aceitar evidência declarativa sem observação autenticada
permitiria classificar um banco desconhecido como atual. A separação mantém um único orquestrador
T030, mas impede que o resultado de leitura seja promoção implícita para escrita.

**Alternatives considered**: aceitar banco não vazio no T012 (rejeitado: altera seu significado e
libera CLI contra estado não vazio); executar CLI em `status` (rejeitado: pode autenticar/criar
metadata); usar sucesso de `status` como token para `apply` (rejeitado: observação não substitui o
preflight destrutivo atual).

**Testes obrigatórios**: em PostgreSQL isolado e explicitamente autorizado após T006, provar que o
adaptador autenticado observa sem mutação, que banco íntegro obtém `already-current`, que metadata,
histórico ou schema inconsistentes obtêm `recovery-required`, e que identidade ausente/ambígua,
destino não autorizado ou evidência incompleta obtêm `blocked`. Spies devem comprovar ausência de
CLI, bootstrap, DDL, migrations e cleanup em todas as execuções de `status`.

## Decisão 8 — Configuração, lifecycle e transações explícitos

**Decision**: Leitura/validação de ambiente fica separada da criação de conexões. Lifecycle valida
configuração, executa preflights aplicáveis, conecta recursos e só então expõe prontidão; falhas
encerram recursos iniciados. Use Cases iniciam transações e as passam explicitamente a Repositories;
Controllers não controlam transações nem acessam Models diretamente.

**Rationale**: Constituição e FR-001 a FR-005/FR-015 a FR-017 exigem limites claros, rollback e
diagnósticos sem segredos. Efeitos de importação e leitura dispersa de `process.env` dificultam
isolamento e testes.

## Decisão 9 — Testes com Node nativo e PostgreSQL real isolado

**Decision**: Usar `node:test`/`node:assert` no Node 22 e PostgreSQL real isolado, sem biblioteca
adicional. Cada cenário seleciona somente destino de teste validado; nunca o banco original.

**Rationale**: O runner nativo cobre o escopo; mocks não provam DDL, catálogo, constraints e
transações PostgreSQL. Validação Model–migration ocorre somente para estruturas futuras aprovadas
que tenham Model correspondente; não cria domínio artificial.

## Decisões pendentes para implementação

1. **Registros concretos de identidade:** fornecer por configuração não versionada a allowlist de
   destinos autorizados e a denylist de identidades protegidas, incluindo o original, nos campos
   ambiente/host/porta/database/perfil. O mecanismo fail-closed e `baseline_meta` estão aprovados;
   os valores reais não são inferidos.
2. **Adaptador de observação de status:** aprovar responsável, credencial/autenticação operacional e
   contrato read-only para observar identidade efetiva, catálogo qualificado, histórico e schema de
   destinos isolados. Sem prova real T006 e sem esse adaptador, `status` operacional permanece
   `blocked`; o adaptador não pode conceder capacidade de `apply`.
3. **Estruturas de infraestrutura:** somente poderão entrar em migration futura se estritamente
   necessárias, justificadas e aprovadas; esta feature não cria tabela ou Model de domínio.