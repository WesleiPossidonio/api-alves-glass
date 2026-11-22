# T063 — execução do gate (2026-11-21): **ACEITO TECNICAMENTE**

## Fechamento do bloqueio de build — 2026-11-21

O erro anterior `EAI_AGAIN registry.yarnpkg.com` foi transitório: o host
resolveu o nome e recebeu HTTP 200 em HTTPS; um container Alpine na rede
bridge resolveu o nome e acessou o registry via TLS (exit 0). Sem variáveis
de proxy relevantes no ambiente observado, Docker sem HTTP/HTTPS proxy,
Yarn Classic 1.22.22 com registry original `https://registry.yarnpkg.com`,
sem `.yarnrc`/`.npmrc` no worktree, offline mirror não configurado; cache
local do host presente (~2,2 GB), sem ser usado como substituto do build.
Não houve alteração de DNS, registry, TLS, Dockerfile ou versões.

Mesmo comando aprovado, executado do repositório:
`docker build --pull=false -f docker/dockerfile -t alves-glass-api:t063-local-20261121 .`.
**Exit 0**; `yarn install --frozen-lockfile` concluiu as quatro fases
(incluindo fetch e building fresh packages); etapa `require('argon2')` e
exportação da imagem concluídas. ID da imagem **nova**:
`sha256:0004f77dc7e789bf8035bb13f1f815d84897d3657bae853b83d9e96b50939b2f`
(linux/amd64). Em container desta imagem, sem rede: `qpdf --version`
**12.3.2**, pacotes instalados `qpdf-12.3.2-r0` e `qpdf-libs-12.3.2-r0`;
`require()` de argon2, express, sequelize, minio, pg e jsonwebtoken passou.
SHA-256 de `/app/yarn.lock` e do worktree, ambos
`2f319685dd4556656b36a81e999cc01bf04085a35635ef5bc1c96ed8e9ab4897`;
nenhum `package-lock.json` no host nem na imagem. Evidência:
`/tmp/feature005-t063-build-retry.log` e `.exit`,
`/tmp/feature005-t063-artifact.log` e `.exit` (ambos exit 0).

Confronto com T063: grupos de sessão, Origin/CSRF, ownership, URL/Range,
acesso anônimo/chaves e rejeições qpdf sem PUT têm os resultados reais abaixo
(124 integração + 138 unidade + 19 contratos; zero falhas/skips). O requisito
remanescente de imagem reproduzível agora possui build completo e verificação
do artefato. **T063 aceita tecnicamente**, sem equivaler a deploy ou release.
Limitações operacionais e histórico de tentativas abaixo permanecem registrados;
nenhum teste de segurança foi repetido nesta rodada, pois o build não alterou
os contratos nem o código testado.

---

## Histórico do bloqueio anterior (resolvido)

Critério original: `tasks.md` T063 (sessão/Origin/CSRF/ownership em todos os
endpoints; URL/Range antigos após troca/exclusão; sem acesso anônimo/chaves/URL
presigned; qpdf error/warning/senha/timeout/indisponível/recursos sem PUT;
imagem reproduzível).
Dependências T061/T062 concluídas. Na primeira tentativa não havia aceite
técnico de T063: o build da imagem atual não terminou por indisponibilidade
temporária do registry. A nova tentativa aprovada está documentada acima.

