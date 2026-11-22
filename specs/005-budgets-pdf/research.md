# Research — Feature 005

**Data**: 2026-11-17. Decisões de desenho, não evidência de funcionamento.
**Raiz dos caminhos locais**: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.

## Evidências locais

Budget model/controller/service/repository existem, mas apenas POST /budged está registrado. Atualização escreve campos não mapeados; service ignora repository; criação admite PDF/cliente opcionais e exige descrição/total. Nenhuma chamada real do legado foi executada.

Client global pode ser consultado por ID com projeção segura, mas seus fluxos legados de cadastro/atualização/busca têm inconsistências; não criar outro cadastro nem pressupor funcionamento. DTO não retorna password_hash, google_id ou update_number. Usuários têm admin/user; UserSector existe. auth.js verifica sessão/JWT/cookies/CSRF; casos de uso acrescentam status ativo, concessões e ownership. Grants de OS não são grants comerciais.

StorageService.upload usa MINIO_BUCKET legado e não valida PDF. getPrivateUrl não oferece revalidação posterior de ownership. MinioCleanupService usa defaultReferenceCheck somente para Material; repositories de jobs/intents não demonstram fencing suficiente para upload tardio. Enqueue faz find-then-create sob unique parcial; updates de conclusão não exigem token de lease. Reutilizar esses defaults para orçamento seria inseguro e alteraria 003. Reutilizar cliente MinIO, convenções de injeção e padrões de locks, com registry/worker de orçamento próprios.

Decisão arquitetural vinculante: somente PostgreSQL 17. Produção mantém uma única instância lógica principal e banco compartilhado por todos os módulos, incluindo budgets_pdf e budget legado; nenhuma instância ou banco adicional para orçamentos. Isolamento descartável é exclusivo dos testes. A referência divergente na Constituição não define uma matriz de versões para esta feature. Imagem usa Node 22 Alpine. Bibliotecas confirmadas em package.json: Express, Sequelize, pg, MinIO, Multer, Yup, JWT. Na inspeção do planejamento, qpdf não estava disponível; agora sua integração foi expressamente aprovada pelo responsável, sem instalação nesta execução. Não foi consultado ambiente real de banco/bucket.

## DT-01 — Arquivos PDF

**Decisão técnica**: limite 10 MiB (10 _ 1024 _ 1024 bytes), um arquivo não vazio; corpo multipart até 11 MiB, campos limitados/allowlist. Confirmar estrutura efetiva, tamanho e SHA-256 dos bytes antes de PUT. Não confiar apenas em assinatura, MIME ou extensão; não reparar, reescrever ou extrair conteúdo comercial. Nome original não entra na chave do objeto.

**G-PDF FECHADO — decisão aprovada**: utilizar qpdf como dependência de sistema da imagem da API. Validar tamanho, assinatura `%PDF-` no início do arquivo e estrutura efetiva. Rodar separadamente `qpdf --requires-password` e `qpdf --check` no mesmo arquivo temporário fechado para escrita, sem senha fornecida e sem saída PDF. A etapa de senha é classificatória, nunca prova estrutural. Documento rejeitado não gera PUT, READY, ATTACHED ou publicação. Não reparar/reescrever os bytes nem interpretar conteúdo comercial.

| Processo            | Saída         | Interpretação/ação                                                                                       |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| --requires-password | 0             | Exige senha: rejeitar 422 passwordRequired                                                               |
| --requires-password | 2             | Não criptografado: prosseguir para --check, NÃO aceitar ainda                                            |
| --requires-password | 3             | Criptografado abrível sem senha fornecida: prosseguir para --check; NÃO confundir com warning de --check |
| --requires-password | 1/outro/sinal | Falha controlada, nunca sucesso; 503 validatorFailed                                                     |
| --check             | 0             | Sem erro/aviso estrutural; elegível somente se todas as outras validações passaram                       |
| --check             | 2             | Erro estrutural: 422 invalidPdf                                                                          |
| --check             | 3             | Avisos/recuperação: 422 invalidPdf; não aceitar reparado                                                 |
| --check             | 1/outro/sinal | 503 validatorFailed; sem arquivo utilizável                                                              |

