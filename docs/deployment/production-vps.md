# Alves Glass — Infrastructure em VPS

Este documento descreve o primeiro deploy da stack **Infrastructure** em Docker Compose standalone. Ele não declara que a VPS já foi reinstalada ou configurada. Os comandos abaixo são instruções e **não foram executados**.

## Escopo da Fase 1

O arquivo `deploy/infrastructure/compose.yml` contém Traefik, Portainer, um proxy restrito de Docker API para o provider do Traefik e um inicializador do volume ACME. Somente Traefik publica portas no host (`80` e `443`). Portainer é encaminhado por Traefik usando HTTPS e não publica portas próprias.

As stacks Alves Glass e Monitoring não fazem parte desta fase. Não presumir que API de produção, workers/consumers, MongoDB ou endpoints de métricas estejam prontos. O Compose de desenvolvimento na raiz e `docker/dockerfile` permanecem intocados.

## Imagens fixadas

| Serviço | Imagem |
|---|---|
| Traefik | `traefik:v3.7.18` |
| Portainer CE | `portainer/portainer-ce:2.45.3-alpine` |
| Docker socket proxy | `ghcr.io/tecnativa/docker-socket-proxy:v0.4.2` |
| Inicializador ACME | `busybox:1.37.0-musl` |

As tags são versões explícitas, não `latest`. Antes de cada atualização, conferir notas de versão, compatibilidade e advisories; em mudança de versão, registrar e validar o digest da arquitetura `linux/amd64` da VPS.

## Topologia

```text
Internet :80/:443
       |
       v
Traefik -- rede externa edge -- Portainer (backend HTTPS :9443)
   |
   +-- rede interna docker-api -- docker-socket-proxy -- Docker Socket
```

- `edge` é externa e será compartilhada futuramente com API e Grafana. Não conecte bancos, Redis, RabbitMQ, MinIO, Prometheus, Loki, Alloy ou exporters a ela sem uma necessidade específica aprovada.
- `alves_infrastructure_docker_api` é interna, sem rota externa, usada somente entre Traefik e o proxy Docker API.
- O Portainer monta o Docker Socket para gerenciar o Docker standalone; por isso ele é uma interface administrativa de alto privilégio. A porta do Portainer não é publicada no host.
- O proxy de socket limita o provider do Traefik a leitura de containers, eventos, informações e redes, com `POST=0`. Ele não substitui proteção do host nem elimina o risco do socket montado no Portainer.
- `traefik_acme` e `portainer_data` são volumes nomeados persistentes.

## Pré-requisitos do host

1. Ubuntu Server LTS ou outra distribuição Linux suportada e atualizada, com acesso administrativo controlado.
2. Docker Engine e plugin Docker Compose instalados de acordo com a documentação oficial para a distribuição. Não instale Docker durante este procedimento sem validar o estado atual do host.
3. Confirmar que portas 80 e 443 estão liberadas no firewall da VPS e no firewall do provedor; não abrir portas administrativas ou de dados.
4. Confirmar arquitetura `linux/amd64`, espaço livre e backups dos dados existentes antes de qualquer mudança operacional.
5. Definir DNS do domínio real do Portainer apontando para o IP público da VPS. Se houver IPv6, o registro AAAA também precisa apontar para um serviço que realmente aceite 80/443.

## Diretórios e preparação

Copie o repositório para diretório operacional dedicado, por exemplo `/opt/alves-glass`, sem copiar `.env` de desenvolvimento nem dados locais. Execute os comandos abaixo manualmente somente após confirmar host, domínio, DNS e firewall:

```sh
sudo install -d -m 0750 /opt/alves-glass
cd /opt/alves-glass
sudo install -d -m 0750 deploy/infrastructure
cp deploy/infrastructure/.env.example deploy/infrastructure/.env
chmod 0600 deploy/infrastructure/.env
```

Edite `deploy/infrastructure/.env` com `PORTAINER_HOST` e `ACME_EMAIL` reais. O domínio é configurável e não está definido por este repositório. Não coloque senha administrativa do Portainer nesse arquivo.

## Rede externa `edge`

Crie a rede uma única vez antes da stack:

```sh
docker network create edge
```

As futuras stacks devem referenciar a mesma rede externa, não recriá-la com outro nome. Adicione à rede somente Traefik e serviços explicitamente publicados, inicialmente Portainer; futuramente API e Grafana. Não conectar serviços de dados ou endpoints de monitoramento públicos à `edge`.

## Portainer: bootstrap e proteção

Portainer usa HTTPS habilitado e HTTP desabilitado no container. Traefik acessa o backend pela porta interna 9443 usando TLS; como Portainer apresenta certificado próprio, o transport interno do Traefik usa `insecureSkipVerify`. O tráfego externo continua protegido pelo certificado público Let's Encrypt. Essa configuração não valida a identidade TLS do backend interno; mantenha a comunicação restrita à rede Docker `edge` e reavalie se houver uma CA/certificado interno confiável.

O primeiro usuário administrador e sua senha forte são criados no assistente web do Portainer, não no repositório. A documentação do Portainer informa uma janela de cinco minutos para concluir a criação inicial do administrador; esteja preparado para acessar o domínio imediatamente depois da inicialização. Use senha aleatória, única, longa (mínimo de 12 caracteres conforme o assistente) e armazenada em gerenciador de senhas. Não habilite endpoints/túneis que não serão usados; a porta 8000 não é publicada.

