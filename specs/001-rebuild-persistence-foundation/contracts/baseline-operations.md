# Contrato Operacional Interno: Baseline de Persistência

## Propósito e compatibilidade

Definir comportamento verificável das operações internas de banco da fundação. Não é contrato HTTP
e não cria endpoints ou entidades de domínio. É compatível com `sequelize-cli` 6.6.5: o CLI aceita
`migrationStorage: 'sequelize'`, `migrationStorageTableName` e `migrationStorageTableSchema`,
entrega tabela/schema ao Umzug e, em PostgreSQL, pode criar schema customizado após autenticar.
Por isso, o preflight externo é obrigatório antes do CLI.

## Perfis de operação

| Perfil | Finalidade | Operações permitidas |
| --- | --- | --- |
| `development-rebuild` | Aplicar baseline em banco isolado vazio ou observar banco isolado já inicializado. | `apply`: preflight da instância/banco e baseline somente com T012 comprovando vazio. `status`: observação autenticada/read-only independente para banco inicializado. Ambos exigem registros reais T006 validados; nenhum recria banco existente. |
| `test` | Validar fundação contra PostgreSQL isolado. | Fixtures, preflight, migrations, testes, recovery simulado e limpeza. Fixtures não autorizam operações reais de `development-rebuild`. |
| `inventory-readonly` | Inspecionar legado/original. | Leitura de schema, metadata e evidências; nenhuma ação destrutiva. |
| `data-preservation` | Fluxo futuro opcional. | Somente após inventário, backup, reconciliação, aprovação e rollback. |

## Entrada lógica obrigatória

| Campo | Regra |
| --- | --- |
| Perfil e ambiente | Explícitos e reconhecidos. Operação destrutiva aceita somente ambiente explicitamente de desenvolvimento; `NODE_ENV=development` isoladamente não autoriza. |
| Allowlist de destinos autorizados | Configuração não versionada com identidades completas de destino: ambiente, host, porta, database e perfil/identificação lógica. A identidade efetiva deve corresponder integralmente a exatamente uma entrada. |
| Denylist de identidades protegidas | Configuração não versionada com identidades completas, incluindo o banco original. Qualquer coincidência bloqueia, mesmo em desenvolvimento. |
| Identidade da instância | Host, porta, perfil e referência esperada da instância isolada; obrigatória antes de conectar a banco administrativo ou criar banco. |
| Identidade do destino | Host, porta, database e perfil/expectativa de isolamento completos, comparados com allowlist, denylist e conexão efetiva. |
| Configuração do executor | Exclusiva do baseline; não depende implicitamente de `.sequelizerc` legado. |
| Caminho de migrations | Absoluto normalizado, existente e exatamente igual ao diretório canônico do executor. |
| Conjunto de migrations | Baseline canônico; fixture legada somente em teste de isolamento do legado. |
| Storage baseline | `migrationStorage: 'sequelize'` e `migrationStorageTableName: 'SequelizeMetaBaseline'`. |
| Schema de metadata | `migrationStorageTableSchema: 'baseline_meta'` explícito; a única relação válida é `baseline_meta.SequelizeMetaBaseline`, nunca inferida do `search_path`. |

Nenhuma entrada, saída, log ou diagnóstico expõe segredo/credencial.

Enquanto a allowlist e a denylist reais não tiverem sido fornecidas e validadas pelo responsável,
operações reais de bootstrap, `apply` e `status` retornam `blocked`. Fixtures isoladas do perfil
`test` podem ser usadas somente para validar o mecanismo fail-closed.

## Modos do único orquestrador T030

### `apply` — aplicação controlada em banco vazio

`apply` preserva integralmente T012. Antes de CLI, bootstrap técnico, criação de metadata ou DDL,
deve receber preflight T012 `validated` que comprove: identidade efetiva autenticada e autorizada;
destino isolado aprovado e não protegido; database existente; e database comprovadamente vazio. Em
seguida, pode executar exclusivamente a composição controlada CLI → validação pós-CLI da metadata →
diagnóstico T029. O resultado de sucesso é `rebuild-complete`.

