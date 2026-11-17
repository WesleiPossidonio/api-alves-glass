# Feature Specification — 004: Acompanhamento de Ordens de Serviço e Qualidade

**Status: APROVADA — implementação incremental autorizada em 14/11/2026.**
**Escopo:** backend; cadastro de OS, andamento por produto, vínculo de colaborador, qualidade, publicação de status e histórico.
**Base:** decisões funcionais aprovadas e consolidadas até 16/11/2026 (incluindo RF-07, RF-10, RF-11 e RF-31). Evidências e limites de validação em `final-validation.md`.

## 1. Problema e fronteiras

O sistema de origem prepara o pedido, valida medidas com o cliente e gera a OS impressa. A Feature 004 recebe **dados estruturados** do pedido e mantém o acompanhamento operacional. Um colaborador recebe o papel, seleciona um setor permitido, informa o número e assume a OS disponível. Ele sinaliza produtos concluídos fisicamente para inspeção; a qualidade registra aprovação ou reprovação. O cliente final acompanha os **marcos de status do pedido** em seu sistema, não o módulo operacional interno de OS.

A aplicação NÃO é configurador de produtos, gerenciador de métodos de fabricação, sistema de estoque, ferramenta de logística ou gerador/processador de PDF. O sistema de origem determina a composição final de produtos **antes** de cadastrar a OS aqui.

## 2. Cadastro e identificação

**RF-01.** Toda OS possui ID técnico globalmente único e número externo de pedido **informado manualmente** pelo usuário autorizado. Preservar representação textual, inclusive zeros à esquerda. O backend não gera esse número.

**RF-02.** A unicidade do número é **por setor**: `(sectorId, orderNumber)`. Números iguais são admitidos em setores diferentes; uma OS pertence a exatamente um setor. Pedidos dos dois setores demandam duas OS independentes, sem vínculo automático pressuposto.

**RF-03.** A OS deve referenciar um cliente previamente cadastrado em `Client` global, válido para Vidraçaria ou Marcenaria. Não criar cliente dentro do fluxo da OS. Data prevista de conclusão é informada manualmente e obrigatória.

**RF-04.** O cadastro contém pelo menos um produto, com informações operacionais próprias. O conjunto de produtos torna-se **imutável quanto à composição** após o cadastro: não acrescentar nem retirar produtos. Alterações de composição exigem outra OS.

**RF-05.** Dados estruturados são o único conteúdo recebido pelo backend. Extração/preenchimento opcional a partir de PDF ocorre exclusivamente no frontend, com revisão humana, **sem** upload, OCR, geração, parsing ou armazenamento de PDF pela API.

**RF-06.** Cadastro é atômico; validar setor, cliente, itens, autorização e duplicidade no PostgreSQL sem criação parcial.

## 3. Produtos e correções

**RF-07.** Produto exige nome não vazio; quantidade inteira positiva em `UN`; largura e altura numéricas, finitas e positivas. Espessura do vidro, cor do vidro e cor do alumínio/ferro são opcionais na API. Quando informada, espessura deve ser numérica, finita e positiva; cores devem ser textos não vazios, sem lista fechada. Preservar JSON de medidas, aliases e formatos numéricos aceitos, sem conversão automática de unidades. Não criar catálogo, classificação, enumeração ou seletor obrigatório de materiais; não inferir material pelo nome nem exigir campos condicionais. Descrição e observação permanecem opcionais. A mesma validação de medidas se aplica às correções autorizadas por RF-09/RF-11, sem alterar quantidade ou composição.

**RF-08.** Produtos com características idênticas podem constar em um item com quantidade >1; características diferentes são linhas distintas. Não pressupor agrupamento automático.

**RF-09.** Correções por erro humano em produtos existentes (nos campos permitidos, como nome, descrição e medidas; quantidade é imutável conforme RF-10) são permitidas durante a produção por administrador global, responsável autorizado do setor ou colaborador autorizado que tenha cadastrado a própria OS. Preservar os valores anteriores, autor, data e demais fatos históricos. Não criar processo de aprovação de revisão nem ciclos versionados obrigatórios.

