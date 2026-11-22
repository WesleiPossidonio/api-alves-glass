# Auditoria de seleção Git — Feature 005 (21/11/2026)

Registro de classificação para staging, não autorização de deploy nem novo aceite de T001–T066. A comparação considera os arquivos tracked alterados desde `master` e os untracked da 005; `HEAD` coincide com a referência local `master` no momento da seleção. Não houve fetch, execução das regressões 003/004 nesta auditoria ou acesso aos seus ambientes.

## Script e credenciais de `package.json`

Quatro scripts da 005 foram adicionados: unit, contract, integration e cleanup-worker, todos apontando para o runner Node.js da feature. Nenhuma dependência de runtime/desenvolvimento e nenhum lockfile foram alterados. No script recovery 004, o único delta efetivo é `--test-concurrency=1` e seleção `*recovery.integration.test.js` em vez de `*.integration.test.js`: exclui PR5 da seleção das nove recovery, que têm gate separado. As atribuições literais preexistentes de banco, RabbitMQ e segredo de cursor são **idênticas às de `master`**, não aparecem em scripts novos da 005 e correspondem aos identificadores do Compose de recovery 004, descritos em `deploy/feature004-test/README.recovery.md` como locais e descartáveis. Não há evidência de credencial de produção ou exposição adicional pelo diff. `package.json` é elegível ao staging somente para reprodução do código/testes; esses valores de teste não devem ser reutilizados operacionalmente. Nenhum valor é reproduzido aqui.

## Ajustes de regressão 003/004 incluídos separadamente

- `tests/integration/service-orders/service-order-client-tracking-cqrs.recovery.integration.test.js` (RF31) e `tests/integration/service-orders/service-order-read-history-cqrs.recovery.integration.test.js` (RF32): removem a dependência de uma OS/clientes persistidos por outra suíte e usam `recovery-identity-fixture.js` dentro da transação rollback-only. O stub de canal RF32 delega listeners `on/removeListener` ao canal confirm real, preservando `publish` e as verificações de 18 eventos. Assertions de isolamento, snapshots, replay e totais originais não foram removidas. Correção e reexecuções independentes/9 recovery aceitas estão registradas em `t062-scope-review.md` (seção de 21/11/2026); não se afirma repetição nesta seleção.
- `tests/integration/stock/material-image-postgres-minio.integration.test.js` e `tests/integration/stock/minio-real.integration.test.js`: instanciam a factory MinIO já existente com o ambiente do teste e injetam o cliente em `StorageServiceClient`; o cliente default é nulo com `NODE_ENV=test`. Mantêm as asserções existentes e evitam mudar o serviço/configuração 003. As execuções PG/MinIO e MinIO 003 aceitas para T062 constam da matriz final do mesmo relatório.

Esses arquivos e o seletor de `package.json` são necessários para reproduzir a evidência T062 de compatibilidade na branch 005; não alteram código de produção, migrations, contratos funcionais ou infraestrutura das Features 003/004. Caso o responsável queira separá-los da PR, deverá providenciar outro meio versionado e aprovado de reproduzir o gate; não descartar alterações por presunção.

## Spec Kit e fronteiras

`specs/005-budgets-pdf/` contém especificação, contratos, histórico sanitizado e aceites; versionável. `.specify/feature.json` altera somente o ponteiro da feature ativa do checkout, já versionado em `master`, mas é estado local e **não** entra nesta seleção. `.specify/templates/plan-template.md` foi restaurado do template oficial para planejamento; não é necessário para executar, migrar ou testar a 005 e fica fora do staging, sem descarte. Cache local `.specify/.cache/`, `node_modules`, `.env` reais, manifestos/recibos e logs privados não entram no índice. Fixtures PDF em `tests/fixtures/budgets/` são documentos sintéticos gerados, sem dados de clientes, conforme README do diretório.

Após a seleção, verificar índice por caminhos explícitos, ausência de segredos/artefatos privados, `git diff --cached --check` e arquivos obrigatórios. Gates técnicos aceitos não equivalem a backup MinIO, supervisão, gestão de segredos, limites/UID não-root ou autorização de release.

## Integridade das fixtures no índice

`git diff --cached --check` inicialmente interpretou PDFs sintéticos como texto e sinalizou espaços finais dos registros xref, que são bytes necessários ao formato PDF. Em vez de reescrever fixtures aceitas, `.gitattributes` delimita `-diff` **somente** a `tests/fixtures/budgets/*.pdf`; seus bytes permanecem intactos e serão versionados como binários. Essa regra não afeta migrations, documentação ou testes de texto.