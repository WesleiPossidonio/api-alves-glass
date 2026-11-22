# Feature Specification: 005 — Gestão de Orçamentos em PDF

**Feature Branch**: `feature/005-budgets-pdf`
**Created**: 2026-11-17
**Status**: Especificação funcional consolidada com as decisões aprovadas pelo responsável; sem decisões funcionais pendentes. Definições técnicas para o planejamento isoladas na seção 10. Não autoriza planejamento técnico ou implementação automática.
**Input**: Requisitos aprovados de cadastro setorial, publicação manual de PDF privado, substituição sem versionamento, validade civil, exclusão definitiva e permissões comerciais.
**Base Git**: master remota confirmada em `f89fce5570af6125657bf67ced5a14ad8a1f7db4`, merge da Feature 004.

## 1. Resumo e governança

Gerenciar documentos de orçamento preparados fora desta API. Usuários internos autorizados cadastram metadados administrativos, mantêm um PDF privado e decidem manualmente quando disponibilizá-lo ao cliente global vinculado. O cliente consulta e baixa exclusivamente o PDF publicado, inclusive quando vencido.

Não há interpretação comercial do documento, itens, preços, aprovação/recusa ou conversão para OS. Publicação significa disponibilização de documento, não aceite comercial.

A Constituição vigente é a referência superior. A direção Event Sourcing/CQRS de estoque e OS permanece preservada, mas não é automaticamente estendida a este domínio documental. As afirmações históricas de ausência da Feature 004 em documentos de auditoria não substituem sua especificação e implementação integradas. Persistência segue Sequelize CLI convencional e `public.SequelizeMeta`, sem reintroduzir baseline customizado.

Esta especificação usa a estrutura do template `spec-template` do Spec Kit instalado: histórias priorizadas, cenários de aceite, casos de borda, requisitos, entidades e resultados mensuráveis. O checkout não contém templates/scripts locais; a resolução automática do template falhou. O template oficial instalado foi lido diretamente, sem reinicializar o projeto nem instalar extensões. A checklist registra essa limitação; não se alega execução bem-sucedida de um comando de geração automática.

## 2. User Scenarios & Testing — histórias e critérios de aceite

Os cenários abaixo são critérios para validação futura, não testes implementados ou executados nesta etapa. As histórias podem ser verificadas com dados preparados para cada capacidade, sem exigir a execução sequencial de todas as jornadas.

### US-01 — Cadastrar e consultar orçamento privado (P1)

Como usuário interno autorizado, quero cadastrar e consultar um orçamento do meu setor com cliente global e PDF, sem disponibilizá-lo automaticamente ao cliente.

**Por que esta prioridade**: constitui o núcleo documental sem exposição prematura.
**Verificação independente**: cadastrar orçamento com todos os campos e consultar internamente; nenhuma entrada deve surgir no portal antes da publicação.

1. **Dado** ator autorizado, setor e cliente existentes, **quando** informa número textual `00042`, nome, data civil e PDF válido, **então** o cadastro recebe UUID e autoria da sessão, preserva `00042` e permanece privado.
2. **Dado** número já usado no setor, **quando** duas requisições concorrem pelo mesmo número, **então** não surgem dois orçamentos; o conflito é garantido no PostgreSQL e nenhum arquivo rejeitado fica acessível ao cliente.
3. **Dado** o mesmo número em outro setor, **quando** o ator possui autorização nesse setor, **então** a duplicidade entre setores não impede o cadastro.
4. **Dado** ausência de cliente, nome, número, validade ou PDF, **quando** tenta cadastrar, **então** a operação é rejeitada sem orçamento parcialmente utilizável.
5. **Dado** READ no setor, **quando** consulta orçamentos de autores diferentes, **então** pode consultar todos os desse setor, sem acessar outros setores.

### US-02 — Publicar e acessar no portal (P1)

Como usuário autorizado a publicar, quero disponibilizar o documento por ação explícita; como cliente, quero consultar e baixar apenas os documentos publicados que me pertencem.

**Por que esta prioridade**: entrega o documento ao destinatário com privacidade.
**Verificação independente**: preparar orçamento privado, publicar manualmente e verificar consulta e download com dois clientes distintos.

**Decisão de escopo da Feature 005:** entrega exclusivamente por download autenticado (`Content-Disposition: attachment`). Visualização inline foi adiada para melhoria futura, com gate de segurança próprio; nenhum parâmetro HTTP pode forçá-la. O gate anterior de viewer não é considerado aprovado nem executado.

1. **Dado** documento privado e PUBLISH, **quando** publica, **então** somente após confirmação consistente o orçamento aparece para o cliente vinculado.
2. **Dado** orçamento publicado, **quando** seu cliente consulta a lista, **então** recebe nome, número, setor, validade e indicação válido/vencido e pode baixar o PDF publicado autenticado como attachment.
3. **Dado** outro cliente, usuário sem concessão ou sessão inválida, **quando** tenta acessar por UUID, chave de objeto ou referência anterior, **então** não obtém documento nem acesso ao orçamento indevido.
4. **Dado** documento vencido, **quando** seu cliente consulta ou baixa, **então** o arquivo continua disponível com indicação de vencimento.
5. **Dado** cliente autenticado, **quando** tenta editar, publicar, decidir aprovação/recusa ou excluir, **então** nenhuma dessas operações é permitida.

