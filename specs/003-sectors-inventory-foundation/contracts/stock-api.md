# Contrato HTTP proposto — Feature 003

Este documento planeja recursos e autorização; nomes finais de URI, envelopes, status e paginação
devem ser alinhados ao padrão global de erros da API antes das tasks. IDs são UUIDs internos salvo
token QR opaco. Não confiar em nomes/atores/setores enviados como identidade. Requisições mutáveis
autenticadas por cookie exigem sessão, Origin permitido e CSRF conforme Feature 002.
Persistência e consultas desta feature usam PostgreSQL 17, versão oficial adotada pela Alves Glass API.
Arquitetura aprovada: comandos e fatos canônicos em PostgreSQL; Transactional Outbox + RabbitMQ
assíncronos at-least-once; consumers idempotentes; MongoDB para projeções reconstruíveis de leitura.
O histórico projetado é encapsulado em `movements`; consultas/projeções devem reconciliar com
  PostgreSQL. Snapshots versionados são exigidos pelo critério de aceite registrado em 12/11/2026;
Redis não integra a arquitetura aprovada da Feature 003.

## Convenções

- JSON; instantes de eventos em UTC ISO-8601; quantidade decimal em string. Filtros de relatório
  `from` e `to` são datas civis `YYYY-MM-DD` em `America/Sao_Paulo`, intervalo semiaberto `[from,to)`.
- `admin` é global; `user` precisa de `UserSector` corrente para o setor de cada recurso.
- `Client` não tem acesso a estoque nesta feature.
- Erros conceituais: `400` payload/precisão; `401` sessão/autorizador inválido conforme política
  genérica; `403` setor/role; `404` recurso não encontrado fora do escopo; `409` código duplicado,
  conflito de idempotência, estado incompatível ou saldo insuficiente; `413` mídia acima do limite;
  `415` formato não suportado; `429` limite/bloqueio de PIN. Confirmar mapeamento uniforme existente.
- Comando que altera saldo exige `Idempotency-Key` e `operationId` estável para a tentativa lógica.
  UNIQUE `(warehouse_id, principal_type, principal_id, key)` preserva escopo aprovado; UNIQUE
  `(warehouse_id, operation_id)` impede a mesma intenção de executar de novo após troca de
  autorizador. Mesmo principal/chave e mesmo hash retorna resultado salvo; conteúdo divergente
  conflita. Se o autorizador mudar, retornar conflito genérico sem revelar receipt; o principal
  original pode repetir após nova validação de permissão, preservando autoria do evento.

## Recursos propostos

### Setores e autorização

- `GET /sectors`: admin lista global; user recebe apenas setores autorizados.
- `GET /sectors/:sectorId/warehouses`: admin global; user exige autorização corrente.
- `PUT /users/:userId/sectors/:sectorId`: admin concede vínculo; motivo obrigatório. Auditoria
  append-only registra ator, usuário afetado, setor, ação `GRANT` e timestamp UTC do servidor.
- `DELETE /users/:userId/sectors/:sectorId`: admin revoga vínculo atual e registra auditoria
  append-only com ator, usuário afetado, setor, ação `REVOKE`, motivo e timestamp do servidor.
- Autorização administrativa é validada no backend; ator/timestamp não são aceitos do payload.
- Alterações só afetam comandos posteriores; comportamento de comandos já em transação deve ser
  serializado/definido no desenho técnico.

Almoxarifados pertencem a um setor. Nome é único no setor após trim e sem distinção de caixa.
Inativação preserva histórico e impede novas movimentações ordinárias; não há hard-delete de
almoxarifado com histórico.

### Categorias e materiais

- `GET/POST /warehouses/:warehouseId/categories`; `GET/PATCH /categories/:id`;
  endpoints análogos para subcategorias. Mutação exige sessão, autorização setorial e, se ato
  administrativo assim definido na matriz, `admin`.
- `GET/POST /warehouses/:warehouseId/materials`, `GET/PATCH /materials/:id`;
  `POST /materials/:id/activate` e `/deactivate` ou alteração PATCH validada.
- Material: código global, nome/descrição, unidade do catálogo, categoria/subcategoria,
  localização, mínimo, imagem opcional e `initialQuantity` obrigatório como string decimal exata.
  Admin pode cadastrar globalmente; user somente no setor autorizado. Cadastro grava atomicamente
  Material, saldo e evento `OPENING`; zero é aceito, negativo e escala inválida são rejeitados.
  O backend define `performedBy`; não aceitar alteração de `initialQuantity` em PATCH nem exigir uma
  segunda operação/aprovação para abrir o saldo inicial do cadastro. G1 não bloqueia este fluxo.
- Inativar só quando saldo zero; material inativo permanece consultável e sem movimentos ordinários.
- Upload segue `multipart/form-data`, JPEG/PNG/WebP, máx. 5 MB; storage e acesso conforme decisão
  aprovada. Falha de persistência deve limpar objeto órfão.

### QR público

