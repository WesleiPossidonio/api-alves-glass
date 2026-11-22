# Contratos HTTP planejados — Feature 005

**Implementação vigente US4 (2026-11-18):** DELETE `/budgets/:id` implementado
com confirmação explícita, If-Match e DELETE independente; retorna202
`{id,deleted:true,cleanupPending:true}` somente após commit. Repetição404;
sem nova ETag/revisão de recurso removido e sem prometer limpeza física concluída.
PATCH `/budgets/:id` e PUT
`/budgets/:id/pending-pdf` implementados no router administrativo existente,
com sessão, Origin/CSRF, allowlist, If-Match, ETag e respostas mínimas. Publicação,
consulta e download attachment da US2 preservados. Gestão US5 não implementada.
As notas de implantação por tarefa abaixo são históricas; as
regras funcionais do contrato não foram alteradas.

**Status**: POST/GET /budgets e GET /budgets/:id administrativos implementados em T027/T028 (2026-11-17). T034/T035 implementam somente serviços de publicação e metadados do portal; sem rotas novas. Demais endpoints permanecem desenho; T036 implementa streaming no serviço e descritor de entrega, sem headers HTTP escritos pelo serviço; transporte/T037 e transição legada não implementados nesta rodada. Base URL da API existente; caminhos HTTP não são caminhos de arquivos. Artefato em /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/contracts/http-api.md.

## Convenções

Sessão por cookie existente, actor interno via requireUser e portal via requireClient. Toda mutação valida Origin e x-csrf-token; autorização e ownership no caso de uso, não só rota. Admin global dispensa grant, nunca autoconcessão. Usuário comum ativo exige UserSector corrente. Nomeação gerencial é setorial e independente de OS.

Campos camelCase e allowlist; rejeitar campos desconhecidos (incluindo description_budget, total_value, itens, author, bucket e objectKey). UUIDs válidos, commercialNumber string 1..64 conforme research, administrativeName 1..240, validityDate YYYY-MM-DD civil estrita. DTO sem dados de autenticação de Client, chaves MinIO ou links de bearer.

**Upload / G-PDF fechado**: um PDF não vazio <=10 MiB, assinatura efetiva e qpdf antes do PUT. Executar --requires-password separado de --check, conforme research.md: senha requerida → 422 passwordRequired; erro/aviso estrutural → 422 invalidPdf; não-PDF por assinatura → 415 unsupportedMediaType; tamanho excedido → 413 fileTooLarge; executável indisponível/incompatível → 503 validatorUnavailable; timeout agregado 10 s → 503 validatorTimeout; falha inesperada/sinal/limite de recursos → 503 validatorFailed. Nenhum desses resultados cria candidato/publicação ou armazena bytes no MinIO. PDF com criptografia abrível sem senha só é elegível com --check=0. Não expor saída bruta do processo nem alegar ausência de malware.

Mutações de orçamento existente exigem `If-Match: "budget-{uuid}-{revision}"`: ausente 428, revisão divergente 412 revisionMismatch. Revision serializada como string; ETag de metadados não é URL de documento. Usar requestId para correlação, não prometer idempotency-key não implementada. Após timeout de criação, consulta autorizada por setor/número reconcilia resultado; não duplicar cegamente.

## Operações de orçamento

| Método/caminho               | Entrada                                                                                             | Autorização                                              | Sucesso                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| POST /budgets                | multipart: sectorId, clientId, commercialNumber, administrativeName, validityDate, file obrigatório | CREATE_EDIT                                              | 201 {id,revision,pendingDocumentId}, Location e ETag; privado |
| GET /budgets                 | sectorId obrigatório, clientId/commercialNumber opcionais, limit/cursor                             | READ no setor; admin global mas consulta também setorial | 200 {items,nextCursor}                                        |
| GET /budgets/:id             | UUID                                                                                                | READ do setor                                            | 200 DTO interno e ETag                                        |
| PATCH /budgets/:id           | JSON campos administrativos permitidos, If-Match                                                    | CREATE_EDIT; mudança setor exige origem/destino          | 200 {id,revision}, ETag                                       |
| PUT /budgets/:id/pending-pdf | multipart file obrigatório, validityDate opcional, If-Match                                         | REPLACE_PDF; se validade muda, também CREATE_EDIT        | 200 {id,revision,pendingDocumentId}, ETag; privado            |
| POST /budgets/:id/publish    | JSON {pendingDocumentId}, If-Match                                                                  | PUBLISH                                                  | 200 {id,revision}, ETag                                       |
| GET /budgets/:id/pdf         | slot=published ou pending; sem seletor de disposition                                               | READ                                                     | 200/206 bytes; attachment; nunca chave pública                |
| DELETE /budgets/:id          | JSON {confirmBudgetId: UUID igual ao path}, If-Match                                                | DELETE                                                   | 202 {id,deleted:true,cleanupPending:true}                     |

