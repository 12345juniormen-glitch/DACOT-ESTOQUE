# DACOT — Módulo de Estoque & Compras

Base operacional do módulo DACOT Estoque & Compras para restaurantes. O repositório contém um
frontend React + TypeScript + Vite e uma API FastAPI independente, com persistência MongoDB,
autenticação por handoff do DACOT-HUB e isolamento de dados por restaurante. A integração com o
DACOT-PEDIDOS continua fora do escopo desta V1.

Restaurante demonstrativo: **Brasa do Centro** (Santos · SP).

## Como rodar

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # typecheck + build de produção
```

Para executar a API local e configurar MongoDB, autenticação e serviços hospedados, consulte
[`backend/README.md`](backend/README.md). Builds de produção operam em modo real e não carregam os
dados de demonstração.

Stack: React 18, TypeScript, Vite, Tailwind CSS 4, React Router 6, Lucide. Fontes Instrument Sans
(variável) e IBM Plex Mono embarcadas via Fontsource.

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

- **Dinheiro em centavos inteiros.** Todo valor monetário persistido e exibido é `Cents`
  (`R$ 31,90 → 3190`). O custo da ficha arredonda cada linha para o centavo mais próximo, meio
  centavo para cima, e soma os valores inteiros; frontend e backend seguem a mesma regra.
- **Multi-tenant.** A API deriva o restaurante da sessão validada pelo DACOT-HUB e escopa as
  consultas/escritas ao `restaurant_id` autenticado. Os dados de demonstração usam um tenant local
  isolado.
- **Estoque é um livro de movimentações.** A API guarda saldo corrente junto de movimentos com
  tipo, quantidade, motivo, origem, usuário, custo e saldo resultante. Ajustes são registrados.
- **Estoque teórico × contado.** Contagens comparam o saldo congelado no início à quantidade
  informada e, na aprovação, geram ajustes auditáveis.
- **Custos versionados.** `RecipeSnapshot` congela o custo da ficha na época. Recebimentos e
  alterações de ficha geram novos snapshots; pedidos já realizados não são reescritos. As linhas
  descrevem o lote completo; rendimento divide o custo do lote em custo por porção e ambos ficam
  congelados no snapshot. Fichas legadas sem rendimento equivalem a uma porção.
- **Preço é histórico.** `PricePoint` registra cada preço recebido, por insumo e fornecedor. A
  variação de 120 dias e as recomendações derivam desses pontos.

## Integração com DACOT-PEDIDOS

Não está habilitada nesta V1. O estoque real não consome eventos de pedido e não deve ser
considerado sincronizado com vendas. A integração futura deverá usar contrato autenticado,
idempotente e desacoplado, com baixa de estoque baseada nas fichas técnicas vigentes.

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

No modo de demonstração, o seletor **Perfil** alterna usuários fictícios para mostrar a navegação.
Em produção, papel e permissões vêm da sessão do HUB e são validados pela API.

## Modo de demonstração

- 25 insumos em 8 categorias, com mínimos, custos e fornecedores.
- 4 fornecedores, ofertas e histórico de preços (incluindo 6 itens em alta no período).
- 11 fichas técnicas com custo e margem calculados.
- 30 dias de consumo por pedidos entregues, compras recebidas, perdas, duas contagens e auditoria.
- O livro de movimentações fecha exatamente no saldo atual de cada insumo; a abertura implícita é
  calculada para que compras + entradas − consumo − perdas − ajustes = saldo final.

O modo de demonstração existe apenas para desenvolvimento local. Em builds de produção, o app usa
a API; se a configuração da API estiver ausente ou indisponível, os dados demonstrativos não são
usados como substituto dos dados reais.

## Fora do escopo desta V1

Sem IA, OCR/XML de nota fiscal, fiscal, contas a pagar, banco, pagamento, negociação automática,
previsão estatística, integrações de PDV ou marketplace. As recomendações usam uma regra
transparente:

```
consumo médio diário × dias de cobertura + estoque de segurança − estoque atual
```

O cálculo aparece nas telas com os números usados. Nada é apresentado como IA.

## Estado da V1 e homologação

A API implementa persistência de ingredientes, fornecedores, movimentos, compras e recebimentos,
fichas técnicas e snapshots de custo, contagens, perdas e auditoria. As mutações operacionais são
escopadas ao restaurante autenticado e usam transações e chaves de idempotência onde aplicável.
Consulte [`docs/V1_GAP_MAP.md`](docs/V1_GAP_MAP.md) para lacunas e evidências de teste atualizadas.

Autenticação publicada, conexão com Atlas, cookie entre os domínios hospedados e handoff real do
HUB ainda requerem configuração e homologação controlada. Não trate a V1 como operacional em
produção antes dessas verificações. O backend não foi publicado por esta alteração.
