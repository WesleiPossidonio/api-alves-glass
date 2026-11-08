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
| `development-rebuild` | Aplicar baseline em banco isolado vazio. | Preflight da instância/banco, criação protegida somente se ausente, baseline/status e verificação. Exige registros reais T006 validados; não recria banco existente. |
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
operações reais de bootstrap e rebuild retornam `blocked`. Fixtures isoladas do perfil `test` podem
ser usadas somente para validar o mecanismo fail-closed.

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
| `already-current` | Banco já reconstruído não tem pendências; nenhuma alteração de schema ocorreu. |
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
7. Aplicação em banco vazio, reexecução, reaplicação registrada, recovery parcial e recriação
   destrutiva de banco existente são fluxos separados. Reexecução nunca autoriza apagar/recriar
   banco ou estruturas.
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
| Banco existente | Banco isolado declarado já existe | Não há drop/recriação automática; fluxo baseline segue apenas se estado vazio for comprovado, senão bloqueia/encaminha fluxo explícito. |
| Aplicação em banco vazio | Banco isolado vazio e preflight aprovado | `validated` → `rebuild-complete`; metadata/schema validados. |
| Reexecução | Banco baseline íntegro e atual | `already-current`; nenhuma linha/DDL nova. |
| Reaplicação registrada | Nome em metadata consistente | `migration-already-recorded`; schema inalterado. |
| Aplicação parcial | Fixture interrompe após mudança controlada | `recovery-required`; nome não é marcado nem reaplicado. |
| Baseline → legado | `SequelizeMeta` tem fixture legada | Baseline só usa `SequelizeMetaBaseline`; legado/caminho legado inalterados. |
| Legado → baseline | `SequelizeMetaBaseline` tem fixture baseline | Legado só usa `SequelizeMeta`; baseline/caminho baseline inalterados. |
| Caminho inválido | Ausente, legado ou não canônico | `blocked` antes do CLI; sem schema técnico, metadata ou DDL. |
| Identidade insegura | Original, ambígua ou perfil inválido | `blocked` antes de ação destrutiva; schema/dados preservados. |
| Schema de metadata | `migrationStorageTableSchema: 'baseline_meta'` explícito | Após CLI, somente `baseline_meta.SequelizeMetaBaseline` existe/é usada e tem estrutura esperada; `public.SequelizeMeta` legado permanece intacto. |
| T006 pendente de registros reais | Allowlist/denylist operacionais ainda não fornecidas | Bootstrap/rebuild reais retornam `blocked`; somente fixtures `test` isoladas podem validar o mecanismo. |