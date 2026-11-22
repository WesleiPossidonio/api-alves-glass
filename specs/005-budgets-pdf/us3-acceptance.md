# Checkpoint US3 — edição e substituição

## Estado

Data: 2026-11-18. **US3 ACEITA — pronta para iniciar US4.**
G1, US1 e US2 permanecem aceitos. T047 não iniciada.

| Tarefa | Estado e evidência                                                             |
| ------ | ------------------------------------------------------------------------------ |
| T040   | Concluída: unidades de edição/substituição red-first e verdes                  |
| T041   | Concluída: contratos de transporte, HTTP real e runner contract                |
| T042   | Concluída: edição autorizada, imutabilidade, referências/UNIQUE/CAS            |
| T043   | Concluída: substituição com qpdf, intenção, confirmação, fencing e compensação |
| T044   | Concluída: PATCH/PUT no router existente, sessão/CSRF/Origin/ETag              |
| T045   | Concluída: nove testes US3 no migrated, PG17/MinIO reais                       |
| T046   | Concluída: checkpoint, regressões, documentação e validações finais            |

## Migração operacional e isolamento

Os três scripts Python foram comparados com as versões Node.js ESM existentes
na worktree, completadas e validadas antes da remoção dos originais:

- `provision-isolated.js`: opt-in explícito, branch, imagens locais pinadas,
  colisões, novos recursos apenas, credenciais criptográficas, IAM restrito,
  rede interna, limites Docker e recibos PostgreSQL/MinIO.
- `verify-resources.js`: mesmos checks de IDs/imagens/labels, rede exclusiva,
  volumes, portas, memória/swap/CPU/PIDs, restart e no-new-privileges.
- `operational-runner.js`: preflight local antes de sockets; identidade remota,
  códigos 20/21/22, sinais, logs privados e schema por opt-in em banco vazio.
- `operational-common.js` e `iam-zip.js`: APIs nativas, subprocessos sem shell,
  ZIP STORE/CRC32 sem biblioteca ou executável adicional.

Equivalência demonstrada por comparação das verificações, cinco testes Node
(incluindo matriz de adulteração de todas as verificações Docker originais),
provisionamento/recibos reais, importação IAM aceita pelo MinIO e aplicação real
da cadeia Sequelize. Não se alega execução comparativa dos originais Python;
nenhum Python/pip foi executado ou instalado nesta retomada. Nenhum outro script
Python operacional encontrado na Feature005. Referências antigas nos relatórios
de execuções aceitas são históricas, não comandos vigentes.

Run autorizado novo: **db1126fff37e**. Raiz privada persistente:
`/home/wpossidonio/.local/state/alves-glass/integration/feature005/db1126fff37e/`.
Manifesto `resources.json`, recibos/credenciais próprios, diretórios 0700 e
arquivos 0600. PostgreSQL 17.11, MinIO privado e qpdf 12.3.2. Imagem
`alves-glass-api:feature005-qpdf-20261117040200-verified`, digest
`sha256:9df6780832b95564d1a5ed153eebbf36bdce8b2ef12e0f295614a977134d7440`.
Yarn Classic 1.22.22; código atual montado sobre dependências da imagem.

Preflights: IDs Docker/labels/rede/volumes conferidos, rede interna, nenhuma
porta publicada, credenciais SQL sem privilégios administrativos, recibo SQL
não gravável pelo app, acesso anônimo MinIO403, prefixo limitado, política não
alterável pelo app, credencial incorreta negada. Schema preparado exclusivamente
no novo banco pelas migrations aceitas, sem alterações ou fresh/upgrade.
Logs em `t022-ops-2854ab5e680f` sob a raiz privada acima.

Tentativa anterior desta execução: `9482f980cf7d` parou antes de criar recursos
Docker; seus artefatos privados foram preservados. A mensagem Docker de rede
ausente não era reconhecida. Corrigida a detecção com nome exato e exit1; erros
de daemon e colisões continuam bloqueando. Nenhum recurso dos runs antigos foi
acessado/reutilizado/modificado nesta execução.

## Implementação

Raiz de código:
`/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/`.

- `src/app/services/BudgetPdfEditService.js`: allowlist, validações, CREATE_EDIT
  origem/destino, locks, UNIQUE, CAS, proteção de autoria e primeiro marco.
- `src/app/services/BudgetPdfReplacementService.js`: REPLACE_PDF; CREATE_EDIT
  adicional apenas quando muda validade; herança pendente/publicada na revisão;
  qpdf e limite existentes, intenção durável, PUT/stat, reautorização, fencing,
  anexação atômica e compensação durável, sem DELETE físico no serviço.
