# Implementation Plan: Fundação Técnica e Reconstrução da Persistência

**Branch**: `001-rebuild-persistence-foundation` | **Date**: 2026-11-07 |
**Spec**: [spec.md](./spec.md)

**Input**: Feature specification from
`/specs/001-rebuild-persistence-foundation/spec.md`

## Summary

Reconstruir a fundação de persistência da Alves Glass API por meio de um baseline PostgreSQL novo,
versionado e operacionalmente isolado do histórico legado. A implementação centralizará a
configuração, validará a identidade completa do banco antes de qualquer ação destrutiva, separará
o executor e os metadados do baseline dos metadados legados e estabelecerá os contratos de camada,
transação, lifecycle, erro e testes verificáveis contra PostgreSQL real.

O fluxo padrão é o rebuild limpo de um banco isolado de desenvolvimento. Ele não seleciona,
conecta para destruir, altera, carrega nem migra dados do banco original. Preservação de dados é um
fluxo futuro opcional, condicionado a inventário, backup recuperável, reconciliação, aprovação
explícita e rollback. O baseline permanece mínimo: não cria tabelas ou Models de clientes,
usuários, orçamentos, OS, estoque, Outbox ou outro domínio.

## Technical Context

**Language/Version**: Node.js 22.23.1; JavaScript ES Modules para a aplicação existente. O
Sequelize CLI permanece CommonJS conforme sua própria interface.

**Primary Dependencies**: Express 5.1, Sequelize 6.37.8, `sequelize-cli` 6.6.5, Umzug 2.3.0,
`pg` 8.22 e dotenv 17.2. O gerenciador oficial é Yarn Classic (lockfile versionado `yarn.lock`);
esta feature não introduz nem atualiza outro lockfile.

**Storage**: PostgreSQL real em destinos isolados. O baseline usará storage `sequelize` do
Sequelize CLI com `migrationStorageTableName: 'SequelizeMetaBaseline'` e
`migrationStorageTableSchema: 'baseline_meta'`; sua identificação completa é
`baseline_meta.SequelizeMetaBaseline`. O executor legado mantém seu histórico independente em
`public.SequelizeMeta`. O executor do baseline usa configuração e caminho próprios, sem depender de
`.sequelizerc` ou `search_path`; após a execução controlada do CLI, o fluxo valida a estrutura da
tabela qualificada antes de reportar sucesso.

**Testing**: `node:test`/`node:assert` para testes unitários e integração contra PostgreSQL real
isolado. As verificações operacionais chamam somente fixtures e bancos de teste/desenvolvimento
protegidos.

**Target Platform**: Linux e Docker em desenvolvimento; serviço Node.js local ou conteinerizado.

**Project Type**: Serviço web backend único, com infraestrutura interna de persistência e scripts
operacionais.

**Performance Goals**: Dez rebuilds limpos consecutivos devem concluir sem intervenção manual e
sem resíduo da execução anterior. Toda configuração, identidade ou caminho inválido deve falhar
antes de comando que altere schema ou dados.

**Constraints**: PostgreSQL é a fonte oficial; Sequelize continua ORM e mecanismo de migrations;
o baseline deve passar `--config` e `--migrations-path` explícitos após preflights aprovados; o
preflight da instância deve anteceder criação de banco; o preflight da identidade do banco deve
anteceder CLI, criação de `baseline_meta` ou DDL; aplicar baseline em banco vazio não remove nem
recria banco existente. Operação destrutiva usa autorização fail-closed: ambiente de desenvolvimento
explícito, campos completos, identidade efetiva igual a um destino autorizado e diferente de toda
identidade protegida, sem ambiguidade ou divergência. `NODE_ENV=development` ou nome de banco
isoladamente não autorizam operação. Não usar o banco legado como destino; não introduzir MongoDB,
Redis, Kafka, CQRS, microsserviços ou TypeScript.

**T006 operational status**: O mecanismo fail-closed está aprovado, mas bootstrap e rebuild reais
permanecem bloqueados até o responsável fornecer e validar, fora do repositório, os registros reais
não sigilosos da allowlist e da denylist. Testes automatizados podem usar fixtures isoladas do perfil
`test`; elas não autorizam nem substituem registros de destinos operacionais reais.

**Scale/Scope**: Fundação técnica sem persistência de domínio. Abrange configuração, perfil de
destino protegido, baseline, metadados de migration, fronteiras de camadas, transações, lifecycle,
tratamento de erros, testes e documentação operacional.

## Design and Requirement Coverage

