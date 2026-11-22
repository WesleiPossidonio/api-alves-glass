# US2 — T037 — evidência final — 2026-11-17

## Resultado

**T037 CONCLUÍDA.** Esta evidência cobre transporte HTTP, middleware e headers, incluindo uma integração HTTP focada com sessão persistida, PostgreSQL 17 e MinIO reais. Não executa nem antecipa a bateria de lifecycle/restart/concorrência atribuída a T038, nem o gate viewer/checkpoint T039.

Worktree `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`, branch `feature/005-budgets-pdf`. Alterações locais preexistentes foram preservadas; migrations, Features 003/004 e `/budged` não foram alterados nesta rodada. Sem deploy, commit, push ou PR.

## Ambiente e execução Docker

- Imagem validada reutilizada: `alves-glass-api:feature005-qpdf-20261117040200-verified`, digest `sha256:9df6780832b95564d1a5ed153eebbf36bdce8b2ef12e0f295614a977134d7440`.
- Runtime observado: Node `v22.23.5`, Yarn Classic `1.22.22`, qpdf `12.3.2`.
- Código atual foi montado como bind read-only nos containers efêmeros; não foi executada cópia antiga incorporada à imagem nem ocultado `/app/node_modules`.
- Run ID `35eb2feadec9` validado antes dos testes pelo `verify-resources.py` e `openBudgetGateEnvironment`: PostgreSQL 17, MinIO e rede/volumes com IDs esperados; sem portas publicadas. `app.env` e manifesto privados (UID 1000, modo 0600). Nenhuma migration/reset/provisionamento executado.
- `node_modules` root-owned e incompleto no host foi preservado; nenhuma instalação host/sudo/chmod/chown foi feita. A estratégia de execução foi a imagem aprovada e runner/isolamento Docker.

## Diagnóstico dos relatos de falha

### `POST /budgets/:id/publish` — `Cannot POST`

O registro efetivo existe: `createBudgetPdfRouter` registra `POST /:id/publish`, montado em `/budgets`; o teste HTTP atual exercita esse mesmo router. A reprodução mínima sem sessão válida respondeu `401 sessionInvalid`, provando que a requisição alcança o router e auth, não um 404 de ausência de rota.

O 404 do teste anterior não era o comportamento da aplicação. O double de publicação implementava a assinatura do service (`publish(id, body, actor, options)`) embora o router chame o método do controller HTTP (`publish(request, response)`). Assim o teste não exercitava a interface/caminho de controller apropriados. O teste foi corrigido para instanciar `BudgetPdfController` real com `BudgetPdfPublishService` injetado. A integração final comprovou `POST /budgets/:id/publish` com sessão real, PUBLISH e resposta `200`, DTO mínimo e ETag.

Composição de rotas preserva os paths aprovados e monta `/client/budgets` antes de `/budgets`, evitando que o prefixo administrativo mais amplo intercepte o portal. Não foi criado alias ou endpoint alternativo.

### Interrupção PDF/Range

O controller HTTP não usa `send()` para o PDF. Ele aplica os headers no callback `onReady` sem flush antecipado; T036 permanece responsável por priming do primeiro chunk, backpressure/pipeline, contagem exata e abort de source/destination. A integração final usou `BudgetPdfStreamService` e storage MinIO reais pelo HTTP Express.

O fechamento prematuro observado no teste inicial veio do double: para 416 ele finalizava sem corpo, mas anunciava `Content-Length` de 4. O mock foi corrigido para zero bytes em 416; o `Content-Range` continuou `bytes */size`. Com o service real, integral, Range e 416 foram entregues sem encerramento indevido. Não foi removida proteção de cancelamento, nem alterado lifecycle/locks.

## Rotas/controller e segurança

