# RF-07 e RF-09–RF-11 — contrato implementado

## Validação de entrada

Nome não vazio (limite persistido: 240 caracteres), quantidade inteira positiva
em UN e largura/altura numéricas, finitas e positivas. Preservados JSON `measurements`,
aliases `width`/`widthMm`, `height`/`heightMm`, strings decimais e campos
operacionais adicionais, sem conversão de unidade nem migração de dados antigos.
Espessura e cores são opcionais na API, inclusive para produtos cujo nome mencione vidro ou metal. Não há inferência por nome, classificação ou obrigatoriedade condicional.

No JSON `measurements`, `thickness`/`thicknessMm` aceitam números ou strings numéricas finitas e positivas, com o mesmo formato decimal/exponencial usado por largura/altura. `glassColor`, `aluminumColor` e `ironColor` aceitam texto livre não vazio; não há lista fechada nem normalização de cor. Como não havia chaves tipadas de espessura/cores no código, estas chaves são explicitadas neste contrato sem renomear ou remover outros campos do JSON histórico. Ausência é válida; chaves conhecidas presentes com `null`, texto vazio ou tipo inválido são rejeitadas. Campos extras do JSON continuam preservados.

Cada alias informado é validado, sem conversão de unidades e sem alteração da representação original (inclusive zeros à esquerda, espaços e notação exponencial aceitos). A validação se aplica ao cadastro e às medidas completas resultantes da correção parcial. Não migra nem reescreve dados históricos; correções novas devem respeitar positividade e demais regras aprovadas.

## Correção direta

`PATCH /service-orders/:id/products/:productId`

```json
{
  "expectedVersion": "12",
  "name": "Painel corrigido",
  "description": "Observação operacional corrigida",
  "measurements": { "widthMm": "1200.25" }
}
```

`expectedVersion` é a versão operacional canônica da consulta da OS, em string.
Campos corrigíveis: `name`, `description` (também aceita null) e
`measurements` (merge superficial com as medidas existentes, sem remover chaves
omitidas). Descrição respeita o limite persistido de 2000 caracteres.
Campos desconhecidos, IDs, composição, unidade e contadores são rejeitados.
Quantidade pode ser reenviada inalterada; toda mudança efetiva fica bloqueada
definitivamente por `productQuantityImmutable` (RF-10), independentemente do estado da produção. Fora de produção ativa, permanece também o bloqueio geral `productCorrectionNotAllowed`.

Autorização: administrador global, membro atual do setor com
`MANAGE_RESPONSIBILITY`, ou criador da própria OS com associação e permissão
`CREATE` atuais. Correção só ocorre em `IN_PRODUCTION`, administrativa `ACTIVE`
e produção ainda não encerrada. Aguardando entrega/instalação e estados
terminais não permitem correção. Não foram criados novos estados públicos.

Qualquer registro ou sinalização de qualidade do item bloqueia definitivamente mudanças de nome, descrição e medidas
(`productCorrectionQualityConflict`), inclusive quando já houver aprovação.
O bloqueio independe de aprovação, rejeição ou pendência e não se estende a outros produtos da mesma OS sem atividade própria de qualidade. Descrição não é exceção.
Não se apagam ou recalculam aprovações, inspeções nem eventos antigos.

O bloqueio transacional da OS e a versão esperada rejeitam sobrescritas
concorrentes (`serviceOrderVersionConflict`). Correções sem mudança são
rejeitadas (`productCorrectionUnchanged`). Cada correção grava evento canônico
`ServiceOrderProductCorrected` com `productId`, `previousValues`, `newValues`,
`correctedBy` e `correctedAt`, e Outbox na mesma transação da atualização do item.
IDs, quantidade, composição e revisão histórica do item são preservados.
O reducer CQRS aplica o evento sem apagar fatos anteriores.

Os comandos legados de solicitação/decisão de revisão ficam desativados
(`revisionWorkflowDisabled`); eventos históricos continuam interpretáveis.
Não há processo de aprovação, triagem, ciclo ou apontamento quantitativo novo.

## Decisões funcionais restantes

RF-07 está definido: espessura e cores opcionais, validadas quando informadas, sem classificador ou inferência por nome. Não há pendência de aplicabilidade.

RF-11 está definido: não há correções fora de `IN_PRODUCTION` ou após qualquer atividade de qualidade do próprio produto. Nenhuma pendência funcional de RF-11 permanece.

## Evidência e execução

### Validação RF-07 — 16/11/2026

- Yarn Classic 1.22.22; unitários de OS: 114/114 aprovados. Suíte completa pelo script `yarn test`: 224/224 aprovados, sem skips.
- Integração PostgreSQL RF-07/RF-09/RF-10/RF-11: 1/1 aprovada, sem skip, exclusivamente no recovery `feature004-recovery-20261113`, banco `feature004_recovery_integration`, usuário `feature004_recovery_dev`.
- Cadastro real com apenas obrigatórios e com opcionais verificado em sondagens rollback-only, preservando strings numéricas, JSON adicional, eventos e Outbox. Correção com opcionais e valores inválidos também verificada, sem mudar quantidade ou composição.
- Preflights confirmaram container saudável, identidade do banco/usuário e migrations previamente registradas. Não houve migration, limpeza ou alteração de registros históricos; a integração compara todos os registros preexistentes e conserva a OS de evidência de correção.

Teste unitário dedicado: `serviceOrderProductCorrection.test.js`.
Validação dedicada de produtos: `serviceOrderProductValidation.test.js`.
Integração dedicada: `service-order-product-correction-postgres.recovery.integration.test.js`.
A integração exige o recovery identificado, compara registros preexistentes,
usa uma OS com dois itens e executa sondagens de estado/qualidade em transação
rollback-only. Não executa limpeza nem reaplica migrations. A OS de evidência
permanece para preservar os eventos canônicos efetivamente gravados.

### Validação RF-11 — 16/11/2026

- Unitários de OS: 107/107 aprovados, incluindo os cinco estados proibidos, primeira sinalização sem aprovação, bloqueio permanente de nome/descrição/medidas e independência entre produtos.
- Integração PostgreSQL RF-09/RF-10/RF-11: 1/1 aprovada no projeto `feature004-recovery-20261113`, banco `feature004_recovery_integration`, usuário `feature004_recovery_dev`.
- Preflights: container PostgreSQL saudável, identidade do banco/usuário confirmada e migrations de reinspeção/prioridade previamente registradas. Nenhuma migration aplicada.
- A integração verifica autorização, valores anteriores/novos, autor/data, evento canônico e Outbox na mesma transação; quantidade menor/maior é recusada nos seis estados. Sondagens de estados e qualidade são revertidas e todos os registros históricos anteriores permanecem inalterados; a OS de evidência é preservada.