O acesso por subdomínio público foi autorizado. Como controle adicional, avaliar allowlist de IP ou autenticação adicional no Traefik depois de confirmar como os administradores acessam a VPS. Não ativar uma regra de allowlist sem IPs administrativos conhecidos, pois isso pode bloquear o acesso de recuperação. A autenticação nativa do Portainer e HTTPS são obrigatórios.

## Traefik e Docker Socket

O provider Docker usa `exposedByDefault: false`, sem Swarm, e apenas Portainer tem `traefik.enable=true`. A API/dashboard do Traefik não é publicado nem roteado. O dashboard está desabilitado.

O provider Docker do Traefik usa `ghcr.io/tecnativa/docker-socket-proxy:v0.4.2` numa rede interna. O proxy monta o socket somente para leitura e permite endpoints de leitura para discovery, com `POST=0`. Portainer, por sua função administrativa, ainda monta o socket diretamente em modo somente leitura: **read-only no bind mount não transforma a Docker API em read-only**. Um Portainer comprometido pode controlar containers e afetar o host; proteja credenciais, mantenha o acesso administrativo restrito e não reutilize esse socket na API/workers.

O proxy Docker não publica a porta 2375 no host. Nenhum processo externo deve receber acesso ao socket ou a essa rede interna.
- O provider Docker precisa consultar metadados dos containers. A permissão `CONTAINERS=1` é mais ampla que uma allowlist por rota: pode permitir leitura de configurações/variáveis de ambiente e endpoints de containers. Por isso, não passe credenciais em variáveis de ambiente dos containers descobertos pelo Traefik; prefira arquivos/secrets. O proxy selecionado está fixado na versão `v0.4.2`; antes do primeiro deploy, revisar avisos de segurança e validar em teste isolado a compatibilidade com a versão do Docker Engine instalada. Não atualizar para outra versão sem repetir essa validação.

## Validar configuração antes de iniciar

```sh
cd /opt/alves-glass/deploy/infrastructure
docker compose --env-file .env config --quiet
```

O comando valida a configuração sem iniciar containers. Não compartilhe a saída completa de `docker compose config` quando variáveis secretas forem adicionadas futuramente.

## Inicialização — executar somente após aprovação operacional

O seguinte procedimento inicia a stack; ele está documentado, não foi executado nesta tarefa:

```sh
cd /opt/alves-glass/deploy/infrastructure
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

O serviço `acme-init` cria `acme.json` no volume ACME e aplica modo `0600` antes do Traefik iniciar. Para domínio novo, HTTP-01 requer DNS correto e acesso público à porta 80; a porta 443 serve HTTPS. Não solicite certificados de produção repetidamente durante depuração; use o endpoint de staging somente após planejar a validação e evitar limites do Let's Encrypt.

## Verificações operacionais

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=100 traefik portainer docker-socket-proxy
docker volume inspect alves_infrastructure_traefik_acme
docker volume inspect alves_infrastructure_portainer_data
```

Verifique em ambiente real que:

- `http://PORTAINER_HOST` redireciona a HTTPS;
- o certificado apresentado em `https://PORTAINER_HOST` é válido para o domínio;
- o assistente exige criação do administrador e o login persiste após reiniciar Portainer;
- somente portas 80/443 estão publicadas por esta stack;
- dashboard/API do Traefik não está acessível publicamente;
- os volumes permanecem após recriação dos containers;
- o Portainer consegue administrar o Docker local, e Traefik descobre somente containers autorizados por labels.

Essas verificações de DNS, ACME, autenticação e comportamento real são testes integrados pendentes; a validação local de YAML/Compose não prova que funcionem na VPS.

## Atualização, reinício e rollback

Antes de atualizar, registrar versão/digest atuais, revisar release notes, fazer backup do volume Portainer e preservar a configuração/estado ACME. Atualizar uma imagem por vez, validar health/logs e testar o acesso web. Não remover volumes ao fazer rollback. Reverter para a tag/digest anterior em caso de incompatibilidade; verificar notas de downgrade do Portainer antes de restaurar dados de versão mais nova.

Reinício controlado:

```sh
docker compose --env-file .env restart traefik portainer docker-socket-proxy
```

Encerramento da stack, sem remover volumes:

```sh
docker compose --env-file .env down
```

Não usar `down -v` em operação normal: isso apaga volumes nomeados, incluindo estado ACME e dados administrativos do Portainer.

## Integração das próximas stacks

- **Alves Glass:** seu Compose deverá anexar apenas API/workers autorizados à rede externa `edge`, marcar explicitamente os serviços publicados e manter dados numa rede privada própria. Traefik continuará sendo o único serviço com portas públicas. A Fase 1 não configura nem presume API de produção, workers, MongoDB, RabbitMQ, Redis ou MinIO.
- **Monitoring:** Grafana poderá entrar em `edge` e receber roteamento HTTPS por subdomínio. Prometheus, Loki, Alloy e exporters permanecerão em redes privadas de monitoramento, sem rotas públicas. A integração deve ser revisada quando os Compose das fases seguintes forem aprovados.
- A configuração `trust proxy` da API permanece pendente para a fase da aplicação, até validar IPAM, acesso direto e cadeia real do proxy. Esta fase não altera `src/app.js` nem configura headers de proxy na API.

## Backups e recuperação

Faça backup cifrado e fora da VPS dos arquivos de configuração e volumes `alves_infrastructure_portainer_data` e `alves_infrastructure_traefik_acme`. O volume ACME contém material sensível: restrinja acesso e nunca publique seu conteúdo. Faça backup antes de updates e ensaie restore em ambiente isolado. Guarde cópia protegida do `.env` de produção fora do host/repositório, com acesso restrito; este arquivo contém domínio e e-mail, não credenciais do Portainer.