Banco não vazio, prova ausente, identidade ambígua/divergente, caminho não canônico, metadata
inesperada ou adaptador ausente bloqueiam `apply`. `apply` nunca infere que um banco é atual, não faz
`DROP`, recriação, limpeza ou recovery automático e não usa um resultado anterior de `status` como
substituto para T012.

### `status` — observação autenticada de banco inicializado

`status` não executa CLI, bootstrap, SQL de escrita, DDL, migrations, cleanup ou recovery. Ele exige
um adaptador operacional autenticado e estritamente read-only, responsável por coletar e devolver
evidência observada — nunca por decidir autorização de escrita. O orquestrador valida novamente a
identidade efetiva contra allowlist/denylist T006 e aceita apenas destino isolado aprovado.

`current_database()` e demais dados da sessão PostgreSQL comprovam apenas a sessão autenticada e o
database selecionado; não comprovam sozinhos host/porta físicos, container ou instância. O adaptador
deve portanto exigir uma prova operacional do endpoint conectado, além da identidade observada pelo
PostgreSQL. No profile local isolado `test`, a prova aprovada é: inspeção Docker read-only, coletada
no host confiável exclusivamente para `postgres-alves-glass-test`, com container, serviço Compose,
rede, IDs de rede/endpoint e IP; runner efêmero na rede de teste; e correlação exata do IP/porta da
sessão autenticada com o endpoint inspecionado. O runner não recebe Docker socket e conecta somente a
`postgres-test:5432`; `localhost:5434` não é fallback. Um atestado Ed25519 externo, assinado e com
proveniência/fingerprint verificáveis, continua alternativa para ambientes que o exigirem. Se a prova
aplicável ou os privilégios necessários não estiverem disponíveis, `status` retorna `blocked`; não
pode inferir identidade física por nome de database, `search_path` ou configuração declarativa.

Para `already-current`, a evidência mínima e cumulativa é: (1) identidade efetiva completa,
autenticada, autorizada e não protegida; (2) caminho canônico e conjunto completo de migrations
canônicas; (3) `baseline_meta.SequelizeMetaBaseline` existente e resolvida por nome qualificado, sem
`search_path`, com schema, tabela, coluna `name` e constraint esperados; (4) histórico observado
exatamente igual ao conjunto canônico; e (5) schema consistente para cada migration. Inconsistência
comprovada retorna `recovery-required`; qualquer ausência, ambiguidade, erro de observação,
contradição não conclusiva ou lacuna retorna `blocked`.

O resultado de `status`, inclusive `already-current`, é informativo e não concede capacidade,
autorização, recibo nem promoção para `apply`. Toda chamada futura de `apply` reinicia seus próprios
gates, inclusive T012.

## Bootstrap seguro e ordem obrigatória de execução

1. Carregar e validar configuração sem iniciar recursos de trabalho.
2. **Preflight fail-closed da instância:** validar ambiente de desenvolvimento explícito, todos os
   campos obrigatórios, allowlist de destinos autorizados, denylist de identidades protegidas,
   host/porta/perfil e prova de que a identidade efetiva corresponde integralmente a exatamente um
   destino autorizado e a nenhum protegido. Ausência, ambiguidade, divergência ou coincidência com
   o original retorna `blocked` antes de conexão administrativa ou `CREATE DATABASE`.
3. **Criação protegida do banco:** somente se o banco isolado declarado estiver ausente e a etapa 2
   tiver passado. Cria exclusivamente esse banco; não executa `DROP DATABASE`, não substitui banco
   existente e não seleciona instância original automaticamente.
4. **Preflight da identidade efetiva do banco:** validar host, porta, database, ambiente e perfil
   lógico do banco criado/existente contra allowlist, denylist e conexão efetiva. Coincidência,
   ausência, ambiguidade ou divergência retorna `blocked`; nome do banco ou `NODE_ENV` não bastam.