| Área do desenho | Cobertura da especificação | Resultado planejado |
| --- | --- | --- |
| Fronteiras de camada e transação | FR-001 a FR-005 | Routes compõem middleware; Controllers tratam HTTP; Use Cases delimitam transações e passam o mesmo contexto a Repositories; erros de persistência são normalizados sem segredos. |
| Baseline mínimo e compatibilidade | FR-006 a FR-008 | Diretório/configuração exclusivos, migrations ordenadas e validação no PostgreSQL somente para estruturas efetivamente incluídas; nenhuma tabela ou Model de domínio é antecipado. |
| Destino protegido e legado | FR-009, FR-010, FR-013 e FR-014 | Allowlist explícita de destinos e denylist de identidades protegidas são comparadas com a identidade efetiva da conexão; ausência, divergência ou ambiguidade bloqueia; preservação continua fora do fluxo padrão. |
| Estados de migration | FR-011, FR-012 e NFR-001/NFR-003 | Rebuild limpo, reexecução, reaplicação registrada e recuperação de aplicação parcial possuem pré-condições, resultados e testes distintos. |
| Configuração, lifecycle e sigilo | FR-015 a FR-017, FR-016 e NFR-002 | Configuração é validada antes da prontidão; inicialização/encerramento são explícitos; diagnósticos não exibem credenciais. |
| Qualidade | FR-018, FR-019, SC-001 a SC-005 | Runner nativo e PostgreSQL real validam migrations, metadados, isolamento, constraints, transações, rollback, configuração, lifecycle e limpeza. |
| Limites de escopo | FR-020, FR-021 e SC-006 | Não há autenticação, OS, estoque, Outbox, RabbitMQ, MongoDB, Redis, Kafka, CQRS, microsserviços ou TypeScript nesta feature. |
| Segurança da operação destrutiva | SC-007 | Testes comprovam bloqueio antes de qualquer ação destrutiva para identidade ausente, ambígua, não isolada ou coincidente com o original. |
| Bootstrap PostgreSQL seguro | FR-006, FR-009 e SC-007 | Preflight fail-closed da instância, criação protegida somente de banco ausente, preflight da identidade efetiva do banco, caminho/configuração explícitos e aplicação do baseline são estágios distintos e testáveis. |

## Constitution Check

*GATE: passou antes da Fase 0 e foi reavaliado após o desenho da Fase 1.*

| Princípio/Regra | Aplicação no plano | Status |
| --- | --- | --- |
| I. Integridade Transacional e Dados | PostgreSQL permanece fonte oficial; Use Cases controlam transações; recovery de migration parcial exige diagnóstico explícito; preservação requer inventário, reconciliação e rollback. | PASS |
| II. Domínios Independentes | O baseline não introduz estrutura ou integração de OS, estoque ou outros domínios. | PASS |
| III. Sessões Seguras e Autorização | Configuração não registra segredos; destino destrutivo é validado de forma explícita. Autenticação e CSRF não são alterados. | PASS |
| IV. Idempotência e Integração | Não cria comandos de estoque, Outbox ou consumers. A reexecução de migrations é distinta de recovery e de reaplicação registrada. | PASS |
| V. Qualidade Verificável | Testes unitários e PostgreSQL real cobrem migrations, metadata, isolamento, configuração, lifecycle, transações e rollback. | PASS |
| Governança | Mantém migrations legadas como histórico, rebuild limpo como padrão e preservação como fluxo opcional. Constituição e plano de saneamento não são modificados. | PASS |

**Reavaliação pós-desenho:** PASS. As novas peças são infraestrutura mínima para tornar uma
operação destrutiva verificável e segura; não introduzem complexidade de domínio nem exceção
constitucional.

## Project Structure

### Documentation (this feature)

```text
specs/001-rebuild-persistence-foundation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── baseline-operations.md
├── checklists/
│   └── requirements.md
└── tasks.md                 # Não criado por /speckit-plan; responsabilidade de /speckit-tasks
```

### Source Code (repository root; desenho-alvo, não criado neste planejamento)

```text
src/
├── app/
│   ├── controllers/         # HTTP e validação de transporte; sem Models diretos
│   ├── repositories/        # Acesso a dados; recebe transação do Use Case
│   ├── services/            # Application Services / Use Cases e limites transacionais
│   └── models/              # Somente Models de estruturas que uma feature aprovar
├── config/                  # Leitura e validação centralizada de perfis
├── database/
│   ├── migrations/          # Histórico legado, preservado
│   ├── baseline/            # Diretório canônico futuro de migrations do baseline
│   └── index.js             # Inicialização ORM a ser reconstruída
├── infrastructure/
│   ├── lifecycle/           # Inicialização, prontidão e encerramento
│   └── persistence/         # Preflight, identidade, executor, erros e recovery
└── server.js

tests/
├── unit/
├── integration/
│   ├── configuration/
│   └── persistence/
└── support/
    └── database/

scripts/
└── database/
    └── baseline/            # Comandos internos; nunca selecionam o legado automaticamente
```

