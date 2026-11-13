# Research — Feature 003 Setores e Estoque

## Método e contexto inspecionado

PostgreSQL 17 é a versão oficial adotada pela Alves Glass API e a versão-alvo desta feature.

Inspeção estática do repositório em 11/11/2026, sem execução de migration, conexão/escrita em banco
ou alteração de código. Evidências principais: `package.json`, `src/database/index.js`,
`src/config/database.js`, Models/repositories/controllers/services existentes, migrations
`20261110000000`–`20261110000500`, `src/routes.js`, middlewares de sessão, configuração de Multer e
MinIO, testes de unidade e integração, Constitution 2.0.0, specs 001/002/003 e template local
`.specify/templates/plan-template.md`.

## Decisões técnicas propostas/aprovadas

### Arquitetura-alvo do domínio (decisão aprovada; implementação não presumida)

| Tópico | Decisão arquitetural | Limite desta pesquisa/entrega |
|---|---|---|
| Event Sourcing | `InventoryEvent` append-only registra abertura, entrada, saída, devolução, ajuste e compensação; saldo PostgreSQL é mantido transacionalmente e reconstruível a partir dos fatos. | A arquitetura não torna os componentes abaixo já implementados. |
| CQRS / MongoDB | PostgreSQL é autoridade de escrita; MongoDB recebe projeções de saldo, extrato e relatórios reconstruíveis/reconciliáveis. Histórico encapsulado em `movements`. | Obrigatório para aceite final; T050 e validação pendentes. |
| Outbox / RabbitMQ | Outbox grava atomicamente fatos a publicar; RabbitMQ entrega at-least-once; consumers idempotentes deduplicam `consumer + event_id` e tratam falha/reentrega. | Obrigatório para aceite final; T048–T049 e validação pendentes. |
| Snapshots / Redis | Snapshots são opcionais e não substituem ledger; Redis não integra a arquitetura aprovada desta feature. | Não adicionar Redis nem tornar snapshots requisito. |

Esta subseção recupera a direção arquitetural explicitada em `docs/architecture/approved-domain-architecture.md`
e nos checkpoints Cline de 12/11/2026 (`8440b2c`, `3fd35de`). Formulações em checkpoints anteriores
que diziam “futuro/fora” descrevem fronteira de entrega e não constituem evidência de cancelamento.

