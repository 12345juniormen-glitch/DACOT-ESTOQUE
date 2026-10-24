# DACOT — Módulo de Estoque & Compras

Base operacional do módulo de Estoque & Compras para restaurantes, com a identidade visual da
plataforma DACOT. Esta é a V1 de interface: dados de demonstração realistas, fluxos completos e
arquitetura preparada para o backend e para a integração com o DACOT Pedidos.

Restaurante demonstrativo: **Brasa do Centro** (Santos · SP).

## Como rodar

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # typecheck + build de produção
```

Stack: React 18, TypeScript, Vite, Tailwind CSS 4, React Router 6, Lucide. Fontes Instrument Sans
(variável) e IBM Plex Mono embarcadas via Fontsource. Nenhum backend nesta versão: o estado vive em
memória e volta aos dados demo ao recarregar.

## Telas

| Rota | Tela | Pergunta que responde |
| --- | --- | --- |
| `/` | Visão Geral | O que exige decisão agora? Quanto custa? |
| `/estoque` | Estoque | O que tenho, o que está acabando, quanto vale? |
| `/estoque/:id` | Detalhe do insumo | Histórico de preço, movimentações, fornecedores, fichas |
| `/contagem` | Contagens | Histórico, divergências e impacto financeiro |
| `/contagem/:id` | Contagem em andamento | Esperado × contado, com fluxo mobile |
| `/compras` | Compras | O que pedir, de quem, em que etapa está |
| `/compras/:id` | Pedido de compra | Itens, totais, recebimento e auditoria |
| `/compras/:id/receber` | Recebimento | Quantidade e preço reais, diferenças, parcial |
| `/fornecedores` | Fornecedores | Quem fornece, prazo, mínimo, valor comprado |
| `/fornecedores/:id` | Detalhe do fornecedor | Itens, últimos preços, histórico de compras |
| `/fichas` | Fichas técnicas | Custo e margem por prato vendido |
| `/fichas/:id` | Detalhe da ficha | Composição, custo, snapshots históricos |
| `/perdas` | Perdas | Onde o dinheiro está sendo perdido |

## Arquitetura de informação

O módulo foi desenhado para a regra DACOT:

```
DADOS → IDENTIFICAR PROBLEMA → RECOMENDAR DECISÃO → EXECUTAR → MEDIR RESULTADO
```

Cada tela combina uma leitura de dado, o impacto em dinheiro e uma ação. A Visão Geral prioriza
ruptura, custo em alta, divergência, perda e compra recomendada; nunca um dashboard decorativo.

## Decisões de domínio

- **Dinheiro em centavos inteiros.** Todo valor monetário é `Cents` (`R$ 31,90 → 3190`), com
  formatação em `src/domain/format.ts`. Não há aritmética monetária em float.
- **Multi-tenant desde o modelo.** Todas as entidades carregam `restaurantId`; consultas e ações
  são sempre no escopo do restaurante atual. O tenant demo é `rest-brasa-centro`.
- **Estoque é um livro de movimentações.** `InventoryItem.currentQty` é o saldo corrente, mas toda
  alteração gera `Movement` com tipo, direção, quantidade, motivo, origem, usuário, custo e saldo
  resultante. Ajustes nunca sobrescrevem o saldo anterior.
- **Estoque teórico × real.** Consumo de pedidos gera baixas `CONSUMPTION`. A contagem física
  compara o esperado congelado no início da contagem com o contado e gera `ADJUSTMENT` na aprovação.
- **Custos versionados.** `RecipeSnapshot` congela o custo da ficha na época. Recebimentos e
  alterações de ficha geram novos snapshots; pedidos já realizados não são reescritos.
- **Preço é histórico.** `PricePoint` registra cada preço recebido, por insumo e fornecedor. A
  variação de 120 dias e as recomendações derivam desses pontos.

## Integração com DACOT Pedidos

Contrato preparado em `src/domain/events.ts`:

- Eventos: `ORDER_CREATED`, `ORDER_UPDATED`, `ORDER_DELIVERED`, `ORDER_CANCELLED`.
- Apenas `ORDER_DELIVERED` consome estoque; cancelamento não baixa.
- `ORDER_DELIVERED` → linhas do pedido → ficha técnica vigente → consumo por insumo →
  movimentações `CONSUMPTION` → saldo teórico.
- **Idempotência por `event.id`.** O ID processado é persistido em `processedEventIds`; reprocessar
  o mesmo evento retorna `duplicate` e não gera baixa. O painel da Visão Geral permite simular uma
  entrega e reprocessar o último evento para verificar essa proteção.
- Nenhuma leitura direta de estruturas internas do Pedidos: o módulo só conhece o contrato do
  evento (`orderId`, `occurredAt`, `lines[{ recipeId, qty }]`).

## RBAC

| Recurso | Administrador | Gerente | Operador de estoque |
| --- | --- | --- | --- |
| Visão Geral / Estoque | ver | ver | ver |
| Movimentações e cadastro de insumo | total | total | — |
| Contagem | total | total + aprovar | contar |
| Compras | total | total | ver + receber |
| Fornecedores / Fichas | total | ver | — |
| Perdas | total | total | — |
| Auditoria | ver | ver | — |

O seletor **Perfil** no topo alterna entre Carlos (Administrador), Marina (Gerente) e Rafael
(Operador) para demonstrar restrições de navegação, ações e aprovação. Rotas restritas exibem uma
página de acesso restrito em vez de quebrar.

## Dados demo

- 25 insumos em 8 categorias, com mínimos, custos e fornecedores.
- 4 fornecedores, ofertas e histórico de preços (incluindo 6 itens em alta no período).
- 11 fichas técnicas com custo e margem calculados.
- 30 dias de consumo por pedidos entregues, compras recebidas, perdas, duas contagens e auditoria.
- O livro de movimentações fecha exatamente no saldo atual de cada insumo; a abertura implícita é
  calculada para que compras + entradas − consumo − perdas − ajustes = saldo final.

Ao recarregar, os dados demo são restaurados.

## Fora do escopo desta V1

Sem IA, OCR/XML de nota fiscal, fiscal, contas a pagar, banco, pagamento, negociação automática,
previsão estatística, integrações de PDV ou marketplace. As recomendações usam uma regra
transparente:

```
consumo médio diário × dias de cobertura + estoque de segurança − estoque atual
```

O cálculo aparece nas telas com os números usados. Nada é apresentado como IA.

## Verificação

- `npx tsc --noEmit` e `npm run build` sem erros.
- Renderização das 13 rotas (incluindo detalhes, 404 e acesso restrito) validada em smoke test.
- Fluxos exercitados em DOM: recebimento com entrada em estoque, contagem criada e aprovada, perda
  registrada, evento de pedido idempotente, troca de perfil com bloqueio de rotas e permissões.

## Pendências naturais para a próxima etapa

1. Backend e persistência multi-tenant, com validação de permissões por requisição.
2. Autenticação real e vínculo usuário–restaurante.
3. Contrato do DACOT Pedidos (fila/webhook) e assinatura/verificação dos eventos.
4. Migração dos dados demo para dados reais e políticas de fechamento de contagem.
