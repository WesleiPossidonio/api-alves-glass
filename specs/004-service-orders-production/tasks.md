# Feature 004 — Checklist e evidências de consolidação

**Status:** consolidação validada em 16/11/2026. Matriz RF-01–RF-37, testes executados e limites em `final-validation.md`. Checkboxes mantidos abertos quando o item é amplo ou depende de revisão humana/operacional; testes verdes não comprovam deploy, ativação operacional ou segregação do diff.

## Fase A — Reconciliação documental e inventário, sem código

- [x] R001 Confirmar worktree, branch, alterações locais e versões dos documentos; não sobrescrever trabalho pendente.
- [ ] R002 Cruzar cada requisito da especificação vigente com `spec.md` desta proposta e decisões aprovadas; classificar como mantém, altera, substitui, exclui do escopo ou pendente técnico.
- [ ] R003 Confrontar data-model, events/read-api, plan/research com seus conteúdos reais, sem presumir que os trechos do relatório substituem arquivos originais.
- [ ] R004 Produzir diffs documentais revisáveis, sem modificações de código, banco, migrations ou infraestrutura.
- [ ] R005 Revisar e aprovar a documentação consolidada; matriz RF ↔ critérios ↔ testes planejados.

## Fase B — Planejamento de domínio / compatibilidade (após aprovação documental)

- [ ] R006 Inspecionar caminhos legados `Order`/`OrdersProducts` e referências da OS, garantindo não interferência.
- [ ] R007 Mapear código de numeração automática, triagem, alocação quantitativa, apontamento, suspensões, revisões, ciclos e reabertura para futura remoção segura ou compatibilidade.
- [ ] R008 Revisar políticas de sessão/usuário/setor/admin/responsável e permissão excepcional do colaborador que cria OS.
- [ ] R009 Definir compatibilidade de dados/eventos/migrations já existentes, sem `DROP`, `TRUNCATE`, rollback ou exclusão de histórico.
- [ ] R010 Preservar decisões definitivas: RF-07 sem material condicionado, espessura/cores opcionais e validadas quando informadas; RF-10 com quantidade imutável; RF-11 com bloqueio individual após qualidade. Não reabrir decisões já aprovadas.

- [x] RF07 Validar nome, quantidade inteira positiva, largura/altura finitas e positivas; espessura/cores opcionais no JSON existente, sem inferência por nome, classificação ou conversão de unidades; mesma validação nas correções autorizadas.

## Fase C — Regras puras e testes de domínio

- [x] R011 Cadastro: número manual textual, unicidade por setor, cliente existente, um setor, prazo, produtos e campos obrigatórios.
- [x] R012 Imutabilidade da composição; quantidade imutável após cadastro em todos os estados; correção auditável de nome, descrição e medidas somente em IN_PRODUCTION e antes de qualquer atividade de qualidade do próprio produto (bloqueio definitivo e individual), sem correção quantitativa ou contador de produção.
- [x] R013 Máquina de estados de seis estados, transições válidas, fornecedor somente antes de produção, terminalidade.
- [x] R014 Produtos com dois estados visíveis durante produção e sem status anterior; conclusão condicionada à qualidade.
- [x] R015 Assunção por setor+número; uma OS por colaborador e um colaborador por OS; transferências pela gestão; cancelamento e conclusão liberam vínculo.
- [x] R016 Qualidade: sinalização, inspeção parcial, motivo de rejeição, reapresentação do rejeitado, reinspeção parcial, autorização de autoinspeção.
- [x] R017 Prioridade flag e FIFO estável; não antecipar prioridades; fila de qualidade ordenada por chegada à conferência.
- [x] R018 Permissões internas e DTO público mínimo; separar leitura de sistema cliente de controles internos.

## Fase D — Persistência e API

- [ ] R019 Comparar Models, repositories, migrations e contratos atuais com modelo aprovado antes de alterar schema.
- [x] R020 Implementar/ajustar validação e casos de uso com transações PostgreSQL e controles de concorrência.
- [x] R021 Registrar fatos/eventos canônicos de OS e Outbox sem reescrever histórico nem misturar estoque.
- [ ] R022 Conciliar rotas/validação/DTOs com contrato técnico aprovado; não quebrar rotas legadas.
- [ ] R023 Projeção `OS → products[] → movements[]`, idempotência, checkpoint e replay seguro.

## Fase E — Aceitação (somente alvo isolado autorizado)

- [x] R024 Testes unitários para cada RF e negativa de autorização, estado e quantidade.
- [x] R025 Testes PostgreSQL real de unicidade e concorrência na assunção, uma OS por usuário, cancelamento/liberação, transações e rollback seguro.
- [x] R026 Testes de qualidade: reprovação parcial, não duplicação, reinspeção seletiva e conclusão agregada.
- [ ] R027 Testes HTTP, autenticação, sessão, autorização setorial, privacidade da leitura de cliente e compatibilidade do legado.
- [ ] R028 Testes Outbox/RabbitMQ/Mongo de duplicatas, causalidade, falhas, retomada e reconstrução, sem suposições de entrega exactly-once.
- [x] R029 Documentar estado final e limitações reais, sem marcar Feature 004 concluída antes de executar aceites.

## Regras operacionais

Usar Yarn Classic v1, `yarn.lock` oficial, sem npm/npx; sem commit/push/PR sem pedido; sem migrations não autorizadas, alteração dos arquivos da Feature 003 ou dados de produção; recovery somente para os testes expressamente autorizados, sem limpeza de dados/eventos/volumes; não inferir que teste unitário aprovado equivale a integração aprovada.

## Limites dos itens ainda abertos

R005 exige revisão humana. R006/R009/R022 exigem seleção/revisão do diff preexistente fora da Feature 004, sem descartar alterações. R019 teve correspondência de colunas dos 13 Models conferida; isso não certifica o histórico de instalação em outro ambiente. R023/R028 têm replay/idempotência testados em gerações isoladas; ativação e scheduler/claim global não foram exercitados. R027 inclui aceitação HTTP ponta a ponta além da inspeção de rotas e testes de sessão/serviço executados. Demais checkboxes históricos não são lacunas funcionais automáticas nem autorização para nova auditoria.