| Tópico | Decisão de plano | Evidência/justificativa |
|---|---|---|
| Persistência | Sequelize 6 + sequelize-cli convencional em `src/database/migrations`, `public.SequelizeMeta`; migrations novas e aditivas. | Feature 002 e `.sequelizerc`; não reutilizar baseline customizado nem editar migrations existentes. |
| Registro de Models | Adicionar Models à lista explícita em `src/database/index.js`, inicializar e associar uma única vez. | Inicializador atual importa manualmente cada Model e associa usando `connection.models`. |
| Camadas | Controller → Service → Repository → Model; Service é dono da transação e passa `transaction` a todas as leituras/escritas relevantes. | Convenção constitucional; padrão existente em AuthSession e operação de pedido, apesar de inconsistências em código legado. |
| Saldo concorrente | Linha `material_balances` bloqueada `FOR UPDATE` (Sequelize `transaction.LOCK.UPDATE`) antes de cálculo; lock mantido até commit. Criar saldo inicial/row serializadamente; validar saldo não negativo na mesma transação. | PostgreSQL e padrão de lock já usado no repositório em sessões; evita duas saídas confirmadas com base no mesmo saldo. Constraints são defesa adicional. |
| Idempotência | UNIQUE aprovado `(warehouse_id, principal_type, principal_id, idempotency_key)`. Principal é `performedBy` autenticado ou `authorizedBy` no QR. Além disso, cada tentativa lógica recebe `operation_id` aleatório estável, único por almoxarifado e fornecido/reutilizado pelo cliente nos retries. | A chave composta mantém isolamento por principal; `operation_id` impede duplicação da mesma intenção se uma tentativa QR for retomada por outro autorizador. Hash canônico diferencia retry de conflito. O cliente deve manter o `operation_id` durante retries/rea autorização; não derivar identidade da pessoa retirante como chave de autorização. |
| Sequenciamento do comando | Dentro da transação, reservar/obter receipt por chave composta e por `operation_id`; constraints UNIQUE tratam corrida. Mesmo principal + chave + digest retorna receipt se ainda autorizado; digest divergente conflita. `operation_id` repetido com outro principal ou payload não reaplica comando e retorna conflito genérico, sem revelar receipt. | Preserva escopo aprovado e bloqueia duplicidade após troca de autorizador. Após revogação, validar autorização antes de devolver receipt; se revogada, negar replay sem alterar o evento/saldo original. |
| Precisão | Regra aprovada: `un` escala 0; fracionáveis escala máxima 3 (`kg`, `g`, `m`, `cm`, `L`, `mL`, `m²`). `NUMERIC` PostgreSQL e string decimal no contrato. | Validar escala sem round; não converter saldo para JS `Number`. `m³` só após necessidade operacional aprovada. |
| PIN | Identificar principal pelo ID/username fornecido em campo próprio antes de chamar verificador de hash Argon2id; não procurar PIN entre usuários. PIN individual revogável, credencial separada de senha. Hash e estado em armazenamento restrito; eventos de auditoria registram ator/alvo/ação/data/motivo, nunca segredo/hash. | `argon2` já é dependência e `passwordHashing.js` contém suporte; reutilização exige avaliar parâmetros/validador e não reutilizar hash de senha como PIN automaticamente. |
| Tentativas | 5 falhas por titular dentro de 15 min; bloqueio temporário por 15 min, respostas genéricas e auditoria de tentativa/bloqueio sem enumerar conta. Atomicidade de contadores por titular deve sobreviver a concorrência. | Regra aprovada na spec. Store de contadores — PostgreSQL na tabela de segurança/auditoria ou componente já aprovado — deve ser escolhido em revisão técnica; não assumir que rate limiter em memória por IP atende titular em várias instâncias. |
| QR sem sessão | QR identifica Material apenas. Comando recebe ID do autorizador e PIN; resolve/valida usuário e autorização atual, depois testa PIN. `performedBy` fica NULL/não aplicável, `command_origin=QR_PUBLIC` (nome final a confirmar), `withdrawnBy` e `authorizedBy` referenciam identidades distintas. | Regra aprovada; endpoint público de leitura nunca cria movimento. Limitação contra abuso/CSRF para fluxo sem cookie exige contrato de segurança próprio, não sessão inventada. |
| Ledger | Evento separado de saldo; append-only lógico por API, sem update/delete em repository operacional; FK históricas com política não destrutiva. `before_balance`, `after_balance`, `delta`, tipo, unidade/snapshot, motivo, descrição, origens e idempotência. | Constituição I; permitir correção somente por evento ligado ao original. Retenção/anonimização formal ainda pendente. |
| Upload | Reutilizar `StorageService`, MinIO e Multer atuais; aplicar limite da feature de 5 MB, validar assinatura/formato JPEG/PNG/WebP e compensar objeto órfão se gravação do Material falhar. | Repositório já configura MinIO e `memoryStorage` Multer; limite atual é 10 MiB e MIME/extensão não comprovam conteúdo. Confirmar bucket/credenciais e política de acesso/URL/retention antes de liberar mídia. Não adicionar tecnologia. |
| Relatórios | Queries agregadas SQL/PostgreSQL, agrupadas por material e unidade; não somar unidades distintas. G6 aprovado: `America/Sao_Paulo`, máximo 12 meses, intervalo semiaberto, keyset, padrão 25/máximo 100, cursor opaco protegido e vinculado a filtros/ordenação/escopo, autorização revalidada e sem carregar histórico inteiro. | Decisões funcionais aprovadas; T038–T041 pendentes de implementação/testes. Escolher tecnicamente formato/HMAC e versão do cursor, desempate único e estratégia de marco de leitura para movimentações concorrentes. Reconciliação compara saldo persistido com saldo-base + efeitos tipados em janela/escopo. |
| Testes | `node:test`, unitários isolados e integração HTTP com PostgreSQL descartável/isolado; cobrir migration, constraints, lock concorrente, idempotência duplicada/conflitante, PIN e autorização. | `package.json` e padrões em `tests/integration`; runner de teste PostgreSQL tem controles de identidade/allowlist, precisa ser estendido sem relaxá-los. |

## Modelos relacionais propostos

