# RF-31 — acompanhamento mínimo do cliente

## Integração encontrada

Este repositório contém o backend, não o código do sistema consumidor.
O mecanismo existente é HTTP com sessão autenticada por cookies:
`POST /session/client`, cookie access_token, sessão ativa no PostgreSQL e
requireClient. Leituras legadas `/client/me` e `/order/me` usam a identidade da
sessão; não foram modificadas, nem Order/OrdersProducts ou autenticação global.
Não há evidência aqui do consumo efetivo do frontend de OS. Não foram criados
endpoint, webhook, integração externa ou novo módulo do cliente.

Reutilizada a rota existente `GET /service-orders/client/me?limit=...&cursor=...`.
IDs de cliente enviados no HTTP não selecionam proprietário: o controller usa
request.userId da sessão. RF-32 (`GET /service-orders/:id`) continua requireUser.
O método legado clientOrder não possui rota e não ganhou uma nesta execução;
se invocado internamente, também usa o DTO mínimo, sem histórico RF-32.

## DTO e marcos definidos

```json
{
  "data": {
    "serviceOrders": [
      {
        "order": {
          "id": "uuid-da-os",
          "externalNumber": "000123",
          "status": "Em produção"
        }
      }
    ],
    "nextCursor": null
  }
}
```

Seis correspondências estritas, expressamente aprovadas:

- REGISTERED → Pedido cadastrado;
- AWAITING_SUPPLIER → Aguardando fornecedor;
- IN_PRODUCTION → Em produção;
- AWAITING_DELIVERY → Aguardando entrega/instalação.
- COMPLETED → Concluído;
- CANCELLED → Cancelado.

O número textual vem do PostgreSQL e preserva zeros. Sem produtos, medidas,
contadores, pessoas, atribuições, prioridade, permissões, eventos, qualidade,
versões operacionais ou geração de projeção no DTO. A paginação reutiliza o
cursor assinado existente e valida cliente, geração, data e ID de continuação.

Ownership é filtrado no repositório PostgreSQL e revalidado canonicamente antes
de acessar MongoDB. Identidades projetadas também precisam coincidir com o
canônico. Projeção ausente, atrasada ou discordante do estado canônico retorna
projectionPending (503), sem fallback para status antigo nem dados internos.

## Estados desconhecidos e compatibilidade histórica

A implementação anterior usava publicStatus com sete estados legados e fallback
CREATED; também enviava produtos e metadados operacionais. Isso não constitui
mapeamento válido para estados históricos não reconciliados. Os seis estados
funcionais vigentes agora possuem mapeamento aprovado, inclusive REGISTERED,
COMPLETED e CANCELLED. Uma página pode conter todos eles normalmente.

Uma consulta que alcança OS em estado desconhecido ou histórico sem mapeamento retorna
clientStatusMappingPending (409), sem payload operacional ou status não aprovado.
A lista não filtra/oculta tais pedidos silenciosamente: a página inteira falha.
Esse bloqueio não se aplica aos seis estados funcionais aprovados. Nenhum estado
legado é reinterpretado automaticamente e nenhuma reconciliação de dados ocorre.
Não se usa uma projeção antiga de Em produção para ocultar conclusão/cancelamento.

## Validação

Unitários cobrem os seis estados, allowlist, autoria por sessão, isolamento entre
clientes, sessão ausente/revogada, cliente impedido de acessar leitura interna,
cursores e rejeição de projeção inconsistente.

Integração recovery usa PostgreSQL/Outbox e MongoDB reais; fixtures canônicas em
transação rollback-only, geração Mongo exclusiva sem ativação. Não cria clientes,
OS ou eventos permanentes, não apaga dados e compara os registros anteriores.
O teste isola IDs de fixtures na listagem, mantendo o filtro real client_id do
repositório PostgreSQL. Não prova frontend externo, RabbitMQ ou login completo;
autenticação HTTP é exercitada separadamente nos unitários com sessão simulada.