Respostas de mutação com id/revision e identificador opaco do candidato confirmado não entregam listagem, DTO completo ou download sem READ. PUBLISH pode confirmar revisão/candidato pela resposta de upload/fluxo autorizado, sem conceder READ implicitamente. GET interno com READ revela pendingDocumentId opaco e validade pendente para preparar publicação; esse ID só seleciona candidato já vigente, não permite referenciar objeto arbitrário. Chamador com PUBLISH isolado precisa receber revisão/identificador corrente de fluxo autorizado ou operador com READ; não há endpoint que contorne READ.

PATCH antes da primeira publicação aceita clientId, sectorId, commercialNumber, administrativeName, validityDate inicial. Depois: somente administrativeName; identidade bloqueada retorna 409 identityLocked, validade isolada retorna 409 replacementPdfRequired. Alteração de validade após publicação só via PUT com PDF obrigatório. Se PUT omitir validade: herdar pendente vigente ou publicada vigente, capturada na revisão esperada. Novo cadastro sempre envia validade. Novo arquivo substitui o pendente anterior somente após commit seguro.

Publicação exige pendingDocumentId igual ao slot pendente corrente e If-Match; 409 noPendingPdf ou 412 stale se já substituído. PDF/data tornam-se publicados juntos; cliente continua acessando anterior até commit. Não há unpublish, aceite comercial, revisão histórica ou OS.

DTO interno: id, sectorId, clientId, commercialNumber, administrativeName, createdBy, createdAt, updatedAt, revision, firstPublishedAt; published {documentId,validityDate,expired} ou null; pending {documentId,validityDate} ou null. Sem histórico/lista de objetos de cleanup. published.expired calculado em São Paulo no pedido.

## Portal do cliente

| Método/caminho              | Comportamento                                                                |
| --------------------------- | ---------------------------------------------------------------------------- |
| GET /client/budgets         | somente client_id da sessão e published_object_id existente; limit/cursor    |
| GET /client/budgets/:id     | DTO do próprio publicado, senão 404                                          |
| GET /client/budgets/:id/pdf | somente slot publicado próprio; sem seletor de disposition/slot/document/key |

DTO cliente: id, administrativeName, commercialNumber, sector {id,name}, validityDate publicada, expired boolean. Setor é o label do cadastro existente, sem simular nome histórico. Datas vencidas não filtram o documento. A lista vazia retorna 200 items=[], não 500. Nenhum endpoint cliente de edição/decisão/exclusão.

Paginação: limit padrão 25/máximo 100, cursor opaco HMAC TTL 15 min com ator, escopo/setor, filtros e posição created_at DESC,id DESC. Invalidado/trocado escopo → 400 invalidCursor. Concessões sempre revalidadas, não incorporadas como autorização pelo cursor. Consulta por commercialNumber exata no setor permite recuperar criação após timeout. Sem busca textual ambígua nesta entrega.

## Entrega binária

GET faz stream através da API com referência vigente após autorização e locks; entrega sempre `Content-Disposition: attachment`, sem parâmetro ou caminho que permita forçar inline. Content-Type application/pdf, filename sanitizado e baseado em UUID (sem interpolar nome/número), Content-Length, Accept-Ranges bytes. Range único válido → 206 com Content-Range; múltiplo/inválido/fora de faixa → 416 sem bytes. Cada novo Range reautoriza; sem 304 ou redirect para MinIO. Consultas slot indisponível retornam 404.

