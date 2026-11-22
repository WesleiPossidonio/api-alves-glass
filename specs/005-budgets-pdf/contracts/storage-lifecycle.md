# Contrato de consistência PostgreSQL / MinIO

**Plataforma vinculante**: PostgreSQL 17 é a única versão suportada. Em produção, registry e slots residem no banco principal compartilhado pelos módulos da API, em uma única instância lógica principal; não há banco/instância exclusivo de orçamentos. T021 prepara somente PostgreSQL 17 e MinIO temporários e isolados para testes. Aplicação de migrations da API e execução completa do lifecycle/worker permanecem posteriores, em T022 autorizado.

**Natureza**: protocolo planejado, não código. Raiz: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.

## Invariantes

1. Somente slots confirmados em budgets_pdf autorizam leitura; clientes só slot publicado vigente e ownership. Registry não é autorização.
2. Toda chave é gerada pelo servidor, imutável, privada e nunca reanexada depois de retirada. Prefixo `budgets-pdf/{budgetUUID}/{objectUUID}.pdf`; sem nomes/clientes/número na chave.
3. Cada slot PDF/data é indivisível. Publicação não muda bytes no objeto; move a referência pendente para publicado.
4. PUT só começa após intenção durável. DELETE só ocorre após desanexação confirmada; cleanup não segue cascade do orçamento.
5. Sem chamada MinIO dentro da transação principal de escrita, exceto stream autorizado e cleanup com lock próprio limitado. Não prometer transação distribuída/exactly-once.
6. G-PDF fechado: antes de qualquer PUT, exigir tamanho até 10 MiB, assinatura PDF, sondagem --requires-password sem senha exigida e --check=0. Código 3 da sondagem não é warning; código 3 de --check é rejeição. Falha/timeout/ausência do qpdf falha fechada sem objeto utilizável; detalhes/limites e limpeza de temporários em research.md.

## Locks e revisão

Ordem global: guards de autorização ordenados por chave → row locks de User/UserSector em ordem determinística quando aplicável → advisory de orçamento → linha budgets_pdf → objetos em ordem UUID. Registry de objeto ausente de pai usa identidade reservada; worker nunca adquire locks de autorização, começa no guard de orçamento e depois objetos. Operações que tocam dois setores bloqueiam guards origem/destino em ordem e exigem CREATE_EDIT nos dois.

Advisory de orçamento: exclusivo para criação/mutação/cleanup, compartilhado para leitura. Linha FOR UPDATE para escrita, FOR SHARE para stream. READ COMMITTED e nova leitura após obter locks; dados lidos antes do lock não autorizam commit. Revisão esperada obrigatória por If-Match; stale é 412, não sobrescrita last-writer-wins silenciosa. UUID novo por tentativa de upload; conflito gera objeto órfão recuperável, não perde o candidato anterior.

## Cadastro

1. Autenticar/CSRF e autorizar CREATE_EDIT; validar tamanho/assinatura/estrutura com qpdf, incluindo sondagem de senha separada e check sem erro/aviso; calcular hash/size dos mesmos bytes em temporário privado; reservar budget UUID e object UUID. Encerrar o subprocesso antes de apagar temporário; limpar em sucesso, erro, timeout ou desconexão. Nenhum PUT se validação falhar, e nenhuma reparação/reescrita dos bytes.
2. Transação curta: revalidar ator/setor/cliente, criar registry UPLOADING com token/lease e chave única; commit. Nenhum orçamento comercial existe ainda.
3. PUT privado com content-type fixo, deadline e heartbeat. Confirmar statObject e tamanho; hash corresponde aos bytes enviados, sem inferir ETag como SHA. Se PUT/stat inconclusivo, não anexar; registry permite recuperar.
4. Transação: locks globais, revalidar sessão/ator/concessão e cliente/setor; exigir registry UPLOADING, token corrente e lease válida. Tornar READY e inserir budgets_pdf completo com pending/data, revision 1 e autor da sessão; tornar objeto ATTACHED na mesma transação. UNIQUE decide duplicatas concorrentes.
5. Sucesso 201 só após commit. Falha de validação não faz PUT. Falha PUT/commit transforma objeto em limpeza ou deixa lease expirar se banco indisponível. Timeout de resposta após commit: cliente consulta pelo setor/número, não reenvia cegamente; UNIQUE impede duplicar orçamento. Nenhuma chave de idempotência não implementada é prometida.

## Substituição de pendente

1. Exigir REPLACE_PDF e If-Match; se altera validade, CREATE_EDIT também. Consultar snapshot sob autorização, validar arquivo; nova intenção durável com expected_revision e validity_date efetiva.
2. PUT/stat sem alterar slots. O objeto publicado e o pendente anterior não são sobrescritos nem apagados.
3. Anexação transacional com locks, CAS da revisão, lease/token/estado e nova verificação de autorização/ausência de exclusão. Se falhar, anterior intacto e novo objeto elegível para recuperação.
4. Confirmar novo pendente/data e incrementar revision; antigo pendente torna-se CLEANUP_PENDING na mesma transação. No máximo um pendente vigente. Falha de cleanup não reverte essa troca e não afeta publicado.
5. Dois uploads baseados na mesma revisão: um commit vence, outro 412 e cleanup; o perdedor pode reenviar após consultar estado atual. Não há publicação automática nem coleção histórica.

## Correção administrativa e primeira publicação

Nome/identidade antes da primeira publicação: CREATE_EDIT + locks/revisão. Mudar setor exige acesso origem/destino, UNIQUE no destino e objeto continua associado ao UUID, não à chave setorial. Ajustar validade inicial sem PDF novo permitido somente antes da primeira publicação e com candidato existente. Depois da primeira publicação, alterar validade exige substituto com PDF novo (mesmo que os bytes sejam iguais, o envio deve ocorrer).