**RF-10.** A quantidade de cada produto é **imutável após o cadastro da OS**, independentemente do estado da produção. Não permitir aumento ou redução, nem implementar correção quantitativa, contador de unidades produzidas ou apontamentos de fabricação. Correções auditáveis de RF-09 ficam restritas aos campos permitidos, sem alterar quantidade, ID ou composição dos itens.

**RF-11.** Correções de nome, descrição e medidas são permitidas exclusivamente em `IN_PRODUCTION` e somente enquanto o produto não possuir nenhum registro ou sinalização de qualidade. Após a primeira atividade de qualidade daquele produto, seus campos corrigíveis ficam bloqueados definitivamente, independentemente do resultado da conferência. O bloqueio é individual: outros produtos da mesma OS sem atividade própria de qualidade continuam corrigíveis. Nenhuma correção é permitida em `REGISTERED`, `AWAITING_SUPPLIER`, `AWAITING_DELIVERY`, `COMPLETED` ou `CANCELLED`. Quantidade, identidade e composição permanecem imutáveis conforme RF-10. Correções válidas exigem autorização e auditoria de valores anteriores/novos, autor e data, com evento canônico e Outbox na mesma transação.

## 4. Autorização e assunção

**RF-12.** Reutilizar identidade `User`, sessão, papéis administrativos e associação existente a `Sector`/`UserSector`; não presumir papel persistido `collaborator` nem criar Model paralelo de funcionário. O administrador designa responsáveis de setor com conjunto de poderes gerenciais, sem necessidade de concessão operação a operação para gestores. Admin ou responsável do setor pode autorizar colaborador a criar OS dentro do setor. Criador autorizado pode editar a própria OS nos limites de estado e regras.

**RF-13.** Ao receber a OS impressa, o colaborador seleciona um **setor para o qual tem acesso** e digita o número externo do pedido. A consulta e assunção usam setor + número, nunca o número isolado.

**RF-14.** A primeira assunção é feita pelo próprio colaborador, desde que a OS não esteja vinculada a outro colaborador e o funcionário não tenha **outra OS ativa**. Garantir exclusividade e ausência de corrida no banco transacional. Um colaborador pode ter **uma OS ativa por vez**, mesmo quando ela está aguardando entrega/instalação.

**RF-15.** Somente o colaborador atualmente vinculado poderá sinalizar produtos daquela OS como prontos para inspeção ou reinspeção. Atos de qualidade seguem autorização própria, não decorrem apenas do vínculo de colaborador.

**RF-16.** Somente administrador ou responsável autorizado do setor pode liberar a OS para que outro colaborador a assuma. Registrar vínculos anteriores, autores e ações. A assunção não constitui distribuição quantitativa de itens. Outros podem colaborar fisicamente, mas a responsabilidade digital pela OS é única.

**RF-17.** Colaborador deixa de ter OS ativa após conclusão **definitiva**, incluindo confirmação final de entrega ou instalação; aprovação da produção não libera o vínculo. Cancelamento libera automaticamente. Liberação excepcional pela gestão segue RF-16.

## 5. Estados e transições

**RF-18.** A OS utiliza somente os seis status funcionais:

1. `Cadastrada`;
2. `Aguardando fornecedor`;
3. `Em produção`;
4. `Aguardando entrega/instalação`;
5. `Concluída`;
6. `Cancelada`.

Os valores físicos vigentes são `REGISTERED`, `AWAITING_SUPPLIER`, `IN_PRODUCTION`, `AWAITING_DELIVERY`, `COMPLETED` e `CANCELLED`. Não reinterpretar automaticamente estados históricos sem mapeamento.

**RF-19.** Da criação em `Cadastrada`, gestor decide se materiais devem ser aguardados (`Aguardando fornecedor`) ou se pode iniciar (`Em produção`). `Aguardando fornecedor` é **apenas anterior à produção**; sua saída é direta para `Em produção`, sem pausa nem retorno intermediário a `Cadastrada`. O sistema não gerencia compras ou fornecedores.

