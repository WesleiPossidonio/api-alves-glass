# Contrato de configuração não versionada da fundação de persistência

## Finalidade

Este contrato define os campos que a implementação futura da fundação de persistência deverá ler
sem expor segredos. Ele acompanha `.env.example`, mas não substitui a configuração real local e não
autoriza bootstrap, conexão administrativa, migrations, DDL ou rebuild nesta fase.

Os valores operacionais reais, incluindo destinos autorizados e identidades protegidas, permanecem
fora do repositório. Eles não devem ser adicionados a `.env.example`, a este documento, a testes de
unidade ou a logs.

## Perfis reconhecidos

| Perfil | Finalidade nesta feature | Limite operacional |
| --- | --- | --- |
| `development-rebuild` | Rebuild futuro de banco isolado de desenvolvimento. | Bloqueado até T006 receber registros reais aprovados e até os preflights posteriores serem implementados. |
| `test` | Validação futura contra PostgreSQL isolado de teste. | Não autoriza destinos de desenvolvimento nem substitui registros reais. |
| `inventory-readonly` | Inventário futuro do legado/original em modo somente leitura. | Não autoriza bootstrap, migration, DDL ou alteração de dados. |

## Campos declarados em `.env`

| Campo | Obrigatoriedade | Regra |
| --- | --- | --- |
| `PERSISTENCE_PROFILE` | Obrigatório | Deve ser um dos perfis reconhecidos. |
| `NODE_ENV` | Obrigatório para operações futuras de rebuild | `development` isoladamente não autoriza nenhuma operação. |
| `PERSISTENCE_INSTANCE_HOST` | Obrigatório | Parte da identidade da instância declarada. |
| `PERSISTENCE_INSTANCE_PORT` | Obrigatório | Porta válida da instância declarada. |
| `PERSISTENCE_INSTANCE_PROFILE` | Obrigatório | Deve ser coerente com o perfil solicitado. |
| `BASELINE_DB_HOST` | Obrigatório | Parte da identidade completa do destino. |
| `BASELINE_DB_PORT` | Obrigatório | Parte da identidade completa do destino. |
| `BASELINE_DB_DATABASE` | Obrigatório | Parte da identidade completa do destino. |
| `BASELINE_DB_USERNAME` | Obrigatório quando houver conexão futura | Credencial não versionada; nunca registrar em logs. |
| `BASELINE_DB_PASSWORD` | Obrigatório quando houver conexão futura | Segredo não versionado; nunca registrar em logs. |
| `PERSISTENCE_PROTECTED_ORIGINAL_REFERENCE` | Obrigatório | Referência não sigilosa ao registro protegido do original; não substitui a identidade completa na denylist. |
| `BASELINE_MIGRATIONS_PATH` | Obrigatório para CLI futura | Caminho absoluto, existente e exatamente igual ao diretório canônico futuro; caminhos legados e alternativos devem bloquear. |
| `BASELINE_IDENTITY_CONFIG_PATH` | Obrigatório para operações futuras | Caminho para arquivo não versionado que contém as listas reais aprovadas. |

## Configuração de identidade não versionada

O arquivo apontado por `BASELINE_IDENTITY_CONFIG_PATH` é externo ao repositório e deve conter:

- uma **allowlist** não vazia de destinos autorizados;
- uma **denylist** não vazia de identidades protegidas;
- a identidade completa do banco original na denylist;
- para cada identidade: ambiente, host, porta, database e perfil/identificação lógica.

Nenhum valor de allowlist ou denylist é definido neste contrato. A operação futura deverá bloquear
quando as listas estiverem ausentes, vazias, ambíguas, sobrepostas, incompletas ou quando a
identidade efetiva não corresponder exatamente a uma entrada autorizada e a nenhuma protegida.

## Separação e segurança

- `.env.example` documenta somente nomes de variáveis, nunca valores operacionais reais.
- `.env` e o arquivo de identidade são locais e ignorados pelo Git.
- `public.SequelizeMeta` e migrations legadas permanecem independentes.
- A metadata futura do baseline está aprovada como `baseline_meta.SequelizeMetaBaseline`, sem
  fallback por `search_path`; esta decisão não autoriza DDL nesta fase.
- `baseline:status` local executa somente por runner efêmero na rede de teste, com gate Docker+sessõo
  e consultas read-only; sem conjunto canônico de migrations ou evidência completa, retorna
  `blocked`. `baseline:apply`, bootstrap e qualquer DDL continuam bloqueados fora dos gates próprios.