### US-03 — Corrigir e substituir sem publicação silenciosa (P1)

Como usuário autorizado, quero corrigir dados permitidos e preparar um substituto, mantendo o documento publicado até decidir pela troca.

**Por que esta prioridade**: evita divergências entre conteúdo e validade e indisponibilidade durante a preparação.
**Verificação independente**: partir de orçamento publicado A, enviar B e publicar B; verificar acesso a A antes da troca e somente a B depois.

1. **Dado** orçamento nunca publicado, **quando** corrige metadados com autorização, **então** as correções respeitam cliente/setor existentes e unicidade; alterar setor não pode contornar autorização na origem ou no destino.
2. **Dado** orçamento que já teve primeira publicação, **quando** tenta alterar cliente, setor ou número, **então** a alteração é bloqueada definitivamente, inclusive se houver substituto pendente.
3. **Dado** orçamento publicado A, **quando** envia B com REPLACE_PDF, **então** B permanece privado e A continua disponível ao cliente.
4. **Dado** validade publicada D, **quando** prepara validade D2 após publicação, **então** precisa enviar novo PDF; até publicar o substituto, o portal mantém A e D, sem antecipar D2.
5. **Dado** B pendente, **quando** ator com PUBLISH confirma a publicação, **então** conteúdo e validade correspondentes tornam-se visíveis juntos; A deixa de ser servido e segue para remoção segura.
6. **Dado** nome administrativo incorreto, **quando** ator com CREATE_EDIT o corrige, **então** a correção é permitida sem desbloquear cliente, setor ou número e sem substituir o PDF.
7. **Dado** falha no upload ou na publicação de B, **quando** consulta o portal, **então** A e sua validade permanecem consistentes e B não é exposto.
8. **Dado** A publicado e B pendente, **quando** novo upload autorizado de C é confirmado no armazenamento e na persistência, **então** C torna-se o único pendente, B segue para remoção segura sem histórico e A permanece publicado; C não é publicado automaticamente.
9. **Dado** B pendente, **quando** o upload ou a persistência de C falha antes de confirmar a troca, **então** B e sua validade pendente permanecem intactos, A não é afetado e eventual objeto de C tem limpeza controlada.
10. **Dado** C confirmado como pendente, **quando** a limpeza de B falha, **então** C permanece o único candidato, B continua privado sob controle de limpeza e A permanece disponível; uploads, publicação e exclusão concorrentes não podem remover documento vigente ou reintroduzir candidato obsoleto.

### US-04 — Excluir definitivamente com segurança (P1)

Como usuário autorizado a excluir, quero remover o orçamento e todos os PDFs associados mediante confirmação explícita.

**Por que esta prioridade**: remoção e revogação de acesso são parte da privacidade, não uma lixeira.
**Verificação independente**: preparar orçamento com PDF publicado e substituto, confirmar exclusão e simular falha de limpeza.

1. **Dado** DELETE e confirmação explícita para o orçamento, **quando** a exclusão é aceita, **então** o orçamento deixa de ser consultável pelo cliente, inclusive por referência anterior, e todos os arquivos associados têm remoção controlada.
2. **Dado** exclusão sem confirmação ou sem permissão, **quando** solicitada, **então** nada é removido e nenhum acesso adicional é concedido.
3. **Dado** MinIO indisponível na limpeza, **quando** o acesso ao orçamento já foi revogado, **então** os arquivos restantes continuam privados/inacessíveis ao cliente, a limpeza é recuperável e o sistema não declara todos os objetos removidos antes de verificar o resultado.
4. **Dado** publicação ou substituição concorrente com exclusão, **quando** as operações competem, **então** não há reaparecimento do orçamento nem PDF novo exposto ou perdido do controle de limpeza.

### US-05 — Administrar permissões comerciais setoriais (P2)

Como administrador ou gerente autorizado, quero conceder e revogar operações comerciais dentro do meu alcance, sem conceder acesso a estoque ou produção.

**Por que esta prioridade**: permite delegação com segregação; acesso global administrativo já atende à preparação inicial da gestão.
**Verificação independente**: preparar dois setores e colaboradores com concessões distintas; verificar operação por operação e revogação.

1. **Dado** administrador, **quando** gerencia orçamento ou permissões comerciais em qualquer setor, **então** possui acesso global, sem exceção à proibição de autoconcessão.
2. **Dado** gerente comercial de um setor, **quando** concede ou revoga CREATE_EDIT, READ, REPLACE_PDF, PUBLISH ou DELETE a colaborador, **então** atua apenas nos setores que administra, com autorização e auditoria.
3. **Dado** colaborador com somente READ, **quando** consulta orçamento do setor criado por outro autor, **então** a consulta é permitida; editar, substituir, publicar, excluir ou delegar sem a concessão correspondente é negado.
4. **Dado** concessão revogada ou perda de acesso setorial, **quando** ocorre nova operação, **então** a autorização anterior não continua válida por informação em cache ou enviada pelo frontend.
5. **Dado** concessão comercial, **quando** tenta operar estoque ou produção, **então** não adquire privilégios nesses domínios.
6. **Dado** administrador, **quando** nomeia/revoga gerente comercial ou concede/revoga MANAGE_PERMISSIONS a outro usuário, **então** a alteração é autorizada, delimitada por setor e auditável; as mesmas ações por não administrador são negadas.
7. **Dado** qualquer usuário, inclusive administrador, **quando** tenta conceder permissões a si próprio, **então** a operação é negada; gerente também não pode nomear gerentes, conceder MANAGE_PERMISSIONS ou ampliar suas próprias permissões.