**RF-20.** Antes de `Em produção`, produtos não apresentam status individual. Durante a produção, cada produto tem **somente** `Em produção` ou `Concluído`. A sinalização `pronto para conferência` é condição **interna** de qualidade, não novo status público. Um produto só se torna `Concluído` após aprovação total da qualidade; outros produtos permanecem inalterados.

**RF-21.** A OS permanece `Em produção` enquanto um produto ainda não estiver concluído. Quando todos os produtos estiverem concluídos e aprovados, um responsável autorizado pela qualidade **confirma o encerramento da produção**, levando a `Aguardando entrega/instalação`.

**RF-22.** A OS só passa a `Concluída` após uma **única confirmação** de entrega OU instalação, por administrador, responsável autorizado ou colaborador com permissão expressa. Não criar fluxo logístico. OS concluída não reabre e permanece histórica, somente leitura.

**RF-23.** Admin ou responsável autorizado pode cancelar definitivamente a OS a qualquer momento **antes** da conclusão definitiva. Justificativa opcional; autor e data obrigatórios. Cancelamento bloqueia novas ações, preserva histórico, não reabre e libera automaticamente o colaborador vinculado.

**RF-24.** Não há suspensão, retomada, reabertura, segundo ciclo operacional nem aprovação administrativa redundante após a qualidade.

## 6. Qualidade

**RF-25.** O colaborador vinculado sinaliza produto pronto para inspeção **após conclusão física de todas as unidades do item**. A inspeção é obrigatória antes do status individual `Concluído`. A sinalização é registrada com autor e horário.

**RF-26.** Qualidade é registrada por admin ou responsável autorizado; quem executou ou corrigiu o produto **pode aprovar o próprio trabalho se também estiver autorizado para qualidade**. Não impor veto universal à autoinspeção.

**RF-27.** A inspeção pode aprovar algumas unidades e reprovar outras. A quantidade rejeitada e descrição do problema são obrigatórias; preservar autor, data, quantidades e resultados. Não reabrir/reprovar unidades já aprovadas sem regra aprovada.

**RF-28.** A solução material do problema ocorre fora do sistema, sem gestão separada de retrabalho/substituição/descarte. Após a correção, o colaborador **atualmente vinculado** sinaliza novamente as unidades previamente rejeitadas. A qualidade reinspeciona **somente** essas unidades e mantém histórico das aprovações anteriores.

**RF-29.** Disponibilizar consulta de conferências pendentes por setor e número da OS para quem tem autorização de qualidade, incluindo inspeções e reinspeções sinalizadas. A prioridade é informativa; a ordem cronológica é por **data de sinalização**, com desempate técnico determinístico.

## 7. Prioridade, consulta e integração de status

**RF-30.** Administrador/responsável de setor pode marcar uma OS `prioritária`. A flag permanece persistida e pode ser exibida em destaque no frontend. **Não altera** FIFO nem força antecipação cronológica; cada setor segue sua própria ordem de chegada, com desempate determinístico.

**RF-31.** O módulo operacional de OS é interno. O cliente acompanha somente os próprios pedidos por `GET /service-orders/client/me`, usando identidade da sessão e ownership canônico PostgreSQL. Cada item do DTO contém apenas `id`, `externalNumber` textual e `status`, com os seis estados funcionais aprovados. Não expor atribuição, qualidade, pessoas, produtos ou movimentações internas. Paginação usa cursor assinado. Estado histórico/desconhecido sem mapeamento continua bloqueado (`clientStatusMappingPending`); projeção ausente ou incompatível retorna `projectionPending`. Não criar novo módulo de cliente ou supor consumo efetivo pelo frontend. Ver `rf31-client-tracking.md`.

**RF-32.** Leitura interna permite observar OS e seus produtos, andamento individual, pendências de qualidade autorizadas e históricos. A leitura/projeção principal preserva o vínculo lógico `OS → products[] → movements[]`; cada fato do produto aparece exclusivamente no histórico dele.