**Structure Decision**: Projeto único de serviço web. Os caminhos acima são o alvo para a fase de
implementação, não arquivos criados por este plano. O executor do baseline terá diretório,
configuração e metadados próprios; o executor legado permanece limitado ao diretório e metadados
legados. O wrapper/preflight é obrigatório porque o Sequelize CLI pode autenticar e, quando há
schema customizado, tentar criá-lo durante a preparação do migrator; portanto a identidade e o
caminho devem ser validados antes de invocá-lo.

## Bootstrap e Semântica de Rebuild

O termo “rebuild limpo” nesta feature significa aplicar o baseline canônico a **um banco isolado
vazio e já identificado**. Não significa apagar, dropar ou recriar automaticamente um banco que já
exista. O bootstrap é dividido em etapas ordenadas:

1. **Preflight fail-closed da instância PostgreSQL:** exigir ambiente explicitamente de
   desenvolvimento, host, porta, perfil lógico e registros completos de destino autorizado e
   identidades protegidas. A identidade efetiva deve corresponder integralmente a um destino
   autorizado e a nenhum protegido; ausência, ambiguidade, divergência ou coincidência com o
   original bloqueia antes de conectar a banco administrativo ou emitir `CREATE DATABASE`.
2. **Criação protegida do banco isolado:** somente se o banco-alvo estiver ausente e a instância
   tiver passado no preflight; cria exclusivamente o nome declarado para o perfil isolado. Não faz
   `DROP DATABASE`, não substitui banco existente e não toca instância original.
3. **Preflight da identidade efetiva do banco:** validar host, porta, database, ambiente e perfil
   lógico da conexão contra a allowlist e a denylist, além do caminho canônico e da configuração
   explícita de `baseline_meta`. `NODE_ENV=development` ou database isoladamente não substituem essa
   comparação integral. Se `baseline_meta` já existir, inspecionar schema e objetos antes de uso;
   divergência bloqueia sem remover, recriar ou sobrescrever objetos.
4. **Execução do baseline:** somente após as etapas anteriores, invocar o CLI com configuração e
   caminho exclusivos. O CLI pode criar `baseline_meta` somente nesse ponto; depois validar
   `baseline_meta.SequelizeMetaBaseline`, sem aceitar `search_path`, `public` ou schema inesperado.

O bootstrap protegido cria somente banco autorizado e ausente; a aplicação inicial da baseline é
etapa posterior, somente para banco autorizado e comprovadamente vazio. Reexecução de banco já
íntegro retorna `already-current`; migration já registrada retorna `migration-already-recorded`;
divergência ou aplicação parcial retorna `recovery-required`. Nenhum desses fluxos executa `DROP`,
recriação ou recuperação automática.

Uma operação que pretenda apagar ou recriar estruturas em banco existente é um fluxo destrutivo
separado, com solicitação explícita, preflight próprio de instância e banco, confirmação de
identidade e testes de bloqueio. `already-current` e qualquer reexecução são estritamente
não destrutivos e nunca autorizam drop, recriação de banco ou limpeza de estruturas.

## Validation Strategy

1. Validar unidade de configuração, preflight de instância, identidade do banco, equivalência ao
   original, caminho canônico, fronteiras de camada, propagação transacional e mapeamento seguro de
   erros.
2. Em PostgreSQL isolado, provar que bootstrap bloqueia instância original/ambígua antes de conectar
   para criar banco, que criação só aceita banco isolado ausente, e que banco existente não é
   removido/recriado pelo baseline. Provar também aplicação limpa, dez reexecuções controladas sem
   DDL, reaplicação registrada sem alteração e recovery obrigatório após falha parcial.
3. Criar fixtures separadas para `SequelizeMeta` e `SequelizeMetaBaseline`; provar isolamento do
   baseline para o legado e do legado para o baseline, inclusive em listagem/status e escrita.
4. Quando houver `migrationStorageTableSchema`, validar que o schema existe, que a tabela
   qualificada existe nesse schema, que a coluna `name` é PK/única e que nenhuma tabela homônima em
   schema inesperado foi usada.
5. Provar falha segura para caminho ausente, caminho legado, diretório de fixture errado ou caminho
   fora do diretório canônico: resultado `blocked`, sem invocar CLI e sem criar schema/tabela ou
   alterar dados.

## Complexity Tracking

Nenhuma violação constitucional ou complexidade excepcional foi identificada. Repository e Use
Case são exigidos pela Constituição; preflight de destino/caminho e metadata isolada são o mínimo
necessário para impedir que um comando de migration destrutivo alcance destino ambíguo ou legado.