Códigos de senha 2/3 também podem acompanhar entrada problemática: a segunda etapa é obrigatória e impede aceitar só pela sondagem. Não usar --warning-exit-0, --no-warn, --replace-input, senha/argumentos fornecidos pelo cliente ou arquivo de argumentos @. A documentação oficial versionada 12.2 descreve essas semânticas; versão de distribuição escolhida deve demonstrá-las com fixtures, não apenas satisfazer comparação numérica.

**Execução segura e limites**: node:child_process spawn/execFile com shell:false, executável absoluto configurado pelo servidor (/usr/bin/qpdf na imagem), argv fixo com caminho absoluto aleatório controlado; stdin fechado, env mínimo, sem herdar opções controláveis pelo usuário. Diretório mkdtemp 0700, arquivo exclusivo 0600, nome original ignorado; validar/hash/enviar exatamente os mesmos bytes, sem aceitar troca de caminho/symlink. Diretório de temporários limitado a 64 MiB por processo, arquivo individual <=10 MiB e até duas validações simultâneas. Timeout agregado de 10 s para ambas etapas, kill com escalada para SIGKILL e espera do término, inclusive desconexão; saída limitada a 64 KiB por canal/processo e falha fechada no excesso. Limite inicial de RSS do filho 256 MiB monitorado por watchdog Linux (/proc, 50 ms), com kill/falha no excesso; imagem/ambiente de ensaio deve fornecer limite cgroup de 512 MiB, 1 CPU e 64 PIDs como proteção dura global. Watchdog não equivale a limite duro de memória por filho; ensaiar overshoot e não habilitar sem contenção global demonstrada. Limite agregado de tempo também limita CPU consumível sem introduzir shell/ulimit. finally limpa temporários em todo resultado; varredura de resíduos no startup usa prefixo dedicado/idade/ausência de lease e nunca remove upload ativo. Limites são técnicos iniciais, sujeitos a ensaio, não SLO comercial.

**Docker e disponibilidade**: instalar qpdf por pacote de sistema na futura alteração de /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/docker/dockerfile, fixando versão exata/revisão e base Alpine/digest compatíveis na implementação. Piso de compatibilidade planejado: qpdf 12.2, com ensaio obrigatório das duas matrizes de saída e --version; não usar latest/flutuação como garantia. A revisão exata do pacote é resolução reproduzível da tarefa de imagem, não reabertura do G-PDF. Se repositório da base atual não a oferecer, revisar tag Alpine mantendo Node 22 e demais dependências/regressões, sem download não verificado. Smoke de build e preflight na API/worker verificam executável/versão; indisponível/incompatível bloqueia habilitação de uploads, sem derrubar endpoints 003/004 por acoplamento novo. ENOENT/EACCES → 503 validatorUnavailable; timeout → 503 validatorTimeout; crash/exit inesperado/output/resource limit → 503 validatorFailed; estrutura inválida/avisos → 422. Diagnóstico correlacionável sem stdout/stderr bruto ou conteúdo em logs/respostas. Não instalar, buildar ou modificar Docker nesta etapa documental.

Validação estrutural não garante ausência de malware. Recursos ativos não são executados no backend; inline exige sandbox/CSP e ensaio dos viewers antes de release. PDF criptografado abrível sem senha pode ser aceito se --check retornar 0; não exigir política extra de bloqueio total de criptografia ou sanitização não aprovada. Nenhuma mudança na publicação, substituição, exclusão ou acesso privado.

Alternativas rejeitadas: magic bytes somente não é validação estrutural; parser artesanal não é justificado; geração/sanitização automática muda o documento aprovado. 10 MiB é escolha técnica agora explícita, não inferência de que o legado já a aprovou.

## DT-02 — Textos, comparação e data

