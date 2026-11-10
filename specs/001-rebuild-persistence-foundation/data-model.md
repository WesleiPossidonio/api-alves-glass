# Data Model: Fundação Técnica e Reconstrução da Persistência

## Escopo do modelo

Esta feature não define tabelas ou Models de clientes, usuários, orçamentos, OS, estoque, Outbox
ou outro domínio. O modelo descreve somente metadados técnicos e artefatos de configuração usados
para operar e validar o baseline. O único objeto persistente que poderá ser materializado pelo
mecanismo de migrations é a tabela técnica de metadados do Sequelize CLI; não é tabela de domínio
nem Model da aplicação.

## 1. Registro de migrations do baseline

**Responsabilidade**: registrar migrations canônicas concluídas para um banco de destino específico.

**Representação física planejada**: storage `sequelize` do Sequelize CLI 6.6.5, configurado com
`migrationStorageTableName: 'SequelizeMetaBaseline'`. O histórico legado permanece em
`SequelizeMeta`; nenhum executor substitui, lê ou reutiliza automaticamente o outro.

| Atributo lógico | Regra |
| --- | --- |
| Nome da migration | Identifica unicamente arquivo versionado do conjunto do executor correspondente. |
| Ordem | O executor processa o conjunto determinístico do seu caminho canônico. |
| Estado registrado | Representa sucesso da execução; não corrige schema divergente por si só. |
| Escopo | Pertence ao banco de destino, ao caminho do executor e à tabela/schema configurados. |

**Invariantes**:

- Migration registrada e schema consistente não é reaplicada durante reexecução.
- Migration parcialmente aplicada não é registrada como concluída automaticamente.
- Divergência entre registro e schema bloqueia automação e resulta em `recovery-required`.
- Baseline não interpreta linhas de `SequelizeMeta`; legado não interpreta linhas de
  `SequelizeMetaBaseline`.

### Schema de metadados opcional

Se `migrationStorageTableSchema` for configurado, é parte da identidade do registro. O CLI pode
criar schema PostgreSQL customizado após autenticar, mas somente depois de o wrapper concluir o
preflight do destino e caminho. Após a operação inicial, a validação deverá provar:

| Elemento | Regra de validação |
| --- | --- |
| Schema | Existe no destino aprovado e tem exatamente o nome declarado no perfil. |
| Tabela | Existe como `<schema>.SequelizeMetaBaseline`, não apenas em `public` ou schema derivado do search path. |
| Coluna de controle | `name` não aceita nulo e é chave primária/única, como exigido pelo storage Sequelize. |
| Isolamento | Baseline não usa `SequelizeMeta`; relação homônima em schema inesperado não vale como registro. |

Sem `migrationStorageTableSchema`, a decisão explícita é `public`; a validação exige
`public.SequelizeMetaBaseline` e continua exigindo isolamento de `SequelizeMeta`.

## 2. Perfil de destino protegido

**Responsabilidade**: representar, em configuração validada e não em tabela de domínio, a
identidade do único banco que pode receber a operação solicitada.

| Campo lógico | Regra de validação |
| --- | --- |
| Perfil de operação | Explícito: `development-rebuild`, `test`, `inventory-readonly` ou futuro `data-preservation`. |
| Ambiente declarado | `apply` destrutivo requer desenvolvimento; testes requerem perfil de teste isolado; `status` só observa destinos isolados explicitamente aprovados. |
| Host, porta e database | Obrigatórios e usados juntos como identidade de conexão. |
| Perfil/expectativa de isolamento | Deve corresponder ao destino autorizado; ambiguidade bloqueia. |
| Identidade do original | Referência inventariada obrigatória para bloqueio; coincidência bloqueia mesmo em desenvolvimento. |
| Caminho canônico | Deve existir, estar normalizado e corresponder ao executor antes de invocar o CLI. |
| Metadata | Define storage `sequelize`, tabela exclusiva e schema explícito quando houver. |

**Invariantes**:

- Nenhuma ação destrutiva, conexão CLI, criação de schema técnico ou DDL começa sem preflight.
- O banco original não é selecionado automaticamente nem aceito para rebuild.
- Caminho errado, inexistente, legado ou não canônico bloqueia sem criar schema/tabela de metadata.
- Segredos são referências de configuração e não aparecem em logs, relatórios ou contratos.

### Evidência observacional de status

**Responsabilidade**: representar fatos coletados por adaptador autenticado e estritamente read-only
para classificar um banco isolado já inicializado, sem reutilizar o preflight T012 de banco vazio.

