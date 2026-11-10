# Isolamento de containers PostgreSQL para rebuild e teste

## Status e escopo

`docker-compose.persistence.yml` é um Compose complementar e independente do
`docker-compose.yml` legado. Ele prepara, mas não inicia, duas instâncias PostgreSQL 17 e dois
serviços de API que reutilizam a mesma imagem Node.js 22.

| Finalidade | Serviço | Container | Database proposto | Porta do host proposta | Volume | Network |
| --- | --- | --- | --- | ---: | --- | --- |
| Rebuild isolado | `postgres-rebuild` | `postgres-alves-glass-rebuild` | `alvesglass_rebuild` | `5433` | `postgres_rebuild_data` | `persistence-rebuild-network` |
| Integração isolada | `postgres-test` | `postgres-alves-glass-test` | `alvesglass_test` | `5434` | `postgres_test_data` | `persistence-test-network` |

| Serviço API | Imagem/Dockerfile | Ativação | Comando | Rede autorizada | Porta HTTP |
| --- | --- | --- | --- | --- | --- |
| `api-dev` | `alves-glass-api:development` / `docker/dockerfile` | Serviço padrão | `yarn dev` | `persistence-rebuild-network` | `3000` proposta |
| `api-test` | Mesma imagem e Dockerfile | Profile Compose `test` | `yarn test` | `persistence-test-network` | Não publicada |

As portas são propostas estáticas. A disponibilidade delas não foi verificada porque esta etapa não
autoriza iniciar Docker. Nenhum dos serviços compartilha o volume `postgres_data`, a network
`app-network`, o container `postgres-alves-glass` ou qualquer bind mount de dados do Compose legado.

Os comandos de API são limitados a `yarn dev` e `yarn test`. O Compose complementar não declara
init scripts, migrations, bootstrap, `sequelize-cli`, DDL, limpeza ou `docker compose down -v`.

## Imagem única da API

O único Dockerfile da API está em `docker/dockerfile`. Ele usa `node:22-alpine`, instala as
dependências pelo Yarn Classic com `--frozen-lockfile` e define `yarn dev` como comando padrão.
`api-dev` e `api-test` recebem o mesmo bloco YAML reutilizável `x-api-image`, que declara a imagem
`alves-glass-api:development` e o único Dockerfile. Assim, não há duplicação de Dockerfile ou de
configuração de build, e uma execução futura isolada de `api-test` pode construir a imagem solicitada
sem depender de `api-dev` já ter sido iniciado.

O source é montado em `/app` para desenvolvimento. `api-test` monta o source como somente leitura e
não publica porta HTTP. O volume `api_node_modules` é compartilhado apenas pela imagem/API; não
armazena dados PostgreSQL e não é compartilhado com o Compose legado.

## Execução futura autorizável após revisão

Os comandos abaixo são documentação futura. Eles **não foram executados** nesta etapa:

```bash
# Preparar arquivos locais não versionados a partir dos templates.
cp .env.persistence-containers.example .env.persistence-containers
cp .env.persistence-api-dev.example .env.persistence-api-dev
cp .env.persistence-api-test.example .env.persistence-api-test

# Desenvolvimento: somente api-dev e postgres-rebuild na network de rebuild.
docker compose --env-file .env.persistence-containers -f docker-compose.persistence.yml up --build api-dev postgres-rebuild

# Testes sob demanda: profile test, api-test e postgres-test na network de teste.
docker compose --env-file .env.persistence-containers -f docker-compose.persistence.yml --profile test run --build --rm api-test
```

Não usar `docker compose down -v`. Os comandos não autorizam bootstrap, migrations, CLI ou DDL; isso
continua condicionado a T006, T026–T030 e às aprovações aplicáveis.

## Convenção de host e porta

Uma identidade T006 representa o endpoint usado pelo processo que executará a operação, não apenas
o nome de um container:

| Processo consumidor futuro | Host | Porta |
| --- | --- | ---: |
| Node executado no host local | `localhost` | `5433` para rebuild; `5434` para test |
| Processo em container na network dedicada | `postgres-rebuild` / `postgres-test` | `5432` |

