# Quickstart: Validar a Fundação de Persistência

## Objetivo e garantia de segurança

Este guia reproduz, após a implementação, PostgreSQL isolado para desenvolvimento e teste. Os
exemplos não inferem, leem ou selecionam o banco original. O preflight deve concluir `validated`
antes do Sequelize CLI; nenhuma migration deve ser executada diretamente contra destino não validado.

> **Estado atual:** este planejamento não criou script, configuração de baseline, migration ou teste
> executável. Os comandos abaixo são contrato para a implementação; não os improvise contra legado.

Consulte [data-model.md](./data-model.md), [research.md](./research.md) e
[contracts/baseline-operations.md](./contracts/baseline-operations.md).

## 1. Pré-requisitos

1. Node.js 22, Yarn Classic e dependências instaladas com `yarn install --frozen-lockfile`.
2. Docker/Docker Compose ou PostgreSQL local capaz de criar bancos isolados.
3. Configuração não versionada para `development-rebuild`, `test` e `inventory-readonly`.
4. Configuração não versionada com allowlist de destinos autorizados e denylist de identidades
   protegidas, incluindo o banco original; cada registro usa ao menos ambiente, host, porta,
   database e perfil/identificação lógica.
5. Nenhuma decisão de domínio é necessária; este guia não cria clientes, usuários, orçamentos, OS,
   estoque ou Outbox.

O lockfile oficial é `yarn.lock`. Não use `npm install`, não gere `package-lock.json` e não
introduza segundo lockfile durante esta feature.

> **Bloqueio operacional de T006:** o mecanismo fail-closed está aprovado, mas bootstrap e rebuild
> reais permanecem bloqueados até o responsável fornecer e validar os registros reais da allowlist e
> da denylist. Testes automatizados podem usar somente fixtures isoladas no perfil `test`; elas não
> preenchem nem substituem os registros reais de operação.

## 2. Preflight e bootstrap seguro da instância PostgreSQL

Use uma instância exclusiva de desenvolvimento, com porta e volume próprios. O exemplo abaixo é
uma instrução de preparação manual do ambiente local; a implementação deverá encapsular bootstrap
em wrapper protegido e não pode apontar para instância original.

```bash
docker run --rm --name alves-glass-baseline-postgres \
  -e POSTGRES_USER=baseline_dev \
  -e POSTGRES_PASSWORD=<valor-local-nao-versionado> \
  -e POSTGRES_DB=postgres \
  -p 55432:5432 \
  -v alves_glass_baseline_pgdata:/var/lib/postgresql/data \
  postgres:17
```

O uso de `POSTGRES_DB=postgres` inicializa somente o banco administrativo da instância isolada; não
cria o banco de aplicação. A porta `55432` e o volume `alves_glass_baseline_pgdata` permanecem
separados do ambiente legado.

Depois de a instância isolada estar disponível, a implementação deve executar **preflight
fail-closed da instância** antes de qualquer criação de banco: exigir ambiente explicitamente de
desenvolvimento, todos os campos, allowlist/denylist e correspondência integral da identidade efetiva
com exatamente um destino autorizado e nenhum protegido. `NODE_ENV=development` ou nome do banco
isoladamente não autorizam. Falha retorna `blocked` sem conexão administrativa e sem
`CREATE DATABASE`.

## 3. Criar banco isolado de forma protegida

Após `instance-validated`, a **interface do wrapper protegido de bootstrap** — cujo nome final de
script/comando permanece decisão de implementação — poderá receber o perfil e o destino pretendido.
Ela deve validar a identidade da instância, allowlist/denylist e autorização do destino; verificar
que o banco está ausente; e criar exclusivamente o banco autorizado. Não deve usar `DROP DATABASE`,
substituir, recriar banco existente ou inferir destino. Até os registros reais de T006 serem
fornecidos e validados, essa interface deve retornar `blocked` para operações reais.

Se o banco autorizado já existir, o bootstrap não o recria: ele segue para o preflight do banco e
somente permite aplicação inicial do baseline se o estado vazio for comprovado.

## 4. Executar preflight da identidade do banco

Depois de `database-created` — ou para banco isolado previamente criado — validar a identidade
efetiva de host, porta, database, ambiente e perfil contra a allowlist e a denylist; validar também
o caminho canônico e a configuração explícita do baseline. Falha retorna `blocked` antes do
Sequelize CLI, antes de criação de `baseline_meta` e antes de DDL.

## 5. Configurar perfis não versionados


Forneça valores por mecanismo local não versionado. Nunca registre senha em log, commit ou relatório.

| Perfil | Ambiente | Destino permitido | Metadata |
| --- | --- | --- | --- |
| `development-rebuild` | desenvolvimento explícito | entrada correspondente na allowlist; nunca uma identidade protegida | `baseline_meta.SequelizeMetaBaseline` |
| `test` | teste | entrada correspondente na allowlist de teste; nunca uma identidade protegida | `baseline_meta.SequelizeMetaBaseline` |
| `inventory-readonly` | somente leitura | identidade inventariada do original | sem operação destrutiva |

O perfil baseline declara `migrationStorage: 'sequelize'`,
`migrationStorageTableName: 'SequelizeMetaBaseline'`,
`migrationStorageTableSchema: 'baseline_meta'`, arquivo `--config` exclusivo e diretório canônico.
Não dependa de `.sequelizerc` legado ou de `search_path`.

## 6. Validar preflight antes de migrations

