# Registro de execução (12/11/2026)

- Projeto Compose: `feature003-disposable`; container `feature003-postgres-test`; database
  `feature003_ephemeral`; usuário gerado para o teste; PostgreSQL 17.11.
- Porta efetiva: `127.0.0.1:55437`; volume novo exclusivo `feature003_pgdata`; network
  `feature003-test-net`, sem outros endpoints. Nenhum volume preexistente montado.
- A configuração inicial `internal: true` impediu a publicação da porta, apesar do mapeamento
  explícito. Foi corrigida para network não-interna, e a inspeção confirmou bind somente em loopback.
- Migrations: 16 aplicadas em banco vazio, incluindo a migration aditiva de imagens e intents. Sem
  rollback destrutivo executado.
- Testes PostgreSQL direcionados: relatórios e schema MinIO, 2/2 passaram. Suíte unitária: 94/94.
- O serviço está saudável e mantido ativo; credencial local em `.env` com modo 0600, ignorada pelo git.
- Sem acesso ao MinIO real, criação de buckets, mudança de permissões ou migrations em banco persistente.

# Plano proposto — PostgreSQL descartável para Feature 003

**Aguardando autorização explícita antes de executar qualquer comando Docker que crie/altere recursos.**
O usuário autorizou preparar um ambiente exclusivo, mas pediu plano concreto antes de ações Docker.

O Compose preparado em `deploy/feature003-test/compose.yml` corresponde ao plano. Inspeções read-only
confirmaram que não existem ainda `feature003-postgres-test`, `feature003_pgdata` ou
`feature003-test-net`; nada foi criado.

## Plano de execução

1. Criar configuração separada `deploy/feature003-test/compose.yml` sem referências a Compose legado,
   rebuild ou produção. Um único serviço `postgres:17`, serviço/container de nome exclusivo
   `feature003-postgres-test`, porta loopback `127.0.0.1:55437`, network exclusiva `feature003-test-net`
   `internal: true`, sem dependências com API, sem `container_name` compartilhado, sem bind mounts.
2. Credencial de teste aleatória, criada em arquivo ignorado local `deploy/feature003-test/.env`
   e nunca impressa/logada; configurar `POSTGRES_DB=feature003_ephemeral`, usuário aleatório e volume
   nomeado exclusivo `feature003_pgdata`. Dados criados nesse volume serão exclusivamente descartáveis.
3. Antes do início, leitura Docker read-only para garantir que container/volume/network com esses nomes
   não existam e que porta esteja livre. Se algum existir, parar e pedir decisão — nunca reaproveitar.
4. Após autorização, `docker compose ... up -d postgres` só cria o stack nomeado acima. Validar por
   `docker inspect` nomes/ID/volume/network/porta/imagem e via conexão SQL `current_database()`,
   `current_user`, `inet_server_addr()`, `inet_server_port()`, `version()`. Recusar se divergente.
5. Usar credenciais exclusivas apenas no processo do runner, com proteção adicional para exigir
   `DB_DATABASE=feature003_ephemeral`, porta 55437 e host 127.0.0.1. Nenhum `.env` de projeto é lido;
   nenhum dado legado é copiado. Aplicar somente migrations Feature 003 explicitamente aprovadas e
   fixtures com UUID/prefixo de teste. Sem cleanup global; fixtures isolam os dados criados por ID e
   transações/rollback quando compatíveis com constraints append-only.
6. Ao final preservar logs/resultados e parar o container sem remover volume. Remoção do container,
   network/volume ou `down -v` requer nova autorização explícita; não incluída no plano autorizado.

## Recursos possíveis (somente após autorização)

- Container: `feature003-postgres-test` (novo, exclusivamente efêmero).
- Volume: `feature003_pgdata` (novo, sem qualquer volume existente).
- Network: `feature003-test-net` (nova e isolada).
- Porta host: `127.0.0.1:55437` (não usa 5432/5433/5434).
- Database: `feature003_ephemeral`.

Este plano não foi executado; nenhuma credencial foi criada e nenhum recurso Docker foi modificado.