### Casos de borda e falhas

- Arquivo ausente, vazio, truncado, inválido, acima do limite ou não-PDF renomeado: rejeitar sem referência publicável.
- Tipo MIME/extensão declarados não bastam para demonstrar PDF válido; validar o arquivo não significa extrair dados comerciais.
- Cliente/setor inexistente, identificador inválido, número/nome em branco, data inexistente ou com horário: rejeitar.
- Número com zeros à esquerda: preservar; política adicional de espaços/caixa/unicode permanece em DT-02, sem normalização silenciosa.
- Data passada: nenhuma proibição foi aprovada; se cadastrada/publicada, deve ser indicada como vencida e não ocultada.
- Tentativa de trocar a validade publicada sem novo PDF ou publicar sem PDF confirmado: rejeitar.
- Dois uploads, publicações ou exclusões concorrentes: resolver sem misturar conteúdo e validade nem remover documento ainda referenciado.
- Novo upload com pendente existente: confirmar novo arquivo e troca persistida antes de remover o pendente anterior; falha anterior à confirmação preserva o candidato vigente e seu par de validade, sem afetar o publicado.
- Tentativa de delegar MANAGE_PERMISSIONS por gerente/colaborador, nomear gerente por não administrador ou realizar autoconcessão: negar sem alterar concessões; concessões/revogações autorizadas são setoriais e auditáveis.
- Repetição após timeout: não duplicar orçamento, exposição ou efeito de limpeza; confirmar estado antes de repetir efeitos externos.
- Remoção do arquivo anterior falha após troca confirmada: novo PDF permanece publicado; anterior não pode ser recuperado pelo cliente e continua sob controle de limpeza.
- Referência de arquivo fornecida pelo solicitante não prova ownership, existência, publicação ou autorização.
- Downloads já concluídos pelo destinatário não podem ser recolhidos; a garantia de exclusão cobre novos acessos e referências anteriores, não cópias já recebidas.

## 3. Requirements — requisitos funcionais

### Cadastro e identificação

- **RF-001**: Cada orçamento deve possuir UUID interno e pertencer a exatamente um setor existente e um cliente global existente, ambos obrigatórios.
- **RF-002**: O número comercial deve ser obrigatório, informado manualmente e preservado como texto, inclusive zeros à esquerda, sem geração ou extração automática.
- **RF-003**: A combinação setor + número deve ser única no PostgreSQL, inclusive sob concorrência; números iguais em setores distintos são permitidos.
- **RF-004**: Nome administrativo, PDF e validade devem ser obrigatórios no cadastro; nome e número não podem ser vazios ou apenas espaços.
- **RF-005**: Autoria do cadastro deve ser derivada da sessão autenticada e registrada junto à identidade do orçamento; o solicitante não pode escolher o autor.
- **RF-006**: Não armazenar descrição comercial, produtos, serviços, itens, preços, descontos, totais ou outros valores monetários no contrato novo; não interpretar o PDF para obter número, valores ou itens.
- **RF-007**: Cadastro bem-sucedido deve manter referências consistentes a um PDF validado e confirmado no armazenamento privado; falha não pode deixar orçamento parcialmente utilizável ou arquivo acessível ao cliente.

### PDF e publicação

- **RF-008**: PDFs devem permanecer privados no MinIO, sem bucket ou objeto com leitura pública irrestrita.
- **RF-009**: Validar efetivamente conteúdo PDF, arquivo não vazio e tamanho limitado; não confiar somente em nome/extensão ou MIME. O limite e a política de formatos especiais são decisões DT-01, não valores herdados automaticamente do legado.
- **RF-010**: Todo orçamento novo deve iniciar privado, sem visibilidade para o cliente; somente publicação manual com PUBLISH pode disponibilizá-lo.
- **RF-011**: Visualização/download devem verificar sessão, autorização e, para cliente, ownership e referência publicada vigente; o cliente nunca deve obter arquivo privado inicial ou substituto pendente.
- **RF-012**: Publicação deve tornar visíveis, de forma consistente, o PDF confirmado e a validade correspondente; falha antes de concluir deve preservar a publicação anterior, se houver.
- **RF-013**: Substituição é simples, sem histórico de versões: cada orçamento pode ter no máximo um PDF publicado e um PDF substituto pendente. Um novo upload autorizado substitui o pendente anterior somente após confirmação do novo arquivo e da troca persistida; falha antes dessa confirmação preserva o pendente anterior e sua validade. Objetos em upload ou aguardando limpeza não constituem candidatos adicionais nem versões consultáveis.
- **RF-014**: Envio de substituto, inclusive para substituir um pendente, não deve alterar o PDF publicado; o documento anterior permanece disponível durante toda a preparação até a publicação manual autorizada do substituto. Upload nunca implica publicação automática.
- **RF-015**: Após publicar o substituto, o anterior deve deixar de ser acessível ao cliente e ser removido com segurança; falha de limpeza não desfaz a nova publicação nem expõe o arquivo anterior.
- **RF-016**: Uploads sem referência válida e arquivos substituídos, inclusive o pendente anterior, devem ter recuperação/limpeza controladas após troca segura; a limpeza não pode remover objeto ainda referenciado como publicado ou pendente. Falhas de persistência/limpeza e concorrência entre uploads, publicação e exclusão não podem expor documentos, perder o publicado ou reintroduzir referências obsoletas.

