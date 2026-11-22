# Data Model — Feature 005

**Plataforma**: somente PostgreSQL 17. Em produção, as tabelas novas e `budget` legado pertencem ao mesmo banco principal compartilhado pelos módulos da API, em uma única instância lógica principal. Não existe banco ou instância de produção exclusivo da Feature 005. Um servidor/banco descartável separado é permitido exclusivamente para integração isolada de testes.

**Status**: três migrations aditivas T008–T010 criadas (20261127000000, 20261128000000, 20261129000000), não executadas. Migration T011 (20261130000000) e cinco Models T012 agora criados, sem execução de DDL ou sync; o restante deste documento descreve o contrato alvo, não schema aplicado.
**Raiz**: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005.

## 1. Persistência canônica nova: budgets_pdf

| Campo                   | Tipo/obrigatoriedade            | Regra                                                                                       |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| id                      | UUID PK                         | interno, gerado pela aplicação                                                              |
| client_id               | UUID NOT NULL FK client         | ON DELETE/UPDATE RESTRICT                                                                   |
| sector_id               | UUID NOT NULL FK sectors        | RESTRICT                                                                                    |
| commercial_number       | VARCHAR(64) COLLATE C NOT NULL  | texto exato, não vazio, sem controles/espaços externos; UNIQUE(sector_id,commercial_number) |
| administrative_name     | VARCHAR(240) NOT NULL           | não branco, sem controles                                                                   |
| created_by              | UUID NOT NULL FK users          | autoria da sessão, RESTRICT                                                                 |
| created_at / updated_at | timestamptz NOT NULL            | UTC técnico, não validade                                                                   |
| revision                | bigint NOT NULL default 1       | >0, incrementado por mutação; serializado como string                                       |
| first_published_at      | timestamptz NULL                | uma vez definido, nunca apagado/trocado                                                     |
| published_object_id     | UUID NULL FK budget_pdf_objects | slot publicado                                                                              |
| published_validity_date | DATE NULL                       | par completo com objeto publicado                                                           |
| pending_object_id       | UUID NULL FK budget_pdf_objects | slot privado/candidato                                                                      |
| pending_validity_date   | DATE NULL                       | par completo com objeto pendente                                                            |

CHECKs: pares objeto/data ambos nulos ou ambos preenchidos; pelo menos um slot; slots distintos; publicado exige first_published_at; first_published_at definido exige publicado (não há despublicação aprovada). UNIQUE parcial para cada slot não nulo + verificação cruzada impedem mesmo objeto em outro orçamento/slot. FK composta do slot + id do orçamento para UNIQUE(id,owner_budget_id) no registry garante pertencimento. Constraint trigger ao commit valida objeto confirmado ATTACHED e compatível; transição de anexação exige READY sob lock, passando a ATTACHED na mesma transação. FKs/constraint triggers podem ser deferred até commit; CHECKs de pares permanecem imediatos e os pares são atualizados juntos.

Trigger novo de integridade em budgets_pdf impede UPDATE de cliente/setor/número quando OLD.first_published_at não nulo, impede apagar/alterar esse marco, impede alterar pares publicados sem troca de objeto e aumento de revision. Nome pode ser corrigido. Autoria/id/created_at imutáveis. A autorização permanece no caso de uso, não no trigger. Exclusão física permitida somente pelo caso de uso autorizado.

Índices: UNIQUE(setor,número), (sector_id,created_at DESC,id DESC), (client_id,created_at DESC,id DESC) WHERE published_object_id IS NOT NULL; índices dos FKs/slots. Não persistir válido/vencido, descrição, total, itens, status comercial, soft-delete ou histórico de PDF.

## 2. Registry durável: budget_pdf_objects

| Campo                      | Tipo                            | Regra                                                                |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| id                         | UUID PK                         | identificador técnico, não URL pública                               |
| owner_budget_id            | UUID NOT NULL                   | identidade reservada do orçamento; sem FK, sobrevive ao DELETE       |
| bucket / object_key        | VARCHAR(255) / TEXT NOT NULL    | UNIQUE(bucket,object_key), chave privada imutável e prefixo dedicado |
| created_by                 | UUID NOT NULL FK users RESTRICT | sessão do upload                                                     |
| state                      | texto CHECK                     | UPLOADING, READY, ATTACHED, CLEANUP_PENDING, CLEANING, REMOVED       |
| size_bytes                 | bigint NULL até validação       | >0 e <=10485760 ao READY                                             |
| sha256                     | CHAR(64) NULL até confirmação   | hash dos bytes validados; não ETag S3 como hash                      |
| content_type               | texto                           | application/pdf ao READY                                             |
| validity_date              | DATE NOT NULL                   | validade associada ao upload; copiada para slot correspondente       |
| expected_revision          | bigint NULL                     | NULL em criação; base de CAS em substituição                         |
| lease_token / lease_until  | UUID / timestamptz              | fencing de upload ou limpeza                                         |
| attempts / next_attempt_at | integer / timestamptz           | retries duráveis                                                     |
| last_error_code            | VARCHAR(128) NULL               | sem payload, token ou credencial                                     |
| confirmed_at / removed_at  | timestamptz NULL                | resultado técnico                                                    |
| created_at / updated_at    | timestamptz                     | rastreabilidade técnica                                              |

owner_budget_id não cria orçamento fantasma: objeto sem pai nunca é disponibilizado. CHECK estado/lease; índice pronto para limpeza por (state,next_attempt_at,id) e upload expirado por lease_until; índice owner_budget_id. Hash/size/validade confirmados imutáveis depois de READY. Objetos retirados nunca retornam ATTACHED; leases/token são CAS.

