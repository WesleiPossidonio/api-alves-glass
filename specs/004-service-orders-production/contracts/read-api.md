# Feature 004 — Contratos de leitura e separação de superfícies

**Status:** contrato consolidado da implementação atual. Rotas físicas em `src/routes.js`, autorização canônica em `ServiceOrderReadService` e evidências em `../final-validation.md`.

## Consumidores internos

A API deve oferecer, conforme autorização vigente:

- Consulta por `setor + número textual do pedido` para o funcionário encontrar e assumir uma OS.
- Consulta da OS vinculada ao colaborador em sessão e respectivo andamento por produto.
- Consulta de produtos sinalizados para inspeção/reinspeção, associando setor e número de OS.
- Consulta do histórico da OS e de cada produto (correções, sinalizações, inspeções, mudanças de status, assunções, liberação, cancelamento, conclusão).
- Consulta FIFO de OS por setor quando necessária para operação/relatório, com **prioridade como campo de apresentação**, não chave de ordenação.
- Comandos de alteração de status, assunção, qualidade, encerramento e cancelamento são superfícies distintas das consultas e exigem autorização no backend.

## Consulta para acompanhamento do cliente

O módulo operacional de OS não é exposto ao cliente. `GET /service-orders/client/me?limit=...&cursor=...` exige sessão de cliente e usa exclusivamente a identidade da sessão. Cada elemento de `serviceOrders` possui apenas `id`, `externalNumber` e `status`; `nextCursor` pagina a coleção.

Os seis estados funcionais são aprovados: `REGISTERED`, `AWAITING_SUPPLIER`, `IN_PRODUCTION`, `AWAITING_DELIVERY`, `COMPLETED`, `CANCELLED`. Ownership é filtrado/revalidado no PostgreSQL; projeção ausente, atrasada ou incompatível retorna `projectionPending` (503). Estados históricos não reconciliados retornam `clientStatusMappingPending` (409), sem fallback. Não expor produtos, atores, inspeções ou movimentos. Ver `../rf31-client-tracking.md`.

## Leitura interna implementada

`GET /service-orders/:id` exige usuário interno autorizado no setor (`READ_INTERNAL`, salvo administrador global). O corpo possui `order`, consistência eventual e versões canônica/projetada; histórico fica em `order.products[].movements[]`, com cursor assinado e paginação numérica de versões. Eventos sem produto não são duplicados nos itens. Ausência de projeção retorna `projectionPending`; leitura nunca autoriza mutação. Ver `../rf32-validation.md` para semântica de paginação e limites de snapshot.

## Forma conceitual de consulta interna

```json
{
  "orderId": "uuid-os",
  "orderNumber": "00105",
  "sectorId": "uuid-setor",
  "clientId": "uuid-cliente",
  "status": "Em produção",
  "priority": false,
  "assignedUserId": "uuid-user-ou-null",
  "products": [
    {
      "productId": "uuid-item",
      "name": "Janela",
      "quantity": 2,
      "status": "Concluído",
      "movements": [
        {
          "type": "quality_inspection",
          "occurredAt": "2026-11-14T11:00:00Z",
          "approvedQuantity": 2,
          "rejectedQuantity": 0
        }
      ]
    },
    {
      "productId": "uuid-item-2",
      "name": "Porta",
      "quantity": 1,
      "status": "Em produção",
      "movements": []
    }
  ]
}
```

_Estrutura apenas ilustrativa; nomes/payloads não aprovados. Dados de inspeção são internos; não enviar esta estrutura ao cliente._

## Fila, ordenação e consistência

- Operação por setor é isolada; ordenação FIFO para OS usa instante original de entrada e desempate determinístico.
- Conferências pendentes podem ser listadas pelo instante da **sinalização**; não reordenar por flag de prioridade.
- O backend fornece `priority` e datas; destaque visual é responsabilidade do frontend.
- Consultas Mongo são eventualmente consistentes. A existência de um dado projetado não substitui leitura/autorização canônica para mutações, ownership ou exclusividade.
- Históricos longos precisam paginação/limites adequados, preservando a associação ao produto e a versão de projeção.

## Segurança

Setor autorizado, papel/poder de gestão, ownership operacional e estado atual são revalidados no backend. Sessão define o ator; entrada do usuário não é prova de permissão. Uma busca em outro setor não pode revelar sequer o detalhe de outra OS. Não expor DTO de qualidade na superfície do cliente.