### Edição

- **RF-017**: Antes da primeira publicação, CREATE_EDIT permite correções administrativas; substituição de arquivo exige REPLACE_PDF. Correções devem preservar todas as validações e autorizações, inclusive nos dois setores se houver troca.
- **RF-018**: Após a primeira publicação, cliente, setor e número devem ser permanentemente imutáveis, independentemente de substituição pendente ou falha posterior de documento.
- **RF-019**: Nome administrativo pode ser corrigido por CREATE_EDIT, antes ou depois da publicação, sem exigir novo PDF.
- **RF-020**: Alteração de validade ou de conteúdo após publicação exige novo PDF e publicação manual; nunca atualizar silenciosamente a validade ou o conteúdo apresentado ao cliente.
- **RF-021**: Enquanto houver substituto pendente, a validade exposta ao cliente deve ser a do PDF publicado; a validade preparada para o substituto só passa a valer na publicação dele.

### Validade

- **RF-022**: Validade deve ser armazenada como data civil sem horário e recebida sem componente de horário; datas inexistentes devem ser rejeitadas.
- **RF-023**: O dia corrente para avaliar vencimento deve ser determinado em `America/Sao_Paulo`, sem depender do fuso do servidor, navegador ou cliente.
- **RF-024**: O orçamento é válido durante todo o dia de validade e vencido a partir do dia civil seguinte; vencimento não oculta, exclui nem bloqueia o PDF publicado.

### Exclusão

- **RF-025**: Exclusão definitiva deve exigir DELETE e confirmação explícita vinculada ao orçamento pretendido; não oferecer lixeira ou arquivamento.
- **RF-026**: Exclusão deve remover o registro comercial e todos os PDFs associados, incluindo substituto pendente, anterior aguardando limpeza e uploads concorrentes que não possam mais integrar o orçamento.
- **RF-027**: A estratégia PostgreSQL/MinIO deve impedir novos acessos do cliente assim que a exclusão for efetivada, mesmo durante falha de limpeza, mantendo informação técnica suficiente para completar a remoção sem ressuscitar o orçamento.
- **RF-028**: Retentativas e recuperação de exclusão devem ser seguras; falha externa não pode ser apresentada como remoção física completa, perder o controle dos objetos ou disponibilizar restauração comercial.

### Permissões

- **RF-029**: Reutilizar identidades, sessão, setores e concessões existentes; as operações comerciais são exclusivamente CREATE_EDIT, READ, REPLACE_PDF, PUBLISH, DELETE e MANAGE_PERMISSIONS. Não criar novo papel global persistido se o mecanismo existente de autorização puder atender ao contrato.
- **RF-030**: Administrador deve possuir acesso comercial global, sem depender de ser autor ou de concessão por setor.
- **RF-031**: Somente administradores podem nomear e revogar gerentes comerciais. Gerente deve gerenciar orçamentos e conceder/revogar a colaboradores exclusivamente CREATE_EDIT, READ, REPLACE_PDF, PUBLISH e DELETE nos setores que administra; não pode nomear gerentes, conceder MANAGE_PERMISSIONS ou ampliar suas próprias permissões. Sua representação deve ser explícita no backend, não inferida de título visual ou permissão de OS.
- **RF-032**: Colaborador deve executar exclusivamente as operações concedidas no respectivo setor; READ abrange todos os orçamentos desse setor, independentemente do autor.
- **RF-033**: Somente administradores podem conceder e revogar MANAGE_PERMISSIONS. Essa permissão autoriza gestão setorial das cinco permissões operacionais CREATE_EDIT, READ, REPLACE_PDF, PUBLISH e DELETE, não nomeação de gerente nem delegação de MANAGE_PERMISSIONS, e não concede implicitamente operações de orçamento ao colaborador. Nenhum usuário, inclusive administrador, pode realizar autoconcessão de permissões.
- **RF-034**: Verificar autorização vigente em toda operação, incluindo leitura de arquivos, publicação e exclusão; nunca confiar em ator, setor selecionado ou permissões declaradas pelo solicitante. Toda concessão ou revogação deve ser autorizada, delimitada por setor e auditável quanto a ator autenticado, destinatário e alteração realizada.
- **RF-035**: Concessões comerciais não devem criar, ampliar ou substituir permissões de estoque ou produção.

### Portal

