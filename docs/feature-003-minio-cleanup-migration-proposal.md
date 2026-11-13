# Proposta — migration de tarefas de limpeza MinIO (aguardando aprovação)

**Estado:** proposta aprovada conceitualmente e implementada aditivamente por
`src/database/migrations/20261117000000-add-material-images-and-minio-jobs.cjs`. Foi aplicada em banco
descartável `feature003_ephemeral` (PostgreSQL 17.11), nunca no banco persistente. Os Models foram
registrados em `src/database/index.js`. A integração MinIO continua fora do HTTP e desabilitada
operacionalmente até G5.

## DDL aditivo proposto

```sql
CREATE TYPE minio_cleanup_job_status AS ENUM ('PENDING','PROCESSING','RETRY','DONE','BLOCKED');
CREATE TABLE minio_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket varchar(255) NOT NULL CHECK (length(btrim(bucket)) > 0),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
  status minio_cleanup_job_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(128),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PROCESSING') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status = 'DONE') = (processed_at IS NOT NULL))
);
CREATE INDEX minio_cleanup_jobs_ready_idx
  ON minio_cleanup_jobs (next_attempt_at, created_at, id)
  WHERE status IN ('PENDING','RETRY');
CREATE INDEX minio_cleanup_jobs_lease_idx
  ON minio_cleanup_jobs (locked_at, id) WHERE status = 'PROCESSING';
CREATE UNIQUE INDEX minio_cleanup_jobs_active_object_idx
  ON minio_cleanup_jobs (bucket, object_key)
  WHERE status IN ('PENDING','PROCESSING','RETRY','BLOCKED');
```

`materials` aditivo: `image_bucket varchar(255) NULL`, `image_object_key text NULL`,
`image_visibility varchar(8) NULL CHECK (image_visibility IN ('public','private'))`; constraint de
unicidade NULL-ness exige os três campos nulos ou preenchidos; índice parcial
`(image_bucket,image_object_key)` WHERE `image_object_key IS NOT NULL`. Sem URL persistida e sem FK para
jobs. Todo objeto recebe chave nova, nunca é sobrescrito nem reanexado. Worker checa essa referência
e qualquer outra referência de objeto antes da remoção.

`gen_random_uuid()` deve ser verificado contra a versão/ambiente aprovado; alternativa Sequelize pode
gerar UUID no cliente e retirar o default PostgreSQL. `updated_at` será mantido pelo worker/serviço.
`locked_by` identifica instância/worker; leases vencidos são retomáveis após prazo operacional
configurado. Claim concorrente usa uma transação curta `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N`,
altera para PROCESSING, grava `locked_at/locked_by`, incrementa `attempts` e confirma. O delete MinIO
é idempotente: sucesso ou “objeto inexistente” vira DONE; erro transitório grava `last_error`, limpa
lease, agenda RETRY com backoff limitado. Erro permanente/objeto ainda referenciado fica BLOCKED para
reconciliação/ação, sem apagar.

Imediatamente antes do delete, consultar referências ativas (bucket + chave) no PostgreSQL. A gravação
da nova referência e a tarefa para a referência anterior ocorrem na mesma transação. Há uma janela de
corrida entre consulta de referência e delete se referências puderem ser reativadas; portanto chaves
de objetos são imutáveis e nunca devem ser reanexadas, ou a referência precisa de lock/advisory lock
coordenado com workers. Proposta prefere política imutável: toda substituição cria objeto novo, chaves
anteriores nunca são reutilizadas.

## Alterações concretas dos três objetos de persistência propostos

### 1) `materials` — associação à imagem (aditiva)

Adicionar `image_bucket varchar(255) NULL`, `image_object_key text NULL` e
`image_visibility varchar(8) NULL CHECK (image_visibility IN ('public','private'))`. Constraint garante
que bucket/chave/visibilidade sejam todos NULL ou todos não-NULL. Índice parcial em
`(image_bucket,image_object_key)` para referências existentes. Sem FK para tabela de jobs: referência
ativa é fonte da verdade e não se apaga automaticamente. Material guarda bucket/chave, não URL
temporária nem conteúdo binário. Chaves são únicas/imutáveis, nunca sobrescritas ou reanexadas. Não há
mudança do comportamento QR nesta proposta.

### 2) `minio_cleanup_jobs`

DDL acima: UUID PK, bucket/key, estados PENDING/PROCESSING/RETRY/DONE/BLOCKED, attempts, last_error,
next_attempt_at, locked_at/by, processed_at e timestamps. Índices parciais de fila/lease e unique parcial
por `(bucket,object_key)` para impedir duplicidade ativa. Não há FK para Material pois uma chave pode
ser referenciada por qualquer entidade atual/futura; worker consulta referências ativas.

### 3) `minio_upload_intents`

```sql
CREATE TYPE minio_upload_intent_status AS ENUM ('UPLOADING','COMMITTED','ABANDONED');
CREATE TABLE minio_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket varchar(255) NOT NULL CHECK (length(btrim(bucket)) > 0),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
  status minio_upload_intent_status NOT NULL DEFAULT 'UPLOADING',
  created_by uuid NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  last_error text,
  lease_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key),
  CHECK ((status = 'COMMITTED') = (completed_at IS NOT NULL))
);
CREATE INDEX minio_upload_intents_expired_idx
  ON minio_upload_intents (lease_expires_at, created_at, id) WHERE status = 'UPLOADING';
CREATE INDEX minio_upload_intents_object_idx ON minio_upload_intents (bucket, object_key, status);
```

Intenção persistida ANTES de `putObject`, usando chave gerada única e lease renovável durante o upload.
Depois do upload, uma única
transação PostgreSQL bloqueia Material, troca referência, marca intenção COMMITTED e insere cleanup job
para a referência anterior. Worker/recuperador só examina UPLOADING com lease vencida; verifica a
referência em `materials` e demais tabelas registradas, e após período de segurança verifica novamente
antes de enfileirar cleanup. COMMITTED nunca é órfão por essa regra. ABANDONED só após objeto confirmado
ausente ou cleanup durável enfileirado; exclusão sempre passa pelo mesmo worker e verificação global de
referências. Falha/crash entre put e commit deixa UPLOADING recuperável. `last_error` deve ser sanitizado
e limitado; sem credenciais/URLs assinadas.

## Recuperação de uploads órfãos

O fluxo assume as duas tabelas aprovadas arquiteturalmente, pendentes de revisão deste schema. Intent
pré-upload recupera crashes conhecidos. Varredura independente do bucket pode localizar objetos sem
intent; reconciliador compara listagem com referências e intents ativas, aguarda janela de segurança,
repete consulta de referências e só então enfileira cleanup. Isso é necessário para recuperar objetos
de uploads antigos/anteriores à introdução das intents.

## Down/rollback

Rollback destrutivo não é automático: rejeitar `down` quando houver tarefas não-DONE, ou exigir backup,
paralisação e exportação/auditoria aprovadas. `DROP TABLE/TYPE` só em ambiente descartável vazio e após
aprovação explícita. Esta proposta não executou SQL nem operação MinIO.