- `POST /budgets/:id/publish`: `auth` de sessão/cookie, validação CSRF e Origin, `requireUser`, controller e `BudgetPdfPublishService`; identidade vem exclusivamente da sessão. Serviço continua autorizando `PUBLISH` independentemente de READ e revalida membership/setor. Testado PUBLISH sem READ.
- `GET /budgets/:id/pdf`: sessão interna e `READ`, slot selecionado somente no fluxo interno; stream service real.
- `GET /client/budgets`, `GET /client/budgets/:id`, `GET /client/budgets/:id/pdf`: `requireClient`, proprietário da sessão e serviços do portal; cliente não pode escolher `slot`, `clientId`, key ou document id.
- `ClientBudgetPdfController` deriva actor de `request.userId`/`actorType`; não aceita proprietário externo. Privado, ausente e outro cliente têm 404 uniforme. PDF vencido permanece acessível.
- Publicação responde somente `{id,revision}` e ETag; If-Match ausente → 428, stale → 412.
- Header filename é aceito somente quando corresponde a UUID `.pdf`; tentativa CR/LF é rejeitada antes dos headers. Sem URL, bucket, registry ou object key em respostas.
- Após headers/bytes, erro destrói a resposta/source; não envia JSON sobre o PDF. Antes dos bytes, erro de armazenamento retorna envelope sanitizado 503.

## Resultados HTTP verificados

Integração executada pelo arquivo `tests/integration/budgets/us2-http.integration.test.js`, em container Docker isolado com PostgreSQL 17/MinIO e sessões realmente persistidas:

| Caso                                    | Resultado                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Publish autorizado, PUBLISH sem READ    | `200`, `{id,revision}`, `ETag: "budget-{uuid}-2"`                            |
| Origin ausente / CSRF inválido          | `403`, sem publicação                                                        |
| If-Match ausente / revision stale       | `428` / `412`                                                                |
| Privado, inexistente, outro cliente     | `404` uniforme                                                               |
| Publicado vencido, cliente proprietário | acessível; DTO indica `expired: true`                                        |
| PDF integral                            | `200`, `Content-Type: application/pdf`, bytes e comprimento exatos           |
| Range válido `bytes=0-7`                | `206`, `Content-Range: bytes 0-7/size`, comprimento 8, bytes correspondentes |
| Range fora de faixa                     | `416`, `Content-Range: bytes */size`, corpo vazio                            |
| Inline/attachment                       | filename UUID `.pdf`, disposition conforme consulta validada                 |
| Cache e isolamento                      | `private,no-store,max-age=0`, `Vary: Cookie`, `nosniff`, CSP `sandbox`       |
| Cliente escolhe slot                    | `400`; não chega ao storage como seleção de slot                             |

Teste HTTP local direcionado também cobre 503 pré-bytes sanitizado, erro após bytes sem JSON adicional e filename CR/LF. Doubles são usados apenas para esses casos de fronteira; ownership/publicação/stream/headers acima têm integração real.

## Testes e checks

- `operational-runner.py --scenario unit`: **113 pass, 0 fail, 0 skip/TODO**. Log `/tmp/feature005-t021-7gg672ji/t022-ops-1423afe8330c/unit.log`.
- `operational-runner.py --scenario contract`: **9 pass, 0 fail, 0 skip/TODO**. Log `/tmp/feature005-t021-7gg672ji/t022-ops-301b1928f97f/contract.log`.
- Transporte real focado `us2-http.integration.test.js`: **1 pass, 0 fail, 0 skip/TODO**, log `/tmp/feature005-t021-7gg672ji/t037-http-final-011245/http.log`.
- Regressões unitárias pertinentes de autenticação, service-orders, configuração, persistência e stock: **225 pass, 0 fail, 0 skip/TODO** (container Node/Yarn da imagem; comando `node --test --test-concurrency=1 ...`).
- `node --check` em controllers, middleware, rotas e testes: passou.
- Prettier `--check` em arquivos novos/alterados da T037 e relatório: passou. `src/routes.js` teve apenas a linha de montagem da rota; preservou-se o estilo legado, sem formatação integral.
- `git diff --check`: passou.
- Sem execução migrated completa, fresh/upgrade, viewer/browser gate ou cenários de lifecycle atribuídos a T038/T039.

## Arquivos desta rodada

- Atualizados: `src/app/controllers/BudgetPdfController.js`, `src/app/controllers/ClientBudgetPdfController.js`, `src/app/meddleawares/budgetPdfHttp.js`, `src/routes.js`, `tests/unit/budgets/us2-http-transport.test.js`, `specs/005-budgets-pdf/tasks.md`.
- Adicionado: `tests/integration/budgets/us2-http.integration.test.js`.
- Este relatório atualizado como evidência final.

T037 encerrada. **Parar aqui: T038 e T039 permanecem abertas e não iniciadas.**
