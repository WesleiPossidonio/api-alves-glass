# Feature 004 — Consolidação para revisão

**Data da revisão:** 14/11/2026
**Situação:** implementação funcional consolidada; ver `final-validation.md` para evidências de 16/11/2026, cobertura dos 37 RFs e pendências de seleção do worktree antes do versionamento. Documentos de planejamento/proposta preservados abaixo são históricos, não contratos que sobrepõem a especificação aprovada.

## Objetivo

Substituir o escopo excessivo de **gestão da fabricação** por **cadastro e acompanhamento de OS, andamento individual de produtos e controle de qualidade**, conservando autorização setorial, rastreabilidade e arquitetura aprovada.

## Conteúdo

- `spec.md`: especificação funcional consolidada e critérios de aceite.
- `data-model.md`: entidades conceituais e invariantes, sem DDL.
- `contracts/events.md`: eventos físicos atuais, conceitos e garantias de compatibilidade.
- `contracts/read-api.md`: consultas internas e DTO mínimo do cliente, com referências RF-31/RF-32.
- `plan.md`: plano de reconciliação e aplicação gradual.
- `research.md`: decisões e riscos de compatibilidade efetivos.
- `tasks.md`: checklist de trabalho **novo e proposto**, sem reutilizar identificadores de tarefas antigas como se fossem concluídas.
- `reconciliation.md`: diferenças com a documentação anterior, informações comprovadas e pontos que ainda exigem decisão técnica.
- `prompt-cline.md`: instruções práticas para o Cline revisar o checkout local, propor diff, e **não implementar** nesta fase.

## Fontes históricas do realinhamento

- Decisões funcionais discutidas e aprovadas na revisão, até a Decisão 78 (incluindo correções e substituições posteriores).
- Especificação compartilhada `Markdown colado(20261113-081701).md`.
- Checklist compartilhado `Markdown colado(20261114-082525).md`.
- Auditoria compartilhada `Texto colado(20261114-094109).txt`.

`plan.md`, `research.md`, `data-model.md`, `contracts/events.md` e `contracts/read-api.md` **não estavam disponíveis em seu conteúdo integral como arquivos originais para confronto linha a linha**. Os arquivos de mesmo nome deste pacote são **propostas derivadas das decisões e dos trechos citados na especificação e auditoria**. O Cline deverá confrontá-los com as versões atuais antes de aplicar alterações.

## Limites históricos da proposta de 14/11/2026

Esta seção descreve a etapa anterior, não os resultados atuais. A execução autorizada e os testes de 16/11 estão em `final-validation.md`.

1. Nenhum arquivo de repositório foi editado, nenhum commit/PR foi criado e nenhum teste/migration/serviço/banco foi executado.
2. Os documentos são propostas para incorporar no **worktree correto**, somente depois de inventariar o estado real.
3. Não alterar a Feature 003, Models/rotas legadas `Order`/`OrdersProducts`, migrations aplicadas ou dados do ambiente recovery.
4. Usar **Yarn Classic v1**, não npm/npx, quando houver autorização futura para testes.
5. Questões técnicas sem decisão explícita aparecem marcadas como `PENDENTE`; não as resolver automaticamente.

## Ordem histórica de aplicação

Conferir o worktree e preservar mudanças existentes → comparar documentos vigentes → apresentar diff de `spec.md` e decisões pendentes → aprovar → conciliar modelo, eventos, leitura, plano e tarefas → aprovar → **só então** discutir código e testes; migrations e integração requerem autorização específica.