5. Resolver e comparar caminho de migrations com caminho canônico; erro retorna `blocked`.
6. Validar previamente a configuração exclusiva do baseline: storage `sequelize`, caminho próprio,
   `migrationStorageTableName: 'SequelizeMetaBaseline'` e
   `migrationStorageTableSchema: 'baseline_meta'`. Se `baseline_meta` já existir, inspecionar sua
   estrutura e objetos antes de uso; divergência retorna `blocked`, sem remover, recriar ou
   sobrescrever schema/tabela.
7. Somente após 1–6, invocar Sequelize CLI/Umzug com `--config`, `--env` e `--migrations-path`
   exclusivos. Esta regra antecede autenticação do CLI, criação de `baseline_meta`, tabela de
   metadata e DDL de migrations. Se ausente, `baseline_meta` pode ser criado somente nesta etapa.
8. Após CLI controlado, validar exclusivamente `baseline_meta.SequelizeMetaBaseline`, inclusive
   `name` não nulo/PK/única; relação homônima em `public` ou outro schema não vale como metadata.
   Divergência interrompe a operação com diagnóstico, sem correção automática.
9. Validar migrations e schema antes de reportar sucesso.

## Resultados lógicos

| Resultado | Condição e garantia |
| --- | --- |
| `instance-validated` | Instância isolada foi aprovada para possível criação de banco; não significa que banco, schema ou DDL foram criados. |
| `database-created` | Banco isolado ausente foi criado após `instance-validated`; não significa que baseline foi aplicado. |
| `validated` | Identidade do banco, original protegido e caminho canônico foram aprovados; não significa DDL executado. |
| `rebuild-complete` | Baseline foi aplicado a banco isolado vazio e metadata/schema foram validados; não implica drop ou recriação de banco existente. |
| `already-current` | Somente `status` com observação autenticada completa prova que banco isolado já inicializado tem identidade autorizada, metadata/histórico canônicos e schema consistente; nenhuma alteração de schema ocorreu. |
| `migration-already-recorded` | Pedido de reaplicar migration em metadata consistente; schema não é alterado. |
| `metadata-isolated` | Executor usou somente caminho/metadata próprios; outro executor não foi lido ou alterado. |
| `blocked` | Falha de ambiente, identidade, isolamento, original, configuração ou caminho; em preflight, CLI/DDL não iniciou. |
| `recovery-required` | Migration parcial ou divergência; não marcar, repetir ou compensar automaticamente. |

## Regras de segurança, metadata e recovery

1. O banco original nunca é selecionado automaticamente. Coincidência com inventário bloqueia,
   inclusive com `NODE_ENV=development`.
2. Bootstrap não pode atingir a instância original: host/porta/perfil ambíguos ou equivalentes ao
   original bloqueiam antes de conexão administrativa e antes de `CREATE DATABASE`. A criação só é
   permitida para banco isolado declarado e ausente; banco existente não é apagado nem recriado.
3. Caminho ausente, inexistente, legado, de fixture inadequada ou diferente do canônico retorna
   `blocked` antes do CLI. O teste comprova ausência de schema técnico, metadata e DDL.
4. Baseline MUST usar `SequelizeMetaBaseline` e caminho exclusivo; MUST NOT ler, gravar ou inferir
   estado de `SequelizeMeta` ou diretório legado.
5. Executor legado MUST usar somente tabela/caminho legado ou fixture; MUST NOT ler, gravar ou
   inferir estado de `SequelizeMetaBaseline` ou diretório baseline.
6. A configuração de metadata é validada antes do CLI e fixa `baseline_meta`; sua criação ocorre
   somente após todos os preflights. Se `baseline_meta` já existir, schema e objetos devem ser
   inspecionados antes de uso; não remover, recriar ou sobrescrever objetos existentes. Depois do
   CLI, vale exclusivamente `baseline_meta.SequelizeMetaBaseline`, com `name` não nulo/PK/única.
   `public.SequelizeMeta` é legado independente; nunca aceitar fallback a outro schema.