- **RF-036**: Listar somente orçamentos vinculados ao cliente autenticado que possuam PDF efetivamente publicado; não revelar existência de documentos privados ou pendentes.
- **RF-037**: Apresentar nome, número, setor, validade publicada e indicação válido/vencido, permitindo baixar exclusivamente o PDF publicado por download autenticado attachment após verificação de ownership.
- **RF-038**: Cliente não pode editar, publicar, substituir, excluir, aprovar, recusar ou executar decisões comerciais; acesso ao documento não representa aceite.

### Adequação e compatibilidade

- **RF-039**: Remover descrição comercial e valor total do contrato de entrada, persistência comercial nova e saída da Feature 005; o tratamento dos dados históricos deve respeitar a estratégia de preservação da seção 9, sem descarte automático.
- **RF-040**: Implementar setor, número, cliente obrigatório, autoria, data civil e controle de publicação no novo módulo documental, preservando a tabela legada e suas migrations aplicadas sem fabricar metadados históricos.
- **RF-041**: Preservar POST /budged com sua composição e comportamento existentes nesta entrega; não tratar cadastros legados como conformes ao contrato novo. Retirada, adaptação ou migração exigem iniciativa independente, inventário dos consumidores, comunicação, testes de compatibilidade e autorização explícita (DT-04).
- **RF-042**: Registros legados não devem ser publicados automaticamente; somente após reconciliação dos campos e arquivos obrigatórios e publicação manual podem entrar no portal.

## 4. Regras de autorização por operação

| Operação                                          | Administrador                                                            | Gerente comercial                                                     | Colaborador                                    | Cliente                        |
| ------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| Cadastrar/corrigir metadados                      | Global                                                                   | Nos setores autorizados                                               | CREATE_EDIT no setor                           | Negado                         |
| Consultar internamente, inclusive privados        | Global                                                                   | Nos setores autorizados                                               | READ no setor, sem filtro por autor            | Negado                         |
| Substituir PDF                                    | Global                                                                   | Nos setores autorizados                                               | REPLACE_PDF no setor                           | Negado                         |
| Publicar PDF                                      | Global                                                                   | Nos setores autorizados                                               | PUBLISH no setor                               | Negado                         |
| Excluir com confirmação                           | Global                                                                   | Nos setores autorizados                                               | DELETE no setor                                | Negado                         |
| Conceder/revogar as cinco permissões operacionais | Global, sem autoconcessão                                                | Somente a colaboradores dos setores que administra, sem autoconcessão | MANAGE_PERMISSIONS no setor, sem autoconcessão | Negado                         |
| Nomear/revogar gerente comercial                  | Exclusivo do administrador, com delimitação setorial e sem autoconcessão | Negado                                                                | Negado                                         | Negado                         |
| Conceder/revogar MANAGE_PERMISSIONS               | Exclusivo do administrador, com delimitação setorial e sem autoconcessão | Negado                                                                | Negado                                         | Negado                         |
| Listar/baixar publicado no portal                 | Acesso interno global                                                    | Acesso interno setorial                                               | Leitura interna com READ                       | Somente os próprios publicados |

O upload obrigatório do cadastro integra CREATE_EDIT; trocar um arquivo existente usa REPLACE_PDF. Alterar metadados junto da substituição exige também CREATE_EDIT. Publicar exige PUBLISH e não concede implicitamente READ ou REPLACE_PDF. Respostas de operações não podem funcionar como listagem/download sem READ; o detalhamento mínimo de respostas será definido no contrato futuro. Não há concessões implícitas entre operações de colaboradores.

As cinco permissões operacionais delegáveis são CREATE_EDIT, READ, REPLACE_PDF, PUBLISH e DELETE. Acesso global do administrador não é uma concessão a si próprio e não autoriza autoconcessão. Gerentes não podem ampliar as próprias permissões. Toda concessão/revogação é setorial e auditável, sem conferir privilégios de estoque ou produção.

## 5. Fluxos e invariantes documentais

### Cadastro e primeira publicação

1. Autenticar e autorizar o ator; validar setor, cliente, unicidade, metadados e arquivo.
2. Confirmar armazenamento privado e referência coerente; concluir cadastro privado com autoria.
3. Permitir correções autorizadas antes da primeira publicação.
4. Mediante ação PUBLISH, disponibilizar o PDF confirmado com sua validade; registrar a ocorrência da primeira publicação para impedir futuras mudanças de cliente/setor/número.

### Substituição

1. Autorizar REPLACE_PDF e demais concessões exigidas pela alteração; validar e armazenar o novo documento privadamente sem sobrescrever fisicamente o publicado ou o pendente vigente.
2. Confirmar o novo arquivo e trocar consistentemente a referência pendente e sua validade. Se já houver pendente, o novo o substitui, sem acumular candidatos; falha de upload ou persistência antes da troca confirmada preserva o pendente anterior intacto.
3. Remover o pendente substituído somente após a troca segura; falha de limpeza mantém o objeto privado sob controle de recuperação, sem afetar o candidato atual ou o publicado.
4. Manter PDF/validade publicados inalterados durante toda a preparação; upload não publica. Somente confirmação manual autorizada troca consistentemente PDF e validade publicados e bloqueia acesso ao anterior.
5. Remover o PDF anteriormente publicado com recuperação segura em caso de falha. Controle técnico de limpeza não constitui histórico de versões. Coordenar uploads, publicação e exclusão concorrentes para não apagar referências vigentes nem reintroduzir objetos obsoletos.

