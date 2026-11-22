# Specification Quality Checklist: 005 — Gestão de Orçamentos em PDF

> **Reconciliação T065 (2026-11-21):** esta checklist de 25 itens continua
> exclusivamente documental. A execução das cinco jornadas e a matriz
> individual 42 RF/10 RNF/8 SC estão registradas em `../quickstart.md` com
> logs reais no run `7aac9fa67b8e` (124/124, 0 falhas/skips). Gates
> T061–T064 possuem evidências independentes; os `[x]` abaixo não são testes.

> **Atualização de escopo 2026-11-19:** a seção abaixo é checklist documental
> histórico, não teste de implementação. RF-040/041 e DT-04 agora preservam
> `POST /budged` e `budget`; 410, comunicação e migração são iniciativa futura.
> Evidências executadas e lacunas RF/RNF/SC constam em `../final-review.md`.

**Purpose**: revisão de completude e consistência da especificação, não evidência de implementação.
**Created**: 2026-11-17
**Feature**: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/spec.md
**Status**: G-PDF fechado por aprovação explícita de qpdf; documentos reconciliados e tasks.md gerado pelo procedimento solicitado. DF-01/DF-02 preservadas. Sem instalação, infraestrutura ou implementação; prontidão documental não é aceite operacional.

## Conteúdo

- [x] CHK001 Objetivo, escopo, atores e limites preservados; plano/tarefas iniciados somente após solicitações explícitas, sem implementação automática.
- [x] CHK002 Histórias priorizadas possuem valor, verificação independente e cenários Dado/Quando/Então.
- [x] CHK003 Os 42 requisitos preservam numeração/estrutura e distinguem decisões funcionais aprovadas de definições técnicas para planejamento.
- [x] CHK004 Entidades conceituais não constituem schema físico ou migrations.
- [x] CHK005 Resultados de sucesso são verificáveis, sem metas operacionais inventadas.

## Cobertura e segurança

- [x] CHK006 Cadastro exige cliente/setor existentes, número manual textual, nome, PDF, data civil, UUID e autoria.
- [x] CHK007 Unicidade por setor inclui concorrência e preservação de zeros.
- [x] CHK008 Publicação manual, imutabilidade após primeira publicação e correção de nome estão cobertas.
- [x] CHK009 Substituição mantém publicado anterior e sua validade até troca manual consistente.
- [x] CHK010 Sem versões históricas; coexistência transitória e controle de limpeza não viram arquivo comercial.
- [x] CHK011 Validade civil em America/Sao_Paulo inclui o dia inteiro e não bloqueia acesso ao vencido.
- [x] CHK012 Exclusão exige confirmação e permissão, cobre ambos os PDFs e falhas de limpeza sem exposição.
- [x] CHK013 Referências antigas, URLs temporárias, caches e concorrência não contornam revogação.
- [x] CHK014 Matriz cobre seis permissões, administrador global, gerente setorial, READ sem filtro por autor e cliente somente proprietário.
- [x] CHK015 Sessão, CSRF, ownership e não propagação de permissões entre domínios estão explícitos.
- [x] CHK016 Casos negativos incluem PDF inválido, dados inválidos, conflitos, acesso indevido e falhas externas.
- [x] CHK017 Legado possui estratégia de preservação/reconciliação sem publicação ou preenchimento fictício.
- [x] CHK018 Sem itens/valores, aceite comercial, criação de OS, estoque ou escopo da Feature 006.

## Decisões funcionais encerradas e definições técnicas para planejamento

- [x] CHK019 DF-01 incorporada em RF-029 a RF-035, US-05 e matriz: gerência/MANAGE_PERMISSIONS exclusivos do administrador; cinco permissões operacionais delegáveis por gerente somente a colaboradores dos seus setores; sem autoconcessão ou autoampliação; concessões/revogações setoriais auditáveis e sem propagação a estoque/produção.
- [x] CHK020 DF-02 incorporada em RF-013 a RF-016, US-03 e fluxo: no máximo um publicado e um pendente; upload confirmado substitui pendente, falha antes da troca o preserva, limpeza segura e publicação exclusivamente manual, com proteção contra concorrência.
- [x] CHK021 G-PDF fechado: qpdf aprovado, 10 MiB/assinatura/estrutura, --requires-password com códigos próprios, --check somente 0, senha/erro/aviso rejeitados; processo seguro/recursos/temporários/falhas, imagem compatível e testes negativos rastreados em tasks.md. Validação estrutural não é antimalware; instalação/ensaios permanecem futuros.
- [x] CHK022 DT-02 a DT-06 detalhadas em research.md, data-model.md e contracts/: comparação exata, streaming revogável, locks/CAS, registry/limpeza, transição HTTP e preservação do legado. Inventário e ensaios são gates futuros, não execução comprovada.

## Uso do Spec Kit e limites de evidência

- [x] CHK023 Constituição lida e apontador local de feature atualizado somente no novo worktree.
- [x] CHK024 Procedimentos/templates oficiais consultados. Histórico: specify usou template instalado, plan restaurou template local; tasks teve resolução local ausente e setup oficial com fallback em memória para template instalado, sem escrita fora da feature ou alegação de resolução nativa bem-sucedida.
- [x] CHK025 tasks.md gerado e revisado após autorização, com 66 tarefas abertas/dependências/validação, cinco histórias e gates separados. Nenhum código, Dockerfile, migration, endpoint ou teste implementado/executado.

## Notas

Itens marcados indicam revisão documental pelo agente e decisão qpdf aprovada pelo responsável, não validação de execução. Cenários/testes/tarefas são futuros. Sem hooks locais em .specify/extensions.yml. Setup oficial tasks executado com fallback de template somente em memória conforme tasks.md; nenhum handoff automático. Não executados implement, instalação qpdf, build, deploy, banco, MinIO, containers, commit, push ou PR. Alterações exclusivamente em specs/005-budgets-pdf; mudanças locais anteriores preservadas.

Resultado após fechamento G-PDF e decomposição: **25 de 25 itens satisfeitos documentalmente**. Sem nova pendência funcional/técnica bloqueante de início de implementação. Constituição: sessão/autorização backend, segregação, transações, recuperação e migrations novas preservadas. Os 42 RF, cinco histórias e oito critérios de sucesso permanecem intactos. Tarefas ordenadas por dependência real e gates de isolamento/schema/qpdf/MinIO antes de execução HTTP, segurança e release; nenhuma prova operacional alegada. Implementação somente após nova solicitação.