7. Aplicação em banco vazio e observação de banco inicializado são fluxos separados: `apply` usa
   exclusivamente T012; `status` exige observação autenticada/read-only e nunca executa CLI/DDL.
   `already-current` nunca autoriza apagar/recriar banco ou estruturas, nem promove `status` para
   `apply`.
8. Recriação destrutiva de banco existente, se vier a ser aprovada, exige solicitação explícita,
   preflight próprio de instância e banco, confirmação de identidade e testes específicos; não é
   executada pelo fluxo de baseline desta feature.
9. Recovery exige comparação documentada entre schema e metadata, diagnóstico preservado e ação
   segura explicitamente aprovada.

## Matriz mínima de validação com PostgreSQL real

| Cenário | Preparação | Evidência esperada |
| --- | --- | --- |
| Preflight da instância | Ambiente desenvolvimento, allowlist/denylist completas e identidade efetiva autorizada | `instance-validated`; executor administrativo ainda não criou banco. |
| Instância insegura | Ambiente não desenvolvimento, registro ausente, host/porta original, ambíguos, perfil inválido ou divergência efetiva | `blocked` antes de conexão administrativa e `CREATE DATABASE`. |
| Criar banco ausente | Instância validada e nome isolado ausente | `database-created`; somente o banco declarado é criado. |
| Banco existente vazio (`apply`) | Banco isolado declarado existe, identidade autorizada e T012 prova vazio | `validated` → CLI controlado → `rebuild-complete`; não há drop/recriação. |
| Banco existente íntegro (`status`) | Adaptador autenticado/read-only fornece evidência completa de identidade, metadata canônica, histórico e schema | `already-current`; sem CLI, bootstrap, DDL ou migrations. |
| Banco existente não vazio sem prova completa | Banco isolado declarado existe, mas não há evidência observacional completa | `blocked`; não inferir `already-current` e não executar `apply`. |
| Aplicação em banco vazio | Banco isolado vazio e preflight aprovado | `validated` → `rebuild-complete`; metadata/schema validados. |
| Status de banco íntegro | Adaptador autenticado/read-only prova integralmente identidade, metadata/histórico canônicos e schema consistente | `already-current`; nenhuma linha/CLI/DDL nova. |
| Reaplicação registrada | Nome em metadata consistente | `migration-already-recorded`; schema inalterado. |
| Aplicação parcial | Fixture interrompe após mudança controlada | `recovery-required`; nome não é marcado nem reaplicado. |
| Observação parcial/divergente | Metadata, histórico ou schema observados são inconsistentes de forma comprovada | `recovery-required`; sem correção automática. |
| Observação ambígua/insuficiente | Identidade, autorização, catálogo, histórico ou schema não é comprovado integralmente | `blocked`; sem CLI, DDL, migration ou bootstrap. |
| Baseline → legado | `SequelizeMeta` tem fixture legada | Baseline só usa `SequelizeMetaBaseline`; legado/caminho legado inalterados. |
| Legado → baseline | `SequelizeMetaBaseline` tem fixture baseline | Legado só usa `SequelizeMeta`; baseline/caminho baseline inalterados. |
| Caminho inválido | Ausente, legado ou não canônico | `blocked` antes do CLI; sem schema técnico, metadata ou DDL. |
| Identidade insegura | Original, ambígua ou perfil inválido | `blocked` antes de ação destrutiva; schema/dados preservados. |
| Schema de metadata | `migrationStorageTableSchema: 'baseline_meta'` explícito | Após CLI, somente `baseline_meta.SequelizeMetaBaseline` existe/é usada e tem estrutura esperada; `public.SequelizeMeta` legado permanece intacto. |
| T006 pendente de registros reais | Allowlist/denylist operacionais ainda não fornecidas | Bootstrap, `apply` e `status` reais retornam `blocked`; somente fixtures `test` isoladas podem validar o mecanismo. |