- `src/app/controllers/BudgetPdfController.js` e
  `src/app/meddleawares/budgetPdfHttp.js`: PATCH e PUT nos caminhos contratuais;
  requireUser, sessão/cookie, Origin/CSRF antes do multipart, If-Match e ETag,
  respostas mínimas sem READ implícito. Mount existente em `src/routes.js`
  reutilizado sem mudança no legado/003/004.
- Publicação usa BudgetPdfPublishService inalterado; download autenticado
  attachment-only, sem inline, URL pública ou histórico consultável.

Antes da publicação: correções de cliente/setor/número/nome/validade inicial.
Depois: cliente/setor/número bloqueados; nome editável; validade só via novo PDF.
No máximo publicado e pendente; candidato antigo só desanexado no commit do
novo, publicado não alterado pelo upload. Worker preserva referências e remove
apenas elegíveis, com retry recuperável.

## Evidência US3

Testes T040/T041 executados inicialmente: 8 falhas, por serviços/métodos ausentes;
após implementação: 8 aprovações. Falhas de import não são evidência de aceite.

Integração real em
`tests/integration/budgets/replacement.integration.test.js`, adicionada ao
runner migrated. Usa repositórios, PostgreSQL17, MinIO, qpdf, sessão e HTTP reais.
Injeções limitadas às fronteiras de falha/barreiras; não há mocks apresentados
como integração. Confirmação falha após PUT real; rollback injetado após CAS e
enqueueDetached reais. Snapshots completos e SHA-256 HTTP provam preservação.

Cobertura: correção privada e duplicidade, autorização de ambos setores,
revisão428/412, mass assignment, identidade409, validade409, nome permitido,
permissões independentes, PDF obrigatório/10MiB/qpdf aviso/senha, falhas PUT/stat,
rollback, revogação durante upload, membership/status, CSRF/Origin/sessão,
publicado A disponível durante upload, B→C sem expor candidato, cleanup com
falha/retry, publicação manual PDF/data e novo download, dois uploads e corridas
edição/publicação, restart SIGKILL/novo PID, leitores ativos protegidos por locks.

## Resultados

- Unitários finais: 127/127, zero falhas/skips/TODO, Yarn exit0.
- Contratos finais: 11/11, zero falhas/skips/TODO, Yarn exit0.
- Regressões auth/OS/configuração/persistência/estoque: 231/231, exit0.
- Integração focada anterior à adição do cenário de leitores ativos: 8/8.
- Runner migrated final: **102/102**, zero falhas/skips/TODO/cancelamentos,
  exit0; inclui **9/9 US3** (oito subtestes e teste-pai), leitores ativos e
  restart real. Log `t022-ops-41d8f242b99d/migrated.log`, exit persistido no
  mesmo diretório, preflight0 e resumo `migrated-final-summary.log`.
- `node --check` aprovado nos 15 arquivos JavaScript desta entrega.
- Prettier dos arquivos desta entrega e `git diff --check`: aprovados.

Logs unit-final/contract-final/regressions-final/us3-focused-final e respectivos
arquivos `.exit` sob a raiz privada do run. Contagens não somam reruns nem os
testes T041 executados por ambas as suítes.

## Defeitos e tentativas não verdes

1. Mensagem de ausência de rede Docker não reconhecida: corrigida com regressão
   fail-closed, sem relaxar colisões ou autorização.
2. Primeiro comando de regressões omitiu o mount do arquivo
   `.env.persistence-containers.example`: 230/231. Corrigido apenas o harness,
   sem mudar testes/código compartilhados; rerun231/231.
3. Primeiro migrated: injeção stat não atingia o método porque um teste anterior
   restaurava upload já vinculado ao storage original. Corrigida restauração
   do método não vinculado; teste de confirmação real passou no rerun focado.
   Log histórico `t022-ops-350439e8795d/migrated.log` preservado, não é aceite.

## Limites

Sem instalação host, mudança de permissões node_modules, migrations alteradas,
versionamento, mudanças em Features003/004/legado, acesso à produção, deploy,
commit, push ou PR. Originais Python removidos só após validação de equivalência.
Recursos novos preservados para reprodução; nenhuma ação sobre runs anteriores.

Todos os critérios obrigatórios T040–T046 foram atendidos. Não há bloqueio
remanescente para iniciar US4; sua implementação exige a próxima etapa e não
foi iniciada nesta entrega.