Cache-Control private,no-store,max-age=0; Vary Cookie; X-Content-Type-Options nosniff; Content-Security-Policy sandbox. Sem URLs públicas ou pré-assinadas. Visualização inline foi explicitamente adiada para melhoria futura e exige gate próprio; o gate anterior do viewer não é aprovado por esta entrega. Guards mantidos até stream limitado terminar/abortar; depois de troca/exclusão confirmada, URL anterior apenas reconsulta estado vigente. Não suporta recuperar objeto antigo por documentId.

## Gestão comercial

| Método/caminho                                                  | Entrada               | Regra                                                                                          |
| --------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| GET /sectors/:sectorId/budget-permissions                       | consulta              | admin, gerente ou MANAGE_PERMISSIONS efetivo no setor                                          |
| PUT /sectors/:sectorId/budget-managers/:userId                  | JSON {}               | admin apenas; alvo ativo/member, não próprio ator                                              |
| DELETE /sectors/:sectorId/budget-managers/:userId               | sem corpo obrigatório | admin apenas                                                                                   |
| PUT /sectors/:sectorId/budget-permissions/:userId/:operation    | JSON {}               | admin ou gerente/MANAGE_PERMISSIONS no setor para cinco operações; MANAGE_PERMISSIONS só admin |
| DELETE /sectors/:sectorId/budget-permissions/:userId/:operation | sem corpo obrigatório | mesmas regras de alcance/delegação                                                             |

Operações permitidas: CREATE_EDIT, READ, REPLACE_PDF, PUBLISH, DELETE, MANAGE_PERMISSIONS. Gerente nomeado tem poderes comerciais aprovados no seu setor; colaborador com MANAGE_PERMISSIONS só delega/revoga as cinco permissões operacionais, sem nomear gerente ou adquirir READ automaticamente. Não administrador delega a colaborador (role user), não altera administrador/gerente para ampliar privilégios próprios. Alvo deve ter membership vigente; fluxo não concede membership ou role global.

Proibir userId=ator em qualquer concessão/nomeação, inclusive admin; gerente não altera seus próprios grants para ampliar poderes. Revogação não amplia poderes; exigir autoridade e serializar com guard. Toda mudança efetiva gera auditoria atômica {actor,target,sector,action,operation,time}. Resposta 200 {changed,auditId}, auditId nulo quando unchanged; repetição idempotente não inventa evento de nova concessão. Perda de membership desativa grants efetivos, sem copiar permissões de OS/estoque. Sem campo de motivo obrigatório não aprovado.

## Erros e privacidade

Formato {error:{code,message,requestId}}. 400 invalidInput/invalidCursor; 401 sessionInvalid; 403 forbidden/csrfFailed/selfGrantForbidden; 404 budgetNotFound para cliente sem ownership/privado/ausente e leitura interna sem visibilidade; 409 duplicateNumber/identityLocked/replacementPdfRequired/noPendingPdf/operationBusy; 412 revisionMismatch; 413 fileTooLarge; 415 unsupportedMediaType; 422 invalidPdf/passwordRequired; 428 revisionRequired; 429 resourceLimit; 503 storageUnavailable/validatorUnavailable/validatorTimeout/validatorFailed. Não retornar stack, chave MinIO ou detalhes do outro cliente. Antes de headers, erro JSON; depois de bytes, abortar stream e correlacionar log.

## Rota legada e integração

POST /budged: **fora do contrato novo**. Nesta feature continua com middleware de autenticação global, `requireAdmin`, Multer legado e `BudgetController.store`, sem 410, redirect ou mudança de payload. A tabela `budget` permanece independente; dados históricos não são importados nem publicados no portal novo. Não afirmar que o cadastro legado satisfaz requisitos da Feature 005. Inventário completo, comunicação, testes de compatibilidade, retirada/adaptação e cutover exigem iniciativa independente e autorização expressa. Os endpoints 003/004 permanecem inalterados.