Execução isolada: run novo `49e6bb12a566` em
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/49e6bb12a566/`.
`provision-isolated.js` criou rede interna, PostgreSQL 17 e MinIO sem portas
publicadas, volumes exclusivos; `provision.log`/`verify.log` confirmam identidade
remota, bucket privado (acesso/listagem anônimos 403), conta MinIO limitada,
qpdf 12.3.2 e cgroup. `operational-runner.js --scenario prepare-schema
--approve-schema` aplicou migrations somente ao banco novo e confirmou schema;
`--scenario migrated`, `--scenario unit` e `--scenario contract` executaram
preflight remoto antes das suítes. Exits 0, nenhum skip/TODO:

Comandos (cwd `/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005`,
`MANIFEST=/home/wpossidonio/.local/state/alves-glass/integration/feature005/49e6bb12a566/resources.json`):
`FEATURE005_T021_APPROVED=1 node tests/support/budgets/provision-isolated.js`;
`node tests/support/budgets/operational-runner.js --manifest "$MANIFEST" --scenario prepare-schema --approve-schema`;
o mesmo runner com `--scenario migrated`, `--scenario unit` e
`--scenario contract` (cada comando isoladamente, sem concorrência).

| Suíte / evidência privada sob o run | Aprovados | Falhas | Skips |
| --- | ---: | ---: | ---: |
| `t022-ops-e7f4c0d50a5f/migrated.log` (HTTP/PG/MinIO) | 124 | 0 | 0 |
| `t022-ops-245f4768abd8/unit.log` | 138 | 0 | 0 |
| `t022-ops-bec4759d3be4/contract.log` | 19 | 0 | 0 |

Cobertura executada, conforme asserts das suítes: autenticação por sessão e
papel (admin/usuário/cliente), sessão revogada, Origin ausente/não confiável,
CSRF em mutações com cookie e erros HTTP padronizados (`us1-http`,
`publication-portal`, `permissions`, `replacement`, `deletion-recovery`,
`admin-http`); permissões correntes por setor, ownership do cliente, grants,
revogação e rollback sem promoção implícita (`authorization-matrix`,
`authorization-races`, `permissions`); stream privado/attachment, Range
válido/inválido, acesso antigo após revogação/troca e exclusão
(`publication-portal`, `replacement`, `deletion-recovery`, `us2-stream`,
`stream`); bucket privado, DTOs sem chaves e sem entrega por presigned URL
(`verify.log`, contratos de transporte, `us1-http`); qpdf real com sondagem de
senha, erro/aviso, ausência, timeout e limites, rejeição antes do PUT e
preservação de candidatos anteriores (`pdf-validation`,
`pdf-validation-safety`, `runtime`, `storage`, `replacement`,
`resource-pressure`, `validator-observation`). Integração exercitou operações
negadas em recursos sintéticos de identidades diferentes; esses resultados
não demonstram proteção antimalware nem substituem aprovação operacional.

Imagem: `docker build --pull=false -f docker/dockerfile -t
alves-glass-api:t063-local-20261121 .` retornou **exit 1**; evidência
`/tmp/feature005-t063-build.log` e `.exit`. Dockerfile referencia
`node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a`,
`qpdf=12.3.2-r0` e `qpdf-libs=12.3.2-r0`; essa etapa ficou em cache,
mas `yarn install --frozen-lockfile` falhou com `getaddrinfo EAI_AGAIN
registry.yarnpkg.com`.
**Não existia imagem resultante daquela tentativa**; a imagem
antiga validada pelos testes comprova seu próprio qpdf, não a reprodutibilidade
do Dockerfile corrente. Não foram modificados lockfiles nem substituídas versões.
Build idêntico foi repetido e validado conforme fechamento acima. O Dockerfile
ainda não fixa usuário não-root por default (runner executou UID1000/read-only).

Incidentes de harness, preservados sem mascarar resultado: primeira tentativa
de provisionamento parou antes da criação dos recursos porque o Docker atual
responde `get <nome>: no such volume`; `resourceProvenAbsent` passou a aceitar
somente esse caso com exit 1 para volumes; teste focal: **4/4**, inclusive
negações para sucesso, outro nome e erro de permissão. Diretório privado
`478bd929f24a` preservado. Primeiras suítes locais falharam na importação por
`node_modules` vazio no worktree (`ERR_MODULE_NOT_FOUND`): unidade 27 falhas,
contrato 5 falhas, ambos zero skips; repetidas na imagem verificada com
resultados acima. Tentativas concorrentes de runner unit/contract pararam no
preflight de rede enquanto a suíte integrada ocupava a rede interna;
repetidas após o término da integração, exits 0. Logs de tentativas em
`/tmp/feature005-t063-{provision,provision2,unit,contract,unit-docker-summary,contract-docker-summary,migrated-summary,schema}.log`.
Nenhuma vulnerabilidade de produção foi comprovada nesta execução; apenas o
guard do harness foi corrigido. Nenhum volume antigo foi apagado, nenhum
deploy/commit/push/PR ou T064–T066 executado.

---

# Histórico — revisão de segurança da branch (2026-11-19)

Escopo: revisão do código e suites unitárias/contrato/HTTP real no run
`db1126fff37e`, não certificação de produção. O gate depende de T061/T062;
nenhum teste skipped é usado como evidência. Falhas dos primeiros runs e a
última execução estão individualizadas em `final-review.md`.

| Superfície                                                | Evidência                                                                                                                                                                                   | Limite                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Sessão, Origin, CSRF, tipo de ator                        | `us1-http`, `permissions`, `publication-portal`, `replacement`, `deletion-recovery`; auth compartilhada duas vezes antes do handler mutável                                                 | Mudanças de sessão já em stream não recolhem bytes enviados                                                     |
| Ownership, membership, seis permissões, gestão admin-only | `authorization-matrix`, `authorization-races`, `permissions`; grants efetivos rechecados em transação                                                                                       | Isolamento comercial não concede OS/estoque                                                                     |
| URLs antigas/Range, revogação, stream/abort               | `us2-stream`, `transport-matrix`, `authorization-races`, `replacement`, `deletion-recovery`                                                                                                 | Download apenas attachment; não há viewer inline                                                                |
| Bucket/DTOs/chaves                                        | Preflight remoto do manifesto (bucket anônimo 403); `us1-http`, contratos de transporte, allowlists, MinIO sem presigned URL                                                                | Credenciais fora do Git e nenhum PDF em resposta de erro                                                        |
| qpdf                                                      | `runtime`, `resource-pressure`, `validator-observation`, testes de contrato e fixtures reais: assinatura/tamanho, password/check, warnings, crash, timeout/ausência; sem PUT aceito em erro | Validação estrutural não é antimalware; RSS por watchdog não é cgroup filho                                     |
| Reprodutibilidade                                         | Dockerfile Node22 digest e qpdf12.3.2-r0 pinados; preflight do runner verifica imagem, recurso e qpdf                                                                                       | Dockerfile ainda não fixa `USER` não-root; UID1000/read-only é do runner de integração, não default de produção |

Antes do deploy, definir usuário não-root e permissões de filesystem/tmpfs,
fornecer segredos em canal protegido, cgroup/limites dos serviços e supervisor
que consume eventos sanitizados `budgetCleanupBacklogOverOneHour` e
`budgetCleanupTenErrors`; validar monitoramento/restart/backup com operador.
Nenhum desses controles foi declarado ativo em produção. Falha de segurança
no gate de testes bloqueia habilitação; testes verdes não substituem a
aprovação operacional pré-produção.