Número: 1..64 caracteres Unicode, comparação exata case-sensitive com collation C, sem cast numérico, trim/casefold/NFC silenciosos. Rejeitar controles U+0000..001F/U+007F e espaços externos; preservar espaços internos e zeros. `001`/`1`, `Ab`/`ab` e variantes Unicode são distintos. UNIQUE(setor,número). Nome: 1..240 caracteres, sem controles ou branco puro, persistido sem HTML escape; saída JSON segura e headers sem interpolação insegura.

Data YYYY-MM-DD, ano 0001..9999 e calendário válido, sem horário/offset; PostgreSQL DATE e Sequelize DATEONLY. Vencido = validityDate < dia corrente em America/Sao_Paulo calculado por partes Intl.DateTimeFormat, não por UTC do servidor. Data passada aceita. Documentar/testar limite de caracteres Unicode e bytes do transporte.

Alternativas: número numérico perde zeros; comparação normalizada inventa equivalências; timestamp introduz fim de dia ambíguo. Comparação exata não determina significado comercial extra.

## DT-03 — Entrega, concorrência e limpeza

Streaming na API, via cliente MinIO getObject, sem URL/ACL pública. Cada GET/Range verifica sessão, concessão/ownership e referência publicada atual; nunca servir por chave recebida do cliente. Headers no-store/private, Vary Cookie, nosniff, CSP sandbox; não devolver 304 que reaproveite autorização antiga.

Revogação: stream mantém locks compartilhados de autorização e linha de orçamento durante no máximo 60 s, com abort/desconexão liberando tudo. Publicação/exclusão/revogação comercial adquirem locks exclusivos correspondentes antes do commit. Stream anterior termina antes da mudança confirmar; leitura bloqueada reconsulta estado após obter lock. Escrita com lock timeout 5 s retorna 409 operationBusy sem commit. Sessão/membership/status são revalidados a cada pedido; bytes já transmitidos não são recolhidos. Locks externos de autenticação/003 não são alterados: perda de membership ou sessão impede a próxima requisição, sem alegar corte retroativo do stream já autorizado.

Transações READ COMMITTED, row locks + advisory locks por recurso com ordem global e revision bigint/If-Match. Chaves de objeto imutáveis e sem reanexação após retirada. Registry próprio com intenção durável antes do PUT, CAS/fencing e cleanup persistente depois de desanexar. Executor do mesmo projeto usa SKIP LOCKED, lease_token e retry. É outbox técnica de efeitos externos, não eventos comerciais ou mensageria. Falha de processo exige persistência, não apenas catch e delete best-effort.

Rejeitadas: URL pré-assinada segue válida após exclusão; DELETE no MinIO antes do commit pode perder o publicado; ES/CQRS/broker não têm necessidade; limpeza de Material não verifica referências comerciais. Protocolos em contracts/storage-lifecycle.md.

## DT-04 — Compatibilidade HTTP

Novos contratos /budgets e /client/budgets com camelCase/allowlist estrita. POST /budged passa a 410 Gone autenticado/CSRF/admin, antes de Multer e sem PUT, código legacyBudgetEndpointRetired e successor /budgets; sem redirect de corpo multipart. Não manter cadastro incompleto antigo. Ativação somente após comunicação/inventário de consumidores e atualização autorizada, não comprovados neste backend. Se compatibilidade temporária for exigida, nova revisão explícita de contrato; não presumir adaptador. Demais rotas 003/004 intocadas.

## DT-05 — Legado e preservação

Criar tabelas novas canônicas, manter tabela budget antiga intacta como quarentena técnica fora das APIs novas. Não copiar description_budget/total_value para novos registros nem apagar seu histórico original nesta entrega. Registro novo sempre completo, sem constraints condicionais que disfarcem dados ausentes. Arquivos antigos não são varridos pelo worker novo.