Esses pares são identidades diferentes para `target-identity.js`. Antes de registrar uma allowlist,
o responsável deve escolher uma topologia de execução e confirmar o endpoint efetivamente observado.
Não é permitido registrar ambas como se fossem a mesma identidade nem inferir autorização pelo nome
do serviço, container ou database.

### Gate operacional local de `test`

O status e as integrações locais aprovados executam em runner Node efêmero na network
`api-alves-glass-clone_persistence-test-network`, conectando exclusivamente a
`postgres-test:5432`. Antes da conexão, um launcher no host confiável inspeciona somente
`postgres-alves-glass-test` e a network de teste em modo read-only, coleta container ID, serviço
Compose, network ID, endpoint ID e IP e os entrega como evidência ao runner. O runner não recebe o
socket Docker. A sessão PostgreSQL precisa confirmar `alvesglass_test`, principal autenticado,
transação `READ ONLY` e IP/porta iguais ao endpoint Docker inspecionado; qualquer ausência ou
divergência bloqueia. Não há fallback para `localhost:5434`.

Esse mecanismo é exclusivo do profile local `test`. A verificação Ed25519 existente permanece
disponível como alternativa para ambientes que requerem atestado criptográfico externo.

## T006: registros não versionados

O arquivo operacional deve permanecer em:

```text
/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/.baseline-identity.json
```

Esse arquivo já é ignorado pelo Git. Ele não deve ser criado a partir de placeholders. Depois de
aprovação humana dos endpoints efetivos, ele deverá conter exatamente a estrutura JSON abaixo:

```json
{
  "allowlist": [
    {
      "environment": "development",
      "host": "postgres-rebuild",
      "port": 5432,
      "database": "alvesglass_rebuild",
      "profile": "development-rebuild"
    },
    {
      "environment": "test",
      "host": "postgres-test",
      "port": 5432,
      "database": "alvesglass_test",
      "profile": "test"
    }
  ],
  "denylist": [
    {
      "reference": "legacy-development-alvesglass",
      "environment": "<AMBIENTE_LEGADO_APROVADO>",
      "host": "postgres",
      "port": 5432,
      "database": "alvesglass",
      "profile": "<PERFIL_LEGADO_APROVADO>"
    }
  ]
}
```

Os endpoints internos de rebuild/test refletem a topologia aprovada deste Compose, mas não são
identidades efetivamente observadas nem autorizações operacionais. Os valores entre `<...>` do legado
continuam deliberadamente incompletos. Não incluir username, password, token, URI ou URL com
credenciais nesse arquivo.

Para o processo Node executado no host, a configuração local futura deverá declarar, por perfil:

```dotenv
PERSISTENCE_PROFILE=<development-rebuild|test|inventory-readonly>
PERSISTENCE_INSTANCE_HOST=<host-aprovado>
PERSISTENCE_INSTANCE_PORT=<porta-aprovada>
PERSISTENCE_INSTANCE_PROFILE=<mesmo-perfil>
BASELINE_DB_HOST=<host-aprovado>
BASELINE_DB_PORT=<porta-aprovada>
BASELINE_DB_DATABASE=<database-aprovado>
PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE=legacy-development-alvesglass
BASELINE_IDENTITY_CONFIG_PATH=/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone/.baseline-identity.json
```

`development-rebuild` também exige `NODE_ENV=development`. Credenciais permanecem apenas na
configuração local não versionada e não pertencem ao arquivo de identidade.

## Limites operacionais

- O database legado `alvesglass` continua protegido pela denylist; esta documentação não autoriza
  `DROP DATABASE`, remoção de volume, limpeza, migration, bootstrap ou conexão.
- `alvesglass_rebuild` e `alvesglass_test` usam a topologia interna aprovada, mas suas identidades só
  entram na allowlist operacional após observação independente e validação humana.
- T006 continua aberta até que cada identidade tenha `environment`, `host`, `port`, `database` e
  `profile` completos, sem sobreposição/ambiguidade, e a referência protegida resolva exatamente uma
  entrada da denylist.
- T030 continua sendo o futuro limite que deverá observar e vincular identidade efetiva, estado do
  database, listas aprovadas e executor antes de qualquer operação real.