### Exclusão e diferença transacional

1. Autorizar DELETE e verificar confirmação explícita.
2. Revogar a disponibilização e coordenar a remoção do registro e das referências de modo consistente sob concorrência.
3. Remover todos os objetos associados; falhas devem permitir retentativa sem reabrir acesso.
4. Distinguir remoção do orçamento comercial e conclusão da limpeza física. Dados técnicos mínimos de limpeza não podem ser uma lixeira, versão recuperável ou registro comercial consultável.

Não prescrever mecanismo distribuído nesta especificação. Registro durável de trabalho técnico no PostgreSQL, compensação e reconciliação são opções a avaliar depois, não autorização para RabbitMQ ou novo serviço. Uma URL pré-assinada que siga utilizável sem revalidação após exclusão/troca não atende à revogação exigida; o mecanismo de entrega deve demonstrar essa garantia. Caches compartilhados, redirecionamentos e referências antigas não podem contornar autorização vigente. Não se promete apagar cópias já recebidas pelo destinatário.

## 6. Key Entities — entidades conceituais

- **Orçamento**: UUID, setor único, cliente global obrigatório, número textual, nome administrativo, autoria e marco permanente de primeira publicação. Sem descrição comercial, itens ou valores.
- **Documento publicado**: referência privada do PDF atualmente disponibilizado e sua validade civil. Pode não existir antes da primeira publicação.
- **Documento privado/candidato**: PDF inicial ou substituto ainda não publicado, com validade a disponibilizar. Não é uma versão histórica.
- **Concessão comercial setorial**: vínculo de usuário, setor e operação comercial; usa as identidades existentes sem compartilhar privilégios de outros domínios.
- **Controle técnico de consistência**: informação mínima necessária para compensar uploads e concluir limpezas sem eliminar arquivos referenciados; não representa orçamento arquivado nem histórico de PDFs.

Essas entidades não determinam nomes de tabelas, quantidade de colunas, estados persistidos ou migrations. O bloqueio de identidade depois da primeira publicação não pode depender apenas da existência atual do objeto no MinIO.

## 7. Requisitos não funcionais e contratos de integração

- **RNF-001 — Privacidade**: negar acesso quando sessão, concessão, ownership ou publicação não puderem ser confirmados. Não expor arquivos por bucket público, chave adivinhável, cache ou referência obsoleta.
- **RNF-002 — Consistência**: PostgreSQL é fonte canônica de vínculos, permissões, publicação e validade. Operações relacionadas devem ser atômicas no banco; falhas do MinIO exigem compensação/recuperação verificáveis, não promessa de transação distribuída inexistente.
- **RNF-003 — Concorrência**: unicidade, primeira publicação, troca de documento e exclusão devem preservar invariantes mesmo com comandos simultâneos ou repetidos. Nenhuma limpeza pode apagar arquivo ainda referenciado.
- **RNF-004 — Segurança de sessão**: reutilizar autenticação existente, cookie HttpOnly e proteção de Origin/CSRF nas mutações; CORS não substitui CSRF. Não criar identidade comercial paralela.
- **RNF-005 — Responsabilidades**: Routes compõem middlewares; Controllers tratam transporte; Services/casos de uso autorizam e controlam transações; Repositories encapsulam persistência; Models representam dados. Não perpetuar acesso direto do BudgetService ao model como regra arquitetural.
- **RNF-006 — Diagnóstico**: falhas de upload/publicação/limpeza devem ser distinguíveis e correlacionáveis sem registrar conteúdo PDF, credenciais ou links que funcionem como segredo. Não criar histórico de versões por meio de logs.
- **RNF-007 — Integrações**: reaproveitar Client, User, Sector, vínculos/concessões e cliente MinIO existentes, sem depender de permissões de OS ou estoque. Extensões comerciais não devem alterar seus contratos.
- **RNF-008 — Persistência e transição**: mudanças futuras devem usar migrations novas revisadas, preservação/reconciliação e rollback aprovados. Não alterar migrations antigas ou executar alterações em banco nesta etapa.
- **RNF-009 — Entrega de arquivo**: o download autenticado attachment deve sempre respeitar RF-011/RF-027, com streaming/Range e sem URLs públicas ou pré-assinadas. Inline e viewer ficam fora desta versão e exigem gate futuro próprio.
- **RNF-010 — Verificabilidade**: implementação futura deverá demonstrar os cenários de autorização, data civil, falhas e concorrência, incluindo PostgreSQL/MinIO reais em ambiente isolado quando aplicável. Este documento não cria nem executa testes.

## 8. Success Criteria — resultados mensuráveis