Após a implementação, execute primeiro o wrapper previsto:

```bash
yarn db:baseline:validate --profile development-rebuild
```

**Resultado esperado:** `validated`, sem segredos. O wrapper retorna `blocked` para ambiente não
explicitamente de desenvolvimento, allowlist/denylist ausentes, identidade incompleta/ambígua,
divergência entre configuração e conexão efetiva, destino protegido ou caminho inexistente, legado
ou não canônico. No bloqueio, não chama CLI, não cria `baseline_meta`/metadata e não altera dados.

## 7. Aplicar baseline em banco isolado vazio

Somente após preflight aprovado e registros reais de T006 validados, execute o wrapper de rebuild a
ser implementado. Por contrato, ele repassa `--config`, `--env` e `--migrations-path` exclusivos ao
Sequelize CLI 6.6.5:

```bash
yarn db:baseline:rebuild --profile development-rebuild
```

**Resultado esperado:** `rebuild-complete`. Isso aplica o baseline a banco isolado comprovadamente
vazio; não remove, não recria e não limpa banco existente. Uma operação que deseje apagar ou
recriar estruturas exige fluxo destrutivo separado, solicitação explícita, preflight próprio de
instância/banco e confirmação de identidade; não é autorizada por este comando ou por reexecução.

### Criar e verificar metadata de forma protegida

O fluxo de `baseline_meta` é obrigatório e ordenado:

1. concluir os preflights da instância e do banco;
2. inspecionar `baseline_meta` se ele já existir;
3. se estiver ausente, permitir sua criação somente pelo mecanismo protegido do baseline/CLI
   controlado;
4. se existir, validar seus objetos e compatibilidade antes do uso;
5. nunca remover, recriar ou sobrescrever schema, tabela ou objetos existentes;
6. executar o CLI com configuração explícita e caminho canônico, sem `.sequelizerc` legado;
7. validar `baseline_meta.SequelizeMetaBaseline` somente após o CLI.

Não dependa de `search_path`, criação implícita fora do mecanismo protegido ou fallback.

Após a execução controlada do CLI, consulte exclusivamente a relação qualificada:

```bash
psql \
  -h 127.0.0.1 -p 55432 -U baseline_dev -d alves_glass_baseline_dev \
  -c '\d+ baseline_meta."SequelizeMetaBaseline"'
```

Antes do CLI, validar `migrationStorageTableSchema: 'baseline_meta'`; se `baseline_meta` já existir,
inspecionar sua estrutura e objetos e bloquear divergência sem remover, recriar ou sobrescrever.
Depois do CLI, confirmar schema/tabela no local exato, coluna `name` não nula e PK/unique. Não
aceitar tabela homônima em outro schema nem fallback via `search_path`. `public.SequelizeMeta` é
histórico legado independente e não deve ser alterado.

## 8. Validar estados distintos de migration

1. **Criação protegida de banco ausente:** após `instance-validated`, cria somente o destino
   autorizado e ausente. Não aplica baseline, não executa `DROP` e não recria banco existente.
2. **Aplicação inicial:** em banco previamente autorizado e comprovadamente vazio, aplica baseline
   uma única vez. Resultado: `rebuild-complete` após validação pós-CLI da metadata.
3. **Reexecução:** execute status/aplicação não destrutiva no banco reconstruído. Resultado:
   `already-current`, sem migration pendente e sem DDL.
4. **Reaplicação registrada:** solicite, em wrapper de teste controlado, migration já presente em
   metadata consistente. Resultado: `migration-already-recorded`, schema inalterado.
5. **Aplicação parcial:** no banco `test`, use fixture que falhe/interrompa migration. Inspecione
   schema e metadata antes de ação corretiva. Resultado: `recovery-required`; não marcar nem
   repetir automaticamente.

`development-rebuild` somente aplica baseline em banco comprovadamente vazio e previamente
autorizado; não apaga nem recria bancos ou estruturas. Aplicação inicial, reexecução, migration já
registrada e recovery parcial são fluxos separados. Nenhum deles executa `DROP`, recriação ou
recuperação automática.

## 9. Executar validações automatizadas

Depois da implementação, a suíte roda no perfil `test` isolado:

```bash
yarn test
```

A suíte deverá provar:

- identidade efetiva validada contra allowlist/denylist antes de operação destrutiva;
- preflight da instância bloqueia ambiente inadequado, registros ausentes, host/porta/perfil original
  ou ambíguo e divergência efetiva antes de `CREATE DATABASE`;
- criação protegida cria somente banco isolado ausente e nunca faz drop/recriação automática;
- caminho de migrations incorreto bloqueado sem CLI/DDL;
- isolamento baseline → legado e legado → baseline entre `SequelizeMetaBaseline` e `SequelizeMeta`;
- criação/inspeção de `baseline_meta` somente após preflights e validação pós-CLI de
  `baseline_meta.SequelizeMetaBaseline`, sem `search_path`;
- rebuild limpo, reexecução idempotente, reaplicação registrada e recovery obrigatório;
- transação/rollback, configuração/lifecycle, ausência de segredos e limpeza entre testes.

## 10. Encerrar ambiente local

Interrompa o contêiner com `Ctrl+C` ou remova-o explicitamente. Remova o volume somente se desejar
descartar este ambiente isolado:

```bash
docker volume rm alves_glass_baseline_pgdata
```

O comando afeta somente o volume nomeado no exemplo; não use remoção genérica de volumes em ambiente
compartilhado.