Estados são técnicos, não workflow comercial nem Event Sourcing. Registry não guarda bytes, documentos antigos recuperáveis ou API histórica. REMOVED guarda somente chave técnica para reconciliar PUT tardio; limpeza repetida é idempotente e pode reencontrar bytes sem reanexá-los. Sem purga automática até prova de término/ausência segura. Não usar tabelas de cleanup de Material ou sua enumeração.

**G-PDF fechado**: tamanho >0 e <=10485760, assinatura PDF e validação qpdf aprovada são pré-condições antes da intenção/PUT e de READY/ATTACHED. --requires-password e --check são processos separados, com códigos específicos em research.md. Não persistir arquivo rejeitado, conteúdo de stderr/stdout ou senha. Hash/tamanho vinculam os mesmos bytes temporários validados aos enviados; estado READY só após confirmação no MinIO e validação anterior bem-sucedida. Sem alteração nos pares/estados comerciais por esta decisão.

validity_date do registry descreve o upload confirmado; slots são a autoridade da validade comercial corrente. Correção administrativa da validade antes da primeira publicação pode mudar pending_validity_date sem reescrever o registry ou enviar PDF, conforme RF-017. Depois da primeira publicação, qualquer nova validade entra via novo upload; publicar sempre copia o par do slot pendente, não reconstrói validade a partir de registro histórico técnico.

## 3. Autorização comercial

### budget_commercial_managers

PK(user_id,sector_id), appointed_by FK users, created_at. User/Sector FKs RESTRICT. Concessão setorial nomeada/revogada exclusivamente por admin, sem autoconcessão. Usuário deve existir/estar ativo e, se role user, ter UserSector vigente. Não criar users.role=manager. Admin não precisa nomear a si mesmo para acesso global.

### budget_commercial_permissions

PK(user_id,sector_id,operation); operation CHECK CREATE_EDIT/READ/REPLACE_PDF/PUBLISH/DELETE/MANAGE_PERMISSIONS; granted_by FK users e created_at. Não duplicar identidade de usuário. Membership validado a cada operação; remoção de UserSector torna grants inefetivos, mesmo se persistidos. Gestor tem acesso às operações de orçamento/gestão nos setores administrados; colaborador só operações individuais concedidas. MANAGE_PERMISSIONS para colaborador autoriza somente as cinco operações delegáveis; não o torna gerente nem concede READ automaticamente.

### budget_commercial_permission_audit

UUID PK, actor_user_id, target_user_id, sector_id, action CHECK APPOINT_MANAGER/REVOKE_MANAGER/GRANT/REVOKE, operation opcional, occurred_at. FKs RESTRICT; imutável por permissões/trigger, sem conteúdo PDF. Registro na mesma transação da mudança. Não obrigar novo campo de motivo comercial que não foi aprovado. Sem autoconcessão; ampliação própria vedada ao gerente; revogação própria não implica permissão adicional e só ocorre se ator puder executar aquela revogação.

Locks de guard advisory por (ator/setor)/(destinatário/setor), ordenados, coordenam grants/revokes e streams. Para membro user, row lock compartilhado no UserSector existente quando necessário, sem alterar schema/serviço 003. Nomeação não cria membership implicitamente. Operações auditáveis retornam id de auditoria; grants repetidos iguais retornam unchanged sem nova concessão, revogação já ausente é idempotente.

## 4. Migrations novas planejadas

Todas CommonJS em /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/src/database/migrations, timestamps escolhidos somente na implementação após o maior existente (`20261126000000`), sem editar migrations antigas.

1. **Expansão auth comercial**: managers, permissions, audit, constraints/índices e proteção append-only da auditoria.
2. **Registry PDF**: budget_pdf_objects, constraints de estados/leases e índices de recuperação. Nenhuma integração no cleanup 003.
3. **Orçamento novo**: budgets_pdf, slots/FKs deferrable/constraint triggers, UNIQUE collation C, imutabilidade de identidade, índices e revisão.
4. **Integridade de ciclo**: validação cruzada de slots/registry e bloqueio de regressão para referências desanexadas; cenário de bootstrap da cadeia completa e rollback controlado. Separar esta migration apenas se simplificar dependência circular; não duplicar constraints.

Cada migration transacional quando compatível; constraint race no PostgreSQL traduzida para 409/412. Não executar createTable, sync ou seed fora da cadeia Sequelize CLI/public.SequelizeMeta. Nunca usar timestamps antigos menores que migrations aplicadas.

Down recusa tabela não vazia/auditoria ou registry pendente; rollback em ambiente com dados é operacional e revisado, não drop automático. Legado budget, Product, Material, OS e suas migrations não mudam.

## 5. Legado e reconciliação

Tabela budget antiga permanece íntegra e fora da nova API; nenhuma migração preenche setor/número/autor fictícios, publica ou converte datas automaticamente. Nenhum novo cadastro usa description_budget/total_value. Inventário e mapeamento aprovados podem fundamentar importação futura: validar cliente, setor, número exato, autoria original comprovada, data civil e bytes privados. Se dado obrigatório desconhecido, manter quarentena. Não atribuir ao operador a autoria original.

Reconciliação deve preservar mapa de identidade/importação idempotente, contagens e checksums e prova de backup recuperável antes de copiar qualquer registro. Não criar tabela de histórico monetário nova nem excluir dados antigos nesta fase. Objetos legados não são assumidos privados; inventário real de ACL/bucket é gate antes da exposição/importação.