Inventário futuro autorizado inclui UUIDs, cliente ausente, datas/offsets, autoria, número/setor não existentes, bucket/chave/ACL, contagem e checksum. Data civil só pode ser derivada quando semântica original conhecida; ambíguos exigem revisão. Sem autor histórico comprovado, não inventar autor/importar; permanece quarentena. Importação futura é idempotente, com mapeamento aprovado, mesmos UUIDs quando possível, sem publicação automática e com relatório antes/depois. Não criar endpoint comercial de reconciliação nesta feature.

FK Client/Sector/User novos: RESTRICT, impedindo transformar cliente obrigatório em NULL. Não modificar os contratos desses módulos; regressões devem verificar conflito quando cadastro referenciado é removido. Dados pessoais de Client não são copiados. Privacidade de bucket legado desconhecida: caso inventário mostre exposição, gate de remediação autorizada antes de incorporação, sem mudar ACL compartilhada silenciosamente.

Rollback de expansão não remove dados novos: bloquear escrita/publicação, preservar entrega autorizada ou negar de forma segura e continuar limpeza; backup e reconciliação antes de restaurar dados. Nunca reativar endpoint inseguro nem executar down destrutivo se tabelas/registry não vazios. Retenção de backups não é lixeira comercial e depende de governança existente.

## DT-06 — Operação

Valores técnicos iniciais para ensaio: lista keyset 25/100; cursor HMAC vinculado a ator, escopo, filtros e ordem, TTL 15 min. Upload total 60 s, validação 10 s, chamada MinIO 30 s, stream 60 s, lock de escrita 5 s. Limites por processo: 2 uploads/validações e 4 streams, 429/Retry-After ao exceder; ajustar pool para reservar conexões sem bloquear autenticação. Não prometer capacidade distribuída por usuário sem componente existente.

Upload lease 2 min com heartbeat e fencing; worker lote 25, polling 5 s, lease 2 min, backoff 5 s exponencial até 1 h + jitter. Alertar após 10 erros/idade >1 h, sem desistência silenciosa. Reconciliar prefixo paginado a cada 24 h, graça 24 h para objeto sem registry; nunca bucket inteiro. Registry terminal preserva chave técnica para detectar PUT tardio, sem conteúdo ou versão consultável; purga só após política segura aprovada. Worker parado não expõe arquivos, mas impede habilitação inicial e gera backlog/alerta.

Instrumentar intents vencidas, idade/backlog, remoção, timeouts e acesso negado sem conteúdo PDF, segredos, cookies ou URLs de acesso. SLO de negócio/volume não foi aprovado e não é inventado.

## Fontes primárias verificadas

Referências em código para consulta posterior:

```text
https://www.postgresql.org/docs/17/explicit-locking.html
https://github.com/minio/minio-js/blob/master/docs/API.md
https://qpdf.readthedocs.io/en/12.2/cli.html
```

PostgreSQL documenta locks de linha/advisory transacionais; API MinIO documenta get/stat/remove e streams; qpdf documenta --check, códigos distintos de --requires-password e limitações de validação. Limites/protocolos são decisões deste plano. Pacote exato será fixado e comprovado no build futuro, sem instalar latest implicitamente.

## Pendências e consequências

G-PDF fechado por aprovação explícita do responsável: qpdf obrigatório, sem alternativa silenciosa ou aprovação técnica pendente do componente. DT-01 a DT-06 continuam coerentes. Sem nova pendência funcional ou técnica bloqueante de decomposição. Fixar revisão exata do pacote, ensaiar recursos/inline, inventariar legado e validar bucket são trabalho de implementação/gates de release rastreados em tasks.md, não decisões a presumir. Mudança de política de recursos ativos, compatibilidade temporária ou importação de autoria desconhecida requer revisão expressa.

## Validação documental realizada

No planejamento anterior foram verificados os seis documentos, 42 RF e ausência de código alterado; havia 24 itens satisfeitos e G-PDF aberto. Nesta etapa, a decisão aprovada fecha o gate e fundamenta tasks.md; checklist final e validação documental distinguem trabalho planejado de executado. Não executados testes de aplicação, integração, migrations, serviços ou containers. Consulta oficial qpdf versionada realizada para semântica de senha/check; não afirma versão instalada.