Publicar: PUBLISH, If-Match e candidato ATTACHED com bytes já confirmados; nenhum novo PUT. Sob locks, validar metadados/objeto e trocar publicado/data pelo candidato/data, limpar pendente/data, fixar first_published_at só na primeira vez, incrementar revisão e marcar anterior CLEANUP_PENDING. Se transação falhar, publicação anterior permanece. Se objeto desaparecer fora do protocolo, não publicar; retornar 503/erro operacional, sem fallback público.

## Exclusão definitiva

DELETE + If-Match + confirmação de UUID. Sob lock exclusivo revalidar autorização, reunir todos os objetos registrados para owner_budget_id, marcar elegíveis CLEANUP_PENDING inclusive uploads em curso, invalidar seus tokens; remover budgets_pdf fisicamente na mesma transação. Referência cliente desaparece no commit. Registry sem FK dependente preserva limpeza e uploads tardios. Se falhar antes do commit, nada removido nem DELETE externo realizado.

Resposta 202 indica remoção comercial efetivada e limpeza física em andamento, nunca restauração possível. Repetição do DELETE de registro ausente devolve 404 e não ressuscita nada. Cleanup não expõe conteúdo/versões. Não anunciar remoção física concluída antes de ausência confirmada. Objetos de uploads ainda em trânsito continuam reconciliados mesmo que um DELETE externo anterior não tenha encontrado bytes.

## Streaming privado e revogação

1. GET de slot atual, sessão válida, role/membership/grants ou ownership + publicado. Não aceitar bucket/key/token externos. READ permite todos do setor, sem filtro por autor.
2. Obter locks compartilhados e revalidar referência/autoridade após lock; usar getObject/getPartialObject para Range. Header pode indicar revision, nunca chave. Não liberar transação antes do término/abort se sua garantia depende dos locks.
3. Limitar duração 60 s e conexões concorrentes; escrita/revogação comercial aguardam guard exclusivo ou retornam operationBusy sem commit. Depois do commit de troca/exclusão, pedido novo só pode obter novo publicado ou 404, mesmo usando URL antiga.
4. Sessão/membership externos revogados durante stream não recolhem bytes já autorizados; nova requisição sempre revalida. Nenhuma alteração no módulo auth/003 é pressuposta para cancelamento retroativo.
5. Download exclusivamente autenticado: Content-Disposition attachment, Content-Type application/pdf e filename UUID sanitizado; sem seletor de inline. Viewer adiado, gate anterior não aprovado. Cache-Control private,no-store,max-age=0; Vary Cookie; nosniff; CSP sandbox. Sem redirect/presigned URL/304 compartilhado. Não registrar URL secreta. Falha antes dos headers → 503; falha durante bytes → abortar conexão, não enviar JSON misturado nem outro documento como fallback.

## Worker e recuperação

Worker é modo do mesmo projeto e não recebe comandos comerciais via HTTP. Registry constitui fila técnica durável: claim CLEANUP_PENDING com SKIP LOCKED, lease_token e attempts; commit da reivindicação. Sob lock de orçamento/objeto, revalidar token e ausência nos dois slots antes de removeObject, I/O limitado e heartbeat. Sucesso/not-found confirmado → REMOVED por CAS. Falha → retry com backoff; token antigo não conclui lease novo. Sem apagar arquivo referenciado mesmo que job esteja malformado.

UPLOADING expirado: sob mesmos locks, invalidar token e marcar limpeza somente se não referenciado. PUT que terminar tarde não consegue anexar por fencing. Como timeout cliente não prova interrupção remota, reconciliador preserva registry terminal e verifica objetos reaparecidos; reencaminha DELETE sem torná-los anexáveis. Chave nunca é reutilizada. Rodar reconciliação paginada por prefixo dedicado, não bucket inteiro, com 24 h de graça para objeto desconhecido. Unknown object vira registry técnico/cleanup somente após confirmar que não é referenciado nem intenção ativa.

Ausência de objeto referenciado é incidente: servir 503 privado e alertar; não reconstruir conteúdo do PDF nem expor pendente automaticamente. Worker sem disponibilidade afeta limpeza eventual, não ownership. Nenhum compartilhamento com defaults de Material; MinioCleanupService atual não protege slots de orçamento.

## Matriz de falhas

| Fronteira                           | Resultado seguro                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| Validação falha                     | Sem intenção anexável/PUT                                                           |
| Intenção commit falha               | Não enviar bytes ao MinIO                                                           |
| PUT conclui, processo cai           | Registry/lease recupera órfão                                                       |
| PUT termina após timeout/DELETE     | Fencing nega anexação; reconciliação remove objeto tardio                           |
| CAS/UNIQUE falha                    | Estado anterior intacto, objeto novo sob cleanup                                    |
| Publicação commit falha             | PDF/data anteriores mantidos                                                        |
| Cleanup do pendente anterior falha  | Novo candidato privado intacto e publicado inalterado                               |
| Cleanup do publicado anterior falha | Novo publicado vigente; antigo não autorizável                                      |
| Exclusão commit falha               | Não houve DELETE externo; orçamento anterior consistente                            |
| Exclusão commit ok, MinIO falha     | Cliente recebe 404; limpeza durável permanece                                       |
| Worker morre após removeObject      | Retry/not-found + token CAS, sem efeito duplicado comercial                         |
| Stream concorre com exclusão        | Stream anterior termina/aborta antes do commit exclusivo; depois não há novo acesso |

Não há retenção de versões, lixeira, aprovação comercial, ES ou CQRS. Sem política de expurgo técnico arbitrária que perca recuperação.