- **SC-001**: Em todos os cenários de cadastro válido, número textual e autor são preservados, e o documento não aparece ao cliente antes da publicação manual.
- **SC-002**: Em todas as tentativas concorrentes de duplicação no mesmo setor, existe no máximo um orçamento com aquele número; o mesmo número em outro setor permanece permitido.
- **SC-003**: Nenhum cenário de cliente diferente, documento privado, substituto pendente ou orçamento excluído permite nova obtenção do arquivo.
- **SC-004**: Em todos os cenários de substituição, o cliente observa o par PDF/validade anterior até a publicação e o novo par depois dela, sem combinação intermediária.
- **SC-005**: Na data de validade em São Paulo, o documento é válido; no dia civil seguinte é vencido e continua acessível ao proprietário.
- **SC-006**: Falhas simuladas em cada fronteira de upload, persistência, publicação e remoção não expõem arquivos indevidos, não removem arquivos vigentes e deixam a recuperação possível.
- **SC-007**: Todas as seis operações comerciais respeitam setor/concessão; READ não depende do autor; nenhuma concessão comercial altera privilégios de produção ou estoque.
- **SC-008**: Exclusão autorizada com confirmação elimina o acesso comercial; concluída a recuperação de limpeza, nenhum PDF associado permanece no armazenamento ativo sob controle do módulo.

Não foram aprovadas metas numéricas de latência, volume ou prazo de limpeza; não inventá-las como critérios de negócio.

## 9. Adequação do legado e preservação

### Evidência confirmada na master de referência

- Budget possui cliente opcional, nome, descrição, data/hora, total e uma chave de PDF; não possui setor, número, autoria ou publicação.
- A migration exige description_budget/total_value, incompatíveis com o novo cadastro sem descrição/valores; client_id admite NULL e ON DELETE SET NULL.
- Somente POST /budged está registrado; métodos de leitura, edição e exclusão no controller não demonstram endpoints disponíveis.
- A edição usa budget_number/status_description/status, ausentes no model, e ignora campos recebidos; não retorna a entidade atualizada.
- BudgetService acessa o model diretamente; BudgetRepository não é usado e importa o model sem extensão .js.
- Upload opcional usa budgets/2026 e MINIO_BUCKET legado; guarda só a chave, sem validação efetiva de PDF, publicação ou compensação de falhas. O limite legado é 10 MiB, não um limite novo aprovado.
- getPrivateUrl usa configuração de bucket privado diferente do upload legado; não existe fluxo de download autorizado integrado ao orçamento. Ownership genérico não suporta Budget.
- Usuários possuem papéis admin/user; gerência comercial não é um novo papel global já existente. Concessões operacionais de OS não devem ser usadas para inferi-la.

### Estratégia funcional de compatibilidade

1. Antes de qualquer migração, inventariar registros e arquivos existentes, nulos, duplicidades, datas/offsets e metadados ausentes; não consultar ou alterar bancos nesta etapa documental.
2. Preservar os registros e objetos existentes sem publicação automática, descarte, preenchimento fictício de setor/número/autor ou reclassificação silenciosa como dados novos válidos.
3. Separar a reconciliação do legado do contrato normal de novos cadastros; somente registros saneados e publicados manualmente poderão aparecer no portal. A ausência histórica de autor não pode ser substituída pelo operador como se fosse autoria original.
4. Planejar evolução aditiva e compatibilidade temporária. Description_budget/total_value não pertencem ao novo modelo comercial: deixar de exigi-los/aceitá-los nos fluxos novos; destino físico dos valores históricos e retirada posterior de colunas dependem de preservação aprovada, sem histórico comercial paralelo introduzido implicitamente.
5. Converter datas/horários históricos para data civil somente após regra explícita de reconciliação DT-05; não usar cegamente truncamento UTC ou fuso do servidor.
6. Preservar POST /budged sem modificação nesta feature; inventariar consumidores identificáveis no repositório e registrar os externos como desconhecidos. Substituição ou adaptação somente em iniciativa futura autorizada, após inventário, comunicação e testes.
7. Preservar Client global. Seus fluxos legados de cadastro/atualização/busca precisam de verificação antes de serem tratados como dependência pronta; não criar um cadastro de clientes alternativo nem corrigir módulos fora de escopo nesta etapa.

## 10. Decisões funcionais consolidadas e definições técnicas para o planejamento

### Decisões funcionais aprovadas — sem pendências

- **DF-01 — Gerência comercial, aprovada**: somente administradores nomeiam/revogam gerentes e concedem/revogam MANAGE_PERMISSIONS. Gerentes delegam/revogam somente as cinco permissões operacionais a colaboradores nos setores que administram, sem nomear gerentes, delegar MANAGE_PERMISSIONS ou ampliar as próprias permissões. Autoconcessão é proibida para todos; toda concessão/revogação é autorizada, setorial e auditável. Consolidada em RF-029 a RF-035, US-05 e matriz de autorização.
- **DF-02 — Substituição do pendente, aprovada**: no máximo um publicado e um pendente; novo upload autorizado substitui o pendente após confirmação segura, preservando-o se o upload ou a persistência falhar antes da troca. O pendente anterior é removido com segurança; o publicado permanece acessível até publicação manual do novo par PDF/validade. Sem histórico de versões ou publicação automática. Consolidada em RF-013 a RF-016, US-03 e fluxo de substituição.