- `GET /stock/qr/:token`: sem sessão, rate-limited; devolve somente nome, imagem
  aprovada e unidade. Sem saldo, localização, setor, disponibilidade, mínimo ou histórico.
- QR identifica material e não autoriza comando. Token inválido/revogado retorna resposta genérica.
- Retirada QR/manual é comando sem sessão persistente, protegido por PIN pontual. Payload:
  `{ operationId, token | materialId | code, quantity, pin }`; `Idempotency-Key` obrigatório.
  Não aceitar `withdrawnByUserId`, `authorizedByUserId` nem `performedBy`; todos os atores derivam
  do PIN validado. O PIN é simultaneamente retirante e autorizador; não logar token ou PIN.
- Resolver almoxarifado no backend pelo QR; não aceitar `warehouseId` como autoridade do cliente.
  Identificar o autorizador antes de validar PIN e responder genericamente a usuário/PIN/bloqueio.
  `operationId` é criado uma vez e reutilizado nos retries da mesma intenção.

### Movimentações autenticadas

- `POST /materials/:id/movements/in`: sessão + autorização setorial, quantidade positiva, descrição
  e motivo conforme catálogo. Ator é resolvido da sessão.
- `POST /materials/:id/movements/out`: se fluxo operacional diferente do QR for autorizado, sessão
  e setor; se retirar via QR, usar o endpoint pontual definido acima. Não inventar autenticação.
- `POST /materials/:id/movements/returns`: quantidade positiva, justificativa, `originalEventId`
  obrigatório quando identificável (recomendação: exigir referência sempre que o retorno for
  vinculado a uma saída concreta); serviço valida Material e saldo sem exceder a parte retornável.
- `POST /materials/:id/movements/adjustments`: admin; `{ delta, reasonCode, description }`;
  delta assinado e justificativa obrigatória. Aprovação, se separada de autor, permanece pendente
  se não prevista para ajuste.
- `POST /materials/:id/opening`: admin aprova; inclui quantidade não negativa, fonte/evidência,
  conferente, aprovador e instante de corte. Uma abertura por material. Decisões de negócio sobre
  documento e roles devem ser aprovadas antes de liberar.
- `POST /inventory-events/:id/compensations`: cria novo movimento compensatório, referência ao
  evento original, motivo e delta apropriado; nunca edita/apaga original.
- Todos retornam evento e saldo resultante sem PIN/hash. Correlação da chave é mantida no backend.

### Consultas/histórico

- `GET /materials/:id`: dados do material e saldo para usuário autorizado; QR público não expõe saldo.
- `GET /materials/:id/movements?cursor=&limit=&from=&to=&type=`: autorização de setor; ordem
  `(occurred_at DESC, sequence DESC)` ou `(occurred_at DESC, id DESC)` estável; limite configurável
  com máximo aprovado. Cursor carrega filtros/ordenação e não permite mudar escopo entre páginas.
- `GET /reports/stock`: relatório agregado por material/unidade. Filtros: `from`, `to`, `warehouseId`,
  `sectorId`, `materialId`, `type`, `withdrawnBy`, `receivedBy`, `performedBy`, `authorizedBy`.
  Intervalo civil semiaberto em `America/Sao_Paulo`, máximo 12 meses civis; rejeitar datas
  inexistentes, invertidas e intervalo acima do máximo. Não é paginado por evento e seus totais são
  calculados no PostgreSQL sobre o conjunto filtrado, nunca a partir de uma página do extrato. Retorna
  por material/unidade saldos e totais separados; não somar unidades distintas.
- `GET /reports/stock/statement`: extrato detalhado de eventos com os mesmos filtros e paginação
  keyset. Ordenação `occurred_at DESC, id DESC`; `limit` padrão 25, máximo 100; `cursor` opaco com
  HMAC, vinculado a filtros, ordenação e escopo setorial corrente. A primeira página fixa `asOf` e
  limita `occurred_at <= asOf`; páginas seguintes preservam esse marco e o último par de ordenação.
  Permissões são consultadas novamente em cada requisição. `asOf` não é snapshot MVCC: commits tardios
  nem eventos gravados depois com timestamp retroativo têm garantia de inclusão/estabilidade.

## Matriz de autorização resumida

| Operação | Visitante QR | `user` setor | `admin` |
|---|---:|---:|---:|
| QR resolve dados cadastrais mínimos | Sim, rate limit | Sim | Sim |
| Consultar saldo/histórico/relatório | Não | Sim, setores autorizados | Global |
| `IN`, `OUT` ordinário, `RETURN` | Não | Sim, conforme fluxo aprovado | Sim |
| Ajuste | Não | Não | Sim |
| Aprovar abertura | Não | Não | Sim |
| Retirada via PIN | Comando sem sessão persistente; titular do PIN, setores atuais | conforme PIN e setor | PIN individual e setor |
| Conceder/revogar acesso setorial | Não | Não | Sim |

### Retirada unitária QR aprovada