| Elemento lógico | Regra de validação |
| --- | --- |
| Identidade efetiva observada | Completa, autenticada, igual a exatamente um destino da allowlist e a nenhum protegido da denylist. |
| Escopo do destino | Apenas destino isolado aprovado para observação; o original/legado não é destino de `status` desta feature. |
| Metadata canônica | `baseline_meta.SequelizeMetaBaseline` resolvida de forma qualificada, sem `search_path`, com schema/tabela/coluna `name`/constraint canônicos. |
| Histórico observado | Lista completa de nomes registrados na metadata, comparada exatamente ao conjunto determinístico do caminho canônico. |
| Schema observado | Estado consistente de cada migration canônica; evidência parcial, ausente ou contraditória não prova atualidade. |
| Proveniência | Adaptador operacional autenticado e read-only; no `test` local, inspeção Docker confiável correlacionada com IP/porta da sessão em runner da rede dedicada; em outros ambientes, atestado Ed25519 aprovado pode fornecer a mesma prova. Resultado declarativo sem observação efetiva não é evidência suficiente. |

**Invariantes**:

- `already-current` somente existe quando todos os elementos acima são completos e consistentes.
- Inconsistência comprovada entre metadata, histórico ou schema resulta em `recovery-required`.
- Evidência ausente, ambígua, incompleta, contraditória sem diagnóstico conclusivo ou coletada por adaptador não autenticado resulta em `blocked`.
- A evidência de `status` não é autorização, cache ou token para `apply`; `apply` exige novamente T012 e banco vazio.
- A alternativa Docker+sessõo é exclusiva de `test`, fixa `postgres-test:5432` e não aceita `localhost:5434`; ela não disponibiliza Docker socket ao consumidor PostgreSQL.

## 3. Inventário de schema e histórico legado

**Responsabilidade**: guardar evidências para bloquear uso indevido do original e decidir, em fluxo
futuro, se preservação de dados pode ser aprovada.

| Conteúdo lógico | Uso |
| --- | --- |
| Identidade completa do original | Comparada ao perfil de destino antes de rebuild destrutivo. |
| Migrations aplicadas | Evidencia histórico e divergências. |
| Tabelas, colunas, tipos, constraints e índices | Mostra schema para diagnóstico/recovery e eventual preservação. |
| Contagens, órfãos e exceções | Necessários somente para preservação e reconciliação aprovadas. |

**Relacionamentos**:

- O perfil de destino compara sua identidade com o inventário antes de operações destrutivas.
- Recovery compara metadata do executor com schema efetivo.
- Relatório de reconciliação pertence a preservação futura, não ao rebuild limpo.

## 4. Contexto transacional

**Responsabilidade**: unidade de trabalho efêmera, não tabela, iniciada por Use Case e propagada
aos Repositories participantes.

| Regra | Comportamento |
| --- | --- |
| Início | Somente Use Case inicia quando a operação exige atomicidade. |
| Propagação | Mesmo contexto é passado explicitamente a todos os Repositories envolvidos. |
| Sucesso | Use Case confirma uma única vez depois de todas as etapas válidas. |
| Falha | Use Case reverte; Repository não confirma estado isoladamente. |

## 5. Estados operacionais de migration

| Estado | Evidência mínima | Ação permitida |
| --- | --- | --- |
| Destino apto para `apply` | Identidade autorizada, caminho aprovado e T012 comprova banco existente/vazio | Iniciar somente `apply`. |
| Baseline atual para `status` | Evidência observacional completa de identidade, metadata canônica, histórico e schema consistentes | Reportar `already-current`; não executar CLI/DDL. |
| Migration registrada | Nome consta em metadata consistente | Reportar `migration-already-recorded`; não aplicar DDL. |
| Aplicação parcial/divergente | Schema e metadata não provam estado íntegro | Reportar `recovery-required`; inspecionar antes de ação explícita. |
| Evidência insuficiente | Identidade, metadata, histórico ou schema ausente/ambíguo/incompleto | Reportar `blocked`; não inferir estado nem aplicar baseline. |

## Validação de Models e migrations

Para cada estrutura efetivamente incluída em baseline futuro que tenha Model correspondente, testes
contra PostgreSQL real verificam tipos/identificadores, PKs, FKs, nullability, unicidade, índices,
associações, cardinalidades e constraints. A ausência de Model ou tabela de domínio neste baseline
é comportamento esperado, não falha.