**RF-33.** O backend jamais deriva autorização da seleção visual de setor, nem de IDs de usuário enviados pelo cliente HTTP; valida sessão e acesso vigente a cada comando/consulta.

## 8. Arquitetura aprovada — não ampliar escopo

**RF-34.** PostgreSQL é a fonte canônica de estados e fatos operacionais; cada comando grava suas decisões, fatos e Outbox pertinente de modo atômico. Eventos imutáveis/versionados e correções registradas como novos fatos. Garantias de concorrência no PostgreSQL, nunca no RabbitMQ/Mongo.

**RF-35.** Outbox/RabbitMQ publica fatos de integração com entrega potencialmente duplicada; consumers idempotentes aplicam à projeção MongoDB CQRS reconstruível, preservando causalidade, versão e histórico por produto. Mongo não autoriza comandos nem substitui a fonte canônica.

**RF-36.** O domínio OS é independente do estoque: não reservar, consumir, dar baixa ou criar movimentações automáticas. Reutilização da Feature 003 limita-se à infraestrutura genérica efetivamente compartilhável.

**RF-37.** Autenticação e segurança seguem padrões existentes (sessão/cookie HttpOnly e proteções correspondentes), com segregação setorial, validação de autorização em backend e auditoria de autoria. Não criar microsserviços, sistemas de identidade ou infraestrutura por conveniência.

## 9. Fora de escopo explícito

Triagem obrigatória 7+; divisão e reatribuição de unidades; registro de produção por unidade; tarefas de fabricação; controle de retrabalho e disposição; suspensão/retomada; revisão com aprovação administrativa e novos ciclos; reabertura; movimentação de estoque; logística/roteirização; catálogos ou listagem obrigatória de materiais; geração/processamento de PDFs; área operacional completa para cliente; ordenação automática pela flag prioritária.

## 10. Critérios de aceite mínimos

1. Duas OS de setores diferentes aceitam o mesmo número; duplicata no mesmo setor é rejeitada sem persistência parcial.
2. Número textual preserva zeros; cadastro requer cliente existente, prazo e produtos válidos; não gera número nem PDF.
3. Cadastro posterior não permite adicionar/remover produtos; correção permitida preserva histórico, autorização e invariantes aprovadas.
4. Funcionário sem acesso a setor não consulta/assume OS daquele setor.
5. Concorrência para assumir mesma OS resulta em **um único vencedor**; uma pessoa com OS ativa não assume outra.
6. Transferência autorizada preserva histórico e libera o funcionário anterior; cancelamento libera automaticamente.
7. Produto sinalizado não vira `Concluído` sem aprovação da qualidade.
8. Reprovação parcial exige motivo e quantidade, preserva unidades aprovadas; reinspeção alcança somente rejeitadas.
9. Dois produtos podem ter estados diferentes; OS permanece `Em produção` enquanto houver algum incompleto.
10. Fechamento da produção requer todos os produtos aprovados e confirmação autorizada; conclusão definitiva exige confirmação distinta de entrega OU instalação.
11. OS concluída/cancelada é terminal/somente leitura. Cancelamento preserva motivo opcional, autor e instante obrigatórios.
12. Prioridade é atributo informativo; consultas FIFO permanecem cronológicas, inclusive fila de qualidade por sinalização.
13. Leitura do cliente não revela pessoas, inspeções ou outras informações operacionais e só entrega campos de status expressamente aprovados.
14. Duplicação/reentrega de evento não duplica efeito; projeção OS preserva movimentos no produto de origem e pode ser reconstruída.

## 11. Pontos que não podem ser inventados durante a implementação

- Consumo efetivo pelo frontend não é demonstrado neste backend; contrato HTTP de RF-31 já está definido.
- Evolução futura de eventos/payloads exige compatibilidade; contratos existentes estão referenciados em `contracts/` e não devem ser renomeados por esta consolidação.
- Política legal de retenção/anonimização/expurgo (G8): não presumir.

Esses pontos são **lacunas técnicas/contratuais**, não autorização para ampliar funcionalidades. Devem ser apresentados em revisão dirigida quando se tornarem bloqueantes para a etapa correspondente.
