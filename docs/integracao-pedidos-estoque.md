# Integração DACOT-PEDIDOS → DACOT-ESTOQUE (contrato v1)

## Contrato e momento do consumo

O Pedidos envia snapshots completos `order.snapshot` (versão 1) ao backend do Estoque. A primeira transição para `in_preparation` gera consumo; `ready` e `delivered` são revisões do mesmo pedido e não repetem a baixa. O evento contém somente restaurante, pedido, revisão, estado e IDs/nomes/quantidades dos produtos. Dados de cliente e observações livres não são enviados; modificadores não estão no contrato v1.

Produto é identificado pelo ID estável do Pedidos. Nome é somente informativo. A ficha técnica ativa e explicitamente validada para consumo no Estoque é a fonte da baixa; fichas novas começam desabilitadas. O pedido não envia nem calcula ingredientes. Receita e fator de conversão são copiados para o snapshot de cada movimentação. Cada revisão é monotônica e o Estoque ignora revisões antigas.

## Entrega e autenticação

O Pedidos persiste o evento no mesmo documento MongoDB do pedido, em `inventory_outbox`, junto à mudança que o gerou. Um worker assíncrono recupera pendências após reinício, usa lease, timeout e backoff limitado. O atendimento não aguarda o Estoque. Entregas repetidas são idempotentes.

O backend assina `POST`, caminho fixo, timestamp e bytes do corpo com HMAC-SHA256. O Estoque limita diferença de relógio a 5 minutos e exige a chave de serviço. A credencial é exclusiva desta integração. `restaurant_id` vem no corpo assinado e só é aceito quando a integração desse restaurante estiver ativada no Estoque; ela inicia desativada.

## Edições, cancelamentos e exceções

Aumento de quantidade consome somente a diferença, usando o snapshot da ficha já utilizado. Redução, remoção ou cancelamento após consumo abre uma exceção; nenhum ingrediente é devolvido automaticamente. Um gestor pode registrar a decisão auditável `keep_consumed`. Produto sem ficha, ingrediente indisponível, precisão insuficiente ou estoque insuficiente bloqueia a revisão inteira: a transação não deixa baixa parcial. Corrigida a causa, um gestor pode reprocessar o evento pendente. Eventos anteriores ao momento de ativação são recusados.

## Rotas do Estoque

- `POST /api/v1/integrations/orders/events` — ingestão autenticada do serviço.
- `GET /api/v1/integrations/orders` — situação, eventos recentes e exceções do restaurante autenticado.
- `GET /api/v1/integrations/orders/catalog` — produtos vistos, para associação de fichas.
- `PUT /api/v1/integrations/orders/activation` — ativação explícita pelo gestor; desligar preserva o histórico.
- `POST /api/v1/integrations/orders/events/{event_id}/retry` — reprocessamento auditável após correção.
- `POST /api/v1/integrations/orders/exceptions/{event_id}/resolve` — decisão auditável para manter o consumo já registrado.
- `PATCH /api/v1/recipes/{product_id}/consumption` — validação explícita da ficha por administrador/gerente.

Todas as consultas administrativas usam a sessão DACOT/HUB e escopo `restaurant_id`. O endpoint de ingestão aceita somente o serviço autenticado e a ativação daquele restaurante.

## Configuração (somente homologação)

No Pedidos: `INVENTORY_INTEGRATION_ENABLED=false` por padrão, `INVENTORY_INTEGRATION_RESTAURANT_IDS` com a allowlist dos restaurantes piloto, `INVENTORY_API_URL` HTTPS e `INVENTORY_INTEGRATION_SECRET` com pelo menos 32 caracteres aleatórios. No Estoque: `ORDERS_INTEGRATION_SECRET`, com o mesmo valor exclusivo da integração. Para rotação sem interrupção, o Estoque aceita temporariamente `ORDERS_INTEGRATION_PREVIOUS_SECRET`: cadastrar a chave atual como anterior, trocar a chave principal, atualizar Pedidos e depois remover a chave anterior. Criar e guardar os segredos apenas nos backends; nunca no frontend ou no Git. Ativar o Estoque primeiro somente para o mesmo restaurante de homologação. Não configurar ou ativar produção nesta implementação local.

## Limitações conhecidas

A V1 não envia nem deduz adicionais, combos ou remoções a partir de texto livre. A lista de produtos no Estoque deriva dos eventos recebidos; produtos ainda não vendidos não aparecem na integração. A ativação e resolução já possuem API, mas a interface administrativa enxuta ainda precisa ser conectada. Falhas de rede são recuperadas automaticamente; eventos recebidos com fichas/estoque pendentes exigem correção e reprocessamento por gestor.