- Fluxo: resolver material por QR/manual e mostrar saldo atual; receber uma quantidade; abrir Dialog
  de PIN; validar PIN e autorização setorial no backend; registrar um `OUT` único e atualizar saldo
  atomicamente; cliente retorna à leitura do próximo material. Retirada em lote não é suportada.
- PIN individual de seis dígitos, separado da senha, armazenado somente como hash. Admin pode
  cadastrar, redefinir e revogar. Tentativas são limitadas por titular **e origem**, com bloqueio
  temporário. PIN nunca é retornado, registrado ou incluído no ledger/log.
- A pessoa titular do PIN é o próprio retirante: `withdrawnBy` e `authorizedBy` são derivados da
  mesma conta validada; `performedBy` permanece nulo no fluxo sem sessão, sem sessão administrativa
  implícita. Não há `collaboratorId` ou ator confiável vindo do frontend.
- QR identifica somente Material e não autentica. Deve haver alternativa de identificação manual;
  backend sempre confirma material ativo, warehouse associado e setor/autorização atual.
- PIN tem exatamente seis dígitos e também serve como identificador: lookup por HMAC-SHA256 com
  segredo servidor independente de `SECRET_KAY`, persistindo apenas o digest em `pin_lookup`; a conta
  encontrada é verificada por Argon2id/bcrypt. PINs ativos são únicos e colisões são rejeitadas.
- Para saldo e identificação manual, o terminal valida PIN sem criar sessão; catálogo público manual
  por código não existe. Limite persistente é aplicado por origem e por tentativa/titular.

#### Endpoints unitários

- `GET /stock/qr/:token`: público; retorna somente nome/unidade e metadados públicos autorizados.
- `GET /stock/material-code/:code/withdrawal` não é público; consulta manual protegida por PIN.
- `POST /stock/withdrawals`: público quanto à sessão (sem middleware de login), mas protegido por
  PIN obrigatório e autorizado exclusivamente no backend; a rota ainda não está liberada devido ao
  gate técnico descrito abaixo. `Idempotency-Key` mais exatamente um dentre `token`, `materialId` ou
  `code`, `operationId`, `quantity` decimal string e `pin`. Grava um evento `OUT`, saldo e receipt
  atomicamente; retorna evento/saldo sem PIN ou hash. O PIN autenticado é `withdrawnBy` e
  `authorizedBy`; `performedBy` é nulo para `command_origin=QR`.
- `POST/PUT/DELETE /users/:userId/pin`: admin; cadastro/redefinição/revogação com motivo auditado,
  respostas sem PIN/hash. Redefinição/desbloqueio não revelam nem recuperam PIN anterior.
- `POST/DELETE /materials/:materialId/qr-token`: admin; emitir/rotacionar ou revogar token opaco;
  token puro aparece somente na emissão e não é armazenado no banco.

## Gates operacionais e de retenção

1. Abertura manual separada do cadastro inicial permanece fora do fluxo aprovado; cadastro cria
   `OPENING` atômico conforme decisão G1.
2. Política formal e prazos de retenção/anonimização por categoria, após análises jurídica e
   operacional; sem expurgo/anonimização automática até aprovação. Decisão G4 parcial: preservar
   ledger/autoria, desativar conta e revogar acessos aplicáveis, sem reatribuir eventos. Retenção de
   resultado de idempotência deve seguir política aprovada.
3. G5 funcionalmente aprovado: MinIO em bucket público de catálogo e bucket privado; leitura pública
   só para objetos publicados, privados por URL temporária após autorização, escrita pelo backend,
   formatos JPEG/PNG/WebP até 5 MB, chaves únicas e ciclo de substituição seguro. Falta validação
   operacional de buckets, credenciais e permissões.
4. G6 funcionalmente aprovado e contratado acima; validações PostgreSQL estão registradas em
   `tasks.md`; os testes de relatórios exercitam autorização e paginação.
5. Retry após revogação valida permissão atual e, se não autorizada, nega a leitura do receipt; nunca
   executa movimento novo nem revela resultado a principal diferente.
G2/G3 estão aprovadas. Evidência registrada em `tasks.md`: migration aditiva
`20261116000000-create-qr-public-rate-limits.cjs` aplicada no banco isolado de testes e integração
PostgreSQL/HTTP QR/PIN aprovada. Isto não altera o estado de G4–G6 nem substitui seus gates. Rotas
administrativas de PIN/QR continuam atrás de sessão e `requireAdmin`.

## Proposta para aprovação específica — migration e limpeza durável MinIO (não aplicada)

O DDL concreto, índices, estados, locks, leases, política de retry, verificação de referências,
rollback e alternativa para recuperação de uploads órfãos estão em
`docs/feature-003-minio-cleanup-migration-proposal.md`. O Model Sequelize de proposta está em
`src/app/models/MinioCleanupJob.js`, deliberadamente não registrado no inicializador. Nenhuma
migration foi criada/aplicada. É necessária aprovação específica também para decidir se uma segunda
tabela `minio_upload_intents` integra o desenho, pois sem intents a varredura de órfãos é best-effort.