### Técnicas/operacionais, a resolver depois, antes da implementação correspondente

- **DT-01 — Política de arquivo**: definir limite máximo de bytes e validação estrutural efetiva; tratamento de PDF criptografado/protegido, corrompido ou com conteúdo ativo. Não inferir 10 MiB como aprovação nem introduzir extração de dados/OCR. Bloqueia fechar critérios de limite/formatos, não o objetivo documental.
- **DT-02 — Identificadores e texto**: definir limites de comprimento, formato de transporte da data civil e comparação de número quanto a espaços, caixa e Unicode; preservar representação textual e garantir unicidade sem normalizações silenciosas.
- **DT-03 — Consistência e entrega privada**: selecionar mecanismo de acesso revogável, controle de concorrência e recuperação durável das limpezas; definir retorno de exclusão parcialmente limpa e comportamento em falhas/repetições. Demonstrar que referências antigas não acessam objetos após exclusão/troca. Não exigir RabbitMQ, MongoDB, novo serviço ou estados comerciais adicionais.
- **DT-04 — Transição HTTP**: nesta feature preservar POST /budged, sem 410 ou cutover; inventariar consumidores identificáveis localmente. Retirada/adaptação, comunicação, compatibilidade e janela de migração serão decididas em iniciativa independente autorizada. A confirmação explícita de exclusão pertence ao contrato novo.
- **DT-05 — Reconciliação de dados**: aprovar mapeamento de setor/número, cliente ausente, autoria histórica desconhecida, data civil e destino dos campos comerciais antigos; decidir compatibilidade de exclusão de Client com vínculo obrigatório. Não preencher informações por suposição nem executar migração destrutiva.
- **DT-06 — Operação e limites**: definir limites/paginação de listagens, política de cache, recursos de upload/download, retentativas e acompanhamento de limpeza, conforme ambiente; não tratar números não aprovados como requisitos funcionais.

DT-01 a DT-06 são definições técnicas/operacionais a tratar no planejamento, não decisões funcionais pendentes. Detalhar a representação da gerência/concessões e sua auditoria respeitando DF-01, sem novo papel global persistido quando o mecanismo existente atender. Estratégias de preservação/transição dependem de validação operacional antes da execução; não podem inventar metadados ou alterar o contrato funcional aprovado. A especificação está funcionalmente pronta para /speckit.plan quando solicitado, sem autorizar seu início automático ou tasks/implementação.

**Resultado do planejamento e fechamento de G-PDF**: DT-01 a DT-06 foram detalhadas nos artefatos em /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf: research.md, plan.md, data-model.md, contracts/http-api.md, contracts/storage-lifecycle.md e quickstart.md. O responsável aprovou qpdf para validação estrutural, com limite 10 MiB, assinatura, --requires-password com códigos próprios e --check sem erro/aviso, execução sem shell, temporários controlados, recursos/timeout/falha fechada e futura integração na imagem. G-PDF fechado; tasks solicitado explicitamente, sem implementação automática. Os 42 RF, histórias e critérios de sucesso permanecem inalterados; nenhuma instalação/operação de infraestrutura executada por esse registro. Detalhes técnicos e tarefas futuras não alteram publicação manual, substituição, exclusão ou acesso privado e não garantem ausência de malware.

## 11. Assumptions, dependências e fora do escopo

### Premissas explícitas

- O PDF é produzido fora da API; validar estrutura/segurança de arquivo não implica interpretar seu conteúdo comercial.
- Setor, cliente e usuário são cadastros existentes; não são criados implicitamente no orçamento.
- A lista de publicado/privado/pendente e limpeza descreve condições funcionais/técnicas, não aprova enum de estados comerciais nem histórico de revisões.
- O nome administrativo é o nome apresentado no portal conforme requisito aprovado.
- Autoria de cadastro é obrigatória para registros novos; preservação de legado incompleto não é dispensa para novos cadastros.
- Não presumir que componentes existentes estão corretos ou que a infraestrutura MinIO já foi validada operacionalmente para este contrato.

### Fora do escopo

Produtos/serviços/itens, cálculo de valores/descontos, aprovação ou recusa, geração de PDFs, Figma/automação documental, OCR/extração, histórico de versões, arquivamento/lixeira, criação de OS ou vínculo comercial-operacional nesta entrega, integração de estoque, novos serviços/MongoDB/RabbitMQ sem justificativa concreta. Agendamentos, Google Calendar, Telegram e n8n pertencem à futura Feature 006. Nenhuma alteração nas Features 003/004 está autorizada por esta especificação.

### Referências locais consultadas

- Constituição: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/.specify/memory/constitution.md
- Arquitetura: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/docs/architecture/approved-domain-architecture.md
- Operação CQRS de estoque: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/docs/architecture/feature003-cqrs-operations.md
- Auditoria histórica: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/docs/audit/remediation-plan.md
- Fronteiras de OS: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/004-service-orders-production/spec.md
- Schema legado: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/src/database/migrations/20261110000200-create-orders-and-budgets.cjs
- Template consultado: /home/wpossidonio/.local/share/uv/tools/specify-cli/lib/python3.11/site-packages/specify_cli/core_pack/templates/spec-template.md