Ver `data-model.md`. Recomendação de tipos: UUID para identidades; `NUMERIC(p,s)` para unidades/saldos,
com limites `p` e constraints finais definidos após magnitude operacional aprovada; `TIMESTAMPTZ`
para instantes; enums funcionais implementados como `VARCHAR + CHECK` ou enum nativo com estratégia
de evolução explícita. Não usar `FLOAT/REAL/DOUBLE PRECISION` para quantidades.

## Contratos e autenticação

- Prefixo/nomes sugeridos dos endpoints ficam em `contracts/stock-api.md`; não há versão de API
  formal no `src/routes.js` atualmente. O documento marca respostas/status e schemas ainda sujeitos
  a alinhamento com o padrão global de erros existente.
- Rotas autenticadas devem passar pelo middleware atual, que valida JWT/sessão persistida, Origin e
  CSRF em mutações por cookie; `requireAdmin` para grants e atos administrativos exclusivos.
- Requisições não podem declarar autoria confiável. Setor e warehouse são carregados/validados no
  servidor; permissões correntes são consultadas a cada comando.
- PIN não é senha nem autenticação de sessão. Endpoint QR precisa rate-limit e payload sem segredo
  em logs; não reutilizar o fluxo de login nem criar cookie.

## Pendências de negócio e impacto em tasks

As pendências não bloqueiam `/speckit.tasks` globalmente. Gerar tasks para decisões e manter bloqueada
somente a capacidade que dependa delas. Este plano não toma essas decisões:

1. **Abertura:** qual documento/fonte aprovada será aceita; quem é conferente designado e quem
   aprova; instante de corte por almoxarifado/material; formato de evidência/observação.
2. **PIN:** fluxo de emissão inicial, alteração, recuperação/revogação, reativação após bloqueio e
   quem pode designar/revogar responsável. Não guardar segredo/hash em auditoria.
3. **Retenção (G4 parcial):** manter ledger append-only e autoria original, desativar contas e revogar
   credenciais/sessões/vínculos aplicáveis, sem reatribuição. Prazos por categoria dependem de análise
   jurídica/operacional; até aprovação não implementar expurgo nem anonimização automática.
4. **Retirante homônimo:** qual dado distintivo (matrícula, equipe/setor ou outro) pode ser exibido
   na seleção, minimizando dados pessoais.
5. **Mídia (G5):** funcionalmente aprovado MinIO, dois buckets (catálogo público e privado), acesso
   público somente a objetos publicados, escrita pelo backend, URL temporária após autorização para
   privados, JPEG/PNG/WebP até 5 MB e chaves únicas. Confirmar upload antes de trocar referência;
   limpar imagem anterior depois da confirmação, sem retenção adicional, e recuperar órfãos sem
   excluir objetos referenciados. Pendente validar buckets, credenciais e permissões operacionalmente;
   não criar/configurar infraestrutura neste planejamento.
6. **Unidade `m³`:** não entra no catálogo inicial sem necessidade operacional confirmada; não
   bloqueia unidades já aprovadas.
7. **Relatórios (G6):** decisões funcionais aprovadas conforme tabela acima. Permanecem decisões
   técnicas: proteção/versão do cursor, desempate total único e marco de leitura/snapshot lógico para
   estabilidade sob inserções concorrentes. Unidades diferentes nunca são somadas.
8. **Operação:** volume/SLO e escala devem orientar tuning e metas, mas não bloqueiam decomposição
   de CRUD/ledger funcional sem metas de performance declaradas.
9. **Retry após revogação:** solução técnica recomendada: revalidar autorização antes de devolver
   receipt; após revogação, negar replay sem reexecutar comando. Não bloqueia decomposição das tasks
   de ledger/idempotência.

## Verificações antes de iniciar implementação

- Confirmar que PostgreSQL local de teste é isolado e que testes não apontam a ambiente com dados.
- PostgreSQL adotado pelo projeto: versão 17. Não é pendência e não se altera Compose nesta feature.
- Confirmar runtime Node real; Feature 002 documenta Node 22 e `package.json` não fixa `engines`.
- Executar `yarn db:migrate:status` como inspeção no ambiente autorizado somente após confirmar
  target identity; não aplicar migrations neste planejamento.
- Precisão/scale já aprovada (`un` 0, fracionáveis até 3); definir `p` sem criar limite de negócio
  arbitrário. Preferir `NUMERIC` com scale correta e validação de magnitude no contrato se magnitude
  máxima não for requisito aprovado.
- Revisar tratamento de corrida no mesmo idempotency key com duas conexões reais PostgreSQL.