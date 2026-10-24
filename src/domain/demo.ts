import { NOW_ISO, daysAgoISO } from './clock';
import type {
  AppState,
  AuditEntry,
  CountSession,
  Cents,
  InventoryItem,
  Loss,
  LossReason,
  Movement,
  OrderEvent,
  PricePoint,
  Purchase,
  PurchaseLine,
  Recipe,
  Supplier,
  SupplierItem,
  Unit,
  User,
} from './types';

const RID = 'rest-brasa-centro';

export const RESTAURANT = {
  id: RID,
  name: 'Brasa do Centro',
  city: 'Santos · SP',
};

export const USERS: User[] = [
  { id: 'u-carlos', restaurantId: RID, name: 'Carlos Menezes', role: 'admin', initials: 'CM' },
  { id: 'u-marina', restaurantId: RID, name: 'Marina Duarte', role: 'manager', initials: 'MD' },
  { id: 'u-rafa', restaurantId: RID, name: 'Rafael Souza', role: 'operator', initials: 'RS' },
];

export const SUPPLIERS: Supplier[] = [
  {
    id: 'sup-litoral',
    restaurantId: RID,
    name: 'Distribuidora Litoral',
    contact: 'Marcos Paiva',
    phone: '(13) 3224-8810',
    whatsapp: '(13) 99812-4410',
    notes: 'Entrega às terças e sextas. Preço de carne fechado no início da semana.',
    avgLeadTimeDays: 2,
    minOrderCents: 80000,
    createdAt: daysAgoISO(320, 9),
  },
  {
    id: 'sup-costa',
    restaurantId: RID,
    name: 'Costa Alimentos',
    contact: 'Ana Costa',
    phone: '(13) 3456-7020',
    whatsapp: '(13) 99641-2210',
    notes: 'Frios, pães e embalagens. Faturamento em 14 dias.',
    avgLeadTimeDays: 3,
    minOrderCents: 60000,
    createdAt: daysAgoISO(280, 9),
  },
  {
    id: 'sup-vale',
    restaurantId: RID,
    name: 'Vale Foods',
    contact: 'Rogério Vale',
    phone: '(13) 3011-4488',
    whatsapp: '(13) 99775-1188',
    notes: 'Bebidas e congelados. Pedido mínimo de 5 caixas por entrega.',
    avgLeadTimeDays: 4,
    minOrderCents: 50000,
    createdAt: daysAgoISO(240, 9),
  },
  {
    id: 'sup-central',
    restaurantId: RID,
    name: 'Hortifruti Central',
    contact: 'Sérgio Lima',
    phone: '(13) 3442-1199',
    whatsapp: '(13) 99120-8899',
    notes: 'Hortifruti diário. Entrega até as 9h, pedido na véspera.',
    avgLeadTimeDays: 1,
    minOrderCents: 25000,
    createdAt: daysAgoISO(180, 9),
  },
];

interface OfferSeed {
  supplierId: string;
  price: Cents;
  lead: number;
  min: Cents;
}

interface ItemSeed {
  id: string;
  name: string;
  category: InventoryItem['category'];
  unit: Unit;
  qty: number;
  min: number;
  cost: Cents;
  primary: string;
  /** Preços históricos em 90, 60, 30 e 2 dias atrás. */
  history: [Cents, Cents, Cents, Cents];
  offers: OfferSeed[];
}

const ITEM_SEEDS: ItemSeed[] = [
  {
    id: 'it-carne', name: 'Carne bovina', category: 'Carnes', unit: 'kg',
    qty: 16.4, min: 12, cost: 3620, primary: 'sup-litoral',
    history: [3520, 3560, 3640, 3620],
    offers: [
      { supplierId: 'sup-litoral', price: 3620, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 3690, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-frango', name: 'Peito de frango', category: 'Carnes', unit: 'kg',
    qty: 9.2, min: 8, cost: 1970, primary: 'sup-costa',
    history: [1716, 1720, 1890, 1970],
    offers: [
      { supplierId: 'sup-costa', price: 1970, lead: 3, min: 60000 },
      { supplierId: 'sup-litoral', price: 2010, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-costela', name: 'Costela bovina', category: 'Carnes', unit: 'kg',
    qty: 18, min: 10, cost: 4280, primary: 'sup-litoral',
    history: [3990, 4050, 4200, 4280],
    offers: [
      { supplierId: 'sup-litoral', price: 4280, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 4380, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-bacon', name: 'Bacon em fatias', category: 'Carnes', unit: 'kg',
    qty: 1.8, min: 1.5, cost: 2890, primary: 'sup-litoral',
    history: [2800, 2820, 2860, 2890],
    offers: [
      { supplierId: 'sup-litoral', price: 2890, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 2950, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-linguica', name: 'Linguiça artesanal', category: 'Carnes', unit: 'kg',
    qty: 8, min: 6, cost: 2450, primary: 'sup-litoral',
    history: [2420, 2440, 2450, 2450],
    offers: [{ supplierId: 'sup-litoral', price: 2450, lead: 2, min: 80000 }],
  },
  {
    id: 'it-queijo', name: 'Queijo mussarela', category: 'Laticínios', unit: 'kg',
    qty: 4.8, min: 6, cost: 3190, primary: 'sup-litoral',
    history: [2980, 3020, 3120, 3190],
    offers: [
      { supplierId: 'sup-litoral', price: 3190, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 2980, lead: 3, min: 120000 },
      { supplierId: 'sup-vale', price: 3040, lead: 4, min: 50000 },
    ],
  },
  {
    id: 'it-cheddar', name: 'Queijo cheddar', category: 'Laticínios', unit: 'kg',
    qty: 6.2, min: 5, cost: 3840, primary: 'sup-litoral',
    history: [3900, 3880, 3860, 3840],
    offers: [
      { supplierId: 'sup-litoral', price: 3840, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 3910, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-catupiry', name: 'Catupiry original', category: 'Laticínios', unit: 'kg',
    qty: 0, min: 2, cost: 2690, primary: 'sup-costa',
    history: [2650, 2660, 2670, 2690],
    offers: [{ supplierId: 'sup-costa', price: 2690, lead: 3, min: 60000 }],
  },
  {
    id: 'it-manteiga', name: 'Manteiga sem sal', category: 'Laticínios', unit: 'kg',
    qty: 2.8, min: 4, cost: 3420, primary: 'sup-litoral',
    history: [3450, 3440, 3430, 3420],
    offers: [
      { supplierId: 'sup-litoral', price: 3420, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 3490, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-tomate', name: 'Tomate italiano', category: 'Hortifruti', unit: 'kg',
    qty: 1.8, min: 4, cost: 780, primary: 'sup-central',
    history: [620, 660, 700, 780],
    offers: [
      { supplierId: 'sup-central', price: 780, lead: 1, min: 25000 },
      { supplierId: 'sup-vale', price: 820, lead: 3, min: 50000 },
    ],
  },
  {
    id: 'it-alface', name: 'Alface americana', category: 'Hortifruti', unit: 'kg',
    qty: 0.9, min: 3, cost: 620, primary: 'sup-central',
    history: [640, 630, 625, 620],
    offers: [
      { supplierId: 'sup-central', price: 620, lead: 1, min: 25000 },
      { supplierId: 'sup-vale', price: 660, lead: 3, min: 50000 },
    ],
  },
  {
    id: 'it-cebola', name: 'Cebola branca', category: 'Hortifruti', unit: 'kg',
    qty: 2.1, min: 3, cost: 540, primary: 'sup-central',
    history: [550, 545, 540, 540],
    offers: [
      { supplierId: 'sup-central', price: 540, lead: 1, min: 25000 },
      { supplierId: 'sup-vale', price: 580, lead: 3, min: 50000 },
    ],
  },
  {
    id: 'it-batata', name: 'Batata congelada', category: 'Congelados', unit: 'kg',
    qty: 12, min: 10, cost: 1150, primary: 'sup-vale',
    history: [1200, 1180, 1160, 1150],
    offers: [
      { supplierId: 'sup-vale', price: 1150, lead: 4, min: 50000 },
      { supplierId: 'sup-central', price: 1180, lead: 1, min: 25000 },
    ],
  },
  {
    id: 'it-pao', name: 'Pão brioche', category: 'Secos', unit: 'un',
    qty: 82, min: 120, cost: 120, primary: 'sup-costa',
    history: [115, 118, 118, 120],
    offers: [
      { supplierId: 'sup-costa', price: 120, lead: 3, min: 60000 },
      { supplierId: 'sup-vale', price: 128, lead: 4, min: 50000 },
    ],
  },
  {
    id: 'it-farinha', name: 'Farinha de trigo', category: 'Secos', unit: 'kg',
    qty: 14, min: 10, cost: 490, primary: 'sup-litoral',
    history: [475, 480, 485, 490],
    offers: [
      { supplierId: 'sup-litoral', price: 490, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 510, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-molho', name: 'Molho da casa', category: 'Secos', unit: 'kg',
    qty: 8.6, min: 6, cost: 1430, primary: 'sup-costa',
    history: [1400, 1410, 1420, 1430],
    offers: [
      { supplierId: 'sup-costa', price: 1430, lead: 3, min: 60000 },
      { supplierId: 'sup-litoral', price: 1470, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-oleo', name: 'Óleo de soja', category: 'Secos', unit: 'L',
    qty: 9.4, min: 6, cost: 760, primary: 'sup-litoral',
    history: [690, 700, 740, 760],
    offers: [
      { supplierId: 'sup-litoral', price: 760, lead: 2, min: 80000 },
      { supplierId: 'sup-costa', price: 790, lead: 3, min: 60000 },
    ],
  },
  {
    id: 'it-coca', name: 'Coca-Cola lata', category: 'Bebidas', unit: 'un',
    qty: 64, min: 48, cost: 280, primary: 'sup-vale',
    history: [290, 285, 285, 280],
    offers: [
      { supplierId: 'sup-vale', price: 280, lead: 4, min: 50000 },
      { supplierId: 'sup-litoral', price: 289, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-guarana', name: 'Guaraná lata', category: 'Bebidas', unit: 'un',
    qty: 48, min: 36, cost: 260, primary: 'sup-vale',
    history: [260, 262, 260, 260],
    offers: [{ supplierId: 'sup-vale', price: 260, lead: 4, min: 50000 }],
  },
  {
    id: 'it-cerveja', name: 'Cerveja long neck', category: 'Bebidas', unit: 'un',
    qty: 64, min: 48, cost: 420, primary: 'sup-vale',
    history: [390, 395, 400, 420],
    offers: [
      { supplierId: 'sup-vale', price: 420, lead: 4, min: 50000 },
      { supplierId: 'sup-litoral', price: 435, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-suco', name: 'Suco de laranja', category: 'Bebidas', unit: 'L',
    qty: 6.4, min: 8, cost: 890, primary: 'sup-vale',
    history: [920, 910, 900, 890],
    offers: [
      { supplierId: 'sup-vale', price: 890, lead: 4, min: 50000 },
      { supplierId: 'sup-central', price: 920, lead: 1, min: 25000 },
    ],
  },
  {
    id: 'it-agua', name: 'Água mineral 500 ml', category: 'Bebidas', unit: 'un',
    qty: 96, min: 48, cost: 180, primary: 'sup-vale',
    history: [180, 180, 180, 180],
    offers: [{ supplierId: 'sup-vale', price: 180, lead: 4, min: 50000 }],
  },
  {
    id: 'it-embalagem', name: 'Embalagem delivery', category: 'Embalagens', unit: 'un',
    qty: 130, min: 100, cost: 85, primary: 'sup-costa',
    history: [86, 85, 85, 85],
    offers: [
      { supplierId: 'sup-costa', price: 85, lead: 3, min: 60000 },
      { supplierId: 'sup-litoral', price: 88, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-sacola', name: 'Sacola kraft', category: 'Embalagens', unit: 'un',
    qty: 400, min: 250, cost: 42, primary: 'sup-costa',
    history: [42, 42, 42, 42],
    offers: [
      { supplierId: 'sup-costa', price: 42, lead: 3, min: 60000 },
      { supplierId: 'sup-litoral', price: 45, lead: 2, min: 80000 },
    ],
  },
  {
    id: 'it-guardanapo', name: 'Guardanapo', category: 'Embalagens', unit: 'un',
    qty: 1000, min: 500, cost: 3, primary: 'sup-costa',
    history: [3, 3, 3, 3],
    offers: [{ supplierId: 'sup-costa', price: 3, lead: 3, min: 60000 }],
  },
];

interface RecipeSeed {
  id: string;
  name: string;
  salePriceCents: Cents;
  ingredients: { itemId: string; qty: number; unit: Unit }[];
}

const RECIPE_SEEDS: RecipeSeed[] = [
  {
    id: 'rc-xburger', name: 'X-Burger Artesanal', salePriceCents: 2890,
    ingredients: [
      { itemId: 'it-pao', qty: 1, unit: 'un' },
      { itemId: 'it-carne', qty: 160, unit: 'g' },
      { itemId: 'it-queijo', qty: 40, unit: 'g' },
      { itemId: 'it-tomate', qty: 30, unit: 'g' },
      { itemId: 'it-alface', qty: 15, unit: 'g' },
      { itemId: 'it-manteiga', qty: 10, unit: 'g' },
      { itemId: 'it-molho', qty: 30, unit: 'g' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-duplo', name: 'Duplo Brasa', salePriceCents: 3890,
    ingredients: [
      { itemId: 'it-pao', qty: 1, unit: 'un' },
      { itemId: 'it-carne', qty: 300, unit: 'g' },
      { itemId: 'it-queijo', qty: 40, unit: 'g' },
      { itemId: 'it-cheddar', qty: 40, unit: 'g' },
      { itemId: 'it-bacon', qty: 40, unit: 'g' },
      { itemId: 'it-molho', qty: 40, unit: 'g' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-parmegiana', name: 'Parmegiana da Casa', salePriceCents: 4690,
    ingredients: [
      { itemId: 'it-frango', qty: 220, unit: 'g' },
      { itemId: 'it-molho', qty: 120, unit: 'g' },
      { itemId: 'it-queijo', qty: 80, unit: 'g' },
      { itemId: 'it-farinha', qty: 20, unit: 'g' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-crispy', name: 'Frango Crispy', salePriceCents: 3290,
    ingredients: [
      { itemId: 'it-frango', qty: 180, unit: 'g' },
      { itemId: 'it-farinha', qty: 30, unit: 'g' },
      { itemId: 'it-catupiry', qty: 40, unit: 'g' },
      { itemId: 'it-pao', qty: 1, unit: 'un' },
      { itemId: 'it-molho', qty: 30, unit: 'g' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-batata', name: 'Batata Rústica', salePriceCents: 1890,
    ingredients: [
      { itemId: 'it-batata', qty: 250, unit: 'g' },
      { itemId: 'it-oleo', qty: 20, unit: 'ml' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-costela', name: 'Costela no Bafo', salePriceCents: 5490,
    ingredients: [
      { itemId: 'it-costela', qty: 350, unit: 'g' },
      { itemId: 'it-farinha', qty: 20, unit: 'g' },
      { itemId: 'it-molho', qty: 40, unit: 'g' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-combo', name: 'Combo Brasa', salePriceCents: 4290,
    ingredients: [
      { itemId: 'it-pao', qty: 1, unit: 'un' },
      { itemId: 'it-carne', qty: 160, unit: 'g' },
      { itemId: 'it-queijo', qty: 40, unit: 'g' },
      { itemId: 'it-tomate', qty: 30, unit: 'g' },
      { itemId: 'it-alface', qty: 15, unit: 'g' },
      { itemId: 'it-manteiga', qty: 10, unit: 'g' },
      { itemId: 'it-molho', qty: 30, unit: 'g' },
      { itemId: 'it-batata', qty: 200, unit: 'g' },
      { itemId: 'it-oleo', qty: 15, unit: 'ml' },
      { itemId: 'it-coca', qty: 1, unit: 'un' },
      { itemId: 'it-embalagem', qty: 1, unit: 'un' },
    ],
  },
  {
    id: 'rc-coca', name: 'Coca-Cola 350 ml', salePriceCents: 600,
    ingredients: [{ itemId: 'it-coca', qty: 1, unit: 'un' }],
  },
  {
    id: 'rc-cerveja', name: 'Cerveja Long Neck', salePriceCents: 990,
    ingredients: [{ itemId: 'it-cerveja', qty: 1, unit: 'un' }],
  },
  {
    id: 'rc-suco', name: 'Suco de Laranja 400 ml', salePriceCents: 1190,
    ingredients: [{ itemId: 'it-suco', qty: 400, unit: 'ml' }],
  },
  {
    id: 'rc-agua', name: 'Água Mineral 500 ml', salePriceCents: 450,
    ingredients: [{ itemId: 'it-agua', qty: 1, unit: 'un' }],
  },
];

const PURCHASE_SEEDS: {
  id: string;
  code: string;
  supplierId: string;
  status: Purchase['status'];
  createdAt: string;
  expectedDeliveryAt: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
  note: string;
  lines: { itemId: string; ordered: number; received: number; expected: Cents; actual?: Cents }[];
}[] = [
  {
    id: 'pu-1047', code: 'PC-1047', supplierId: 'sup-central', status: 'draft',
    createdAt: daysAgoISO(0, 9, 12), expectedDeliveryAt: daysAgoISO(-1, 8), receivedAt: null, receivedBy: null,
    note: 'Reposição de hortifruti para o fim de semana.',
    lines: [
      { itemId: 'it-tomate', ordered: 4, received: 0, expected: 780 },
      { itemId: 'it-alface', ordered: 3, received: 0, expected: 620 },
      { itemId: 'it-cebola', ordered: 4, received: 0, expected: 540 },
    ],
  },
  {
    id: 'pu-1046', code: 'PC-1046', supplierId: 'sup-litoral', status: 'requested',
    createdAt: daysAgoISO(1, 16, 20), expectedDeliveryAt: daysAgoISO(-1, 8), receivedAt: null, receivedBy: null,
    note: 'Pedido semanal de carnes e queijos.',
    lines: [
      { itemId: 'it-carne', ordered: 15, received: 0, expected: 3620 },
      { itemId: 'it-queijo', ordered: 6, received: 0, expected: 3190 },
      { itemId: 'it-batata', ordered: 10, received: 0, expected: 1150 },
    ],
  },
  {
    id: 'pu-1045', code: 'PC-1045', supplierId: 'sup-costa', status: 'partial',
    createdAt: daysAgoISO(2, 8, 5), expectedDeliveryAt: daysAgoISO(1, 8), receivedAt: daysAgoISO(2, 10, 30),
    receivedBy: 'u-marina',
    note: 'Faltaram 10 pães e 1 kg de frango. Saldo pendente com a Ana.',
    lines: [
      { itemId: 'it-pao', ordered: 100, received: 90, expected: 120, actual: 120 },
      { itemId: 'it-frango', ordered: 11, received: 10, expected: 1970, actual: 1970 },
      { itemId: 'it-embalagem', ordered: 180, received: 180, expected: 85, actual: 85 },
    ],
  },
  {
    id: 'pu-1044', code: 'PC-1044', supplierId: 'sup-litoral', status: 'received',
    createdAt: daysAgoISO(3, 9, 40), expectedDeliveryAt: daysAgoISO(3, 8), receivedAt: daysAgoISO(3, 8, 15),
    receivedBy: 'u-rafa',
    note: '',
    lines: [
      { itemId: 'it-carne', ordered: 12, received: 12, expected: 3620, actual: 3620 },
      { itemId: 'it-queijo', ordered: 4, received: 4, expected: 3190, actual: 3190 },
      { itemId: 'it-costela', ordered: 4, received: 4, expected: 4280, actual: 4280 },
      { itemId: 'it-bacon', ordered: 1.5, received: 1.5, expected: 2890, actual: 2890 },
    ],
  },
  {
    id: 'pu-1043', code: 'PC-1043', supplierId: 'sup-costa', status: 'received',
    createdAt: daysAgoISO(6, 7, 20), expectedDeliveryAt: daysAgoISO(6, 8), receivedAt: daysAgoISO(6, 8, 50),
    receivedBy: 'u-marina',
    note: '',
    lines: [
      { itemId: 'it-pao', ordered: 80, received: 80, expected: 120, actual: 120 },
      { itemId: 'it-frango', ordered: 12, received: 12, expected: 1970, actual: 1970 },
      { itemId: 'it-molho', ordered: 8, received: 8, expected: 1430, actual: 1430 },
      { itemId: 'it-embalagem', ordered: 200, received: 200, expected: 85, actual: 85 },
      { itemId: 'it-sacola', ordered: 150, received: 150, expected: 42, actual: 42 },
    ],
  },
  {
    id: 'pu-1042', code: 'PC-1042', supplierId: 'sup-vale', status: 'received',
    createdAt: daysAgoISO(5, 10, 10), expectedDeliveryAt: daysAgoISO(5, 8), receivedAt: daysAgoISO(5, 8, 40),
    receivedBy: 'u-rafa',
    note: 'Conferir gelo e validade das cervejas.',
    lines: [
      { itemId: 'it-coca', ordered: 96, received: 96, expected: 280, actual: 280 },
      { itemId: 'it-cerveja', ordered: 48, received: 48, expected: 420, actual: 420 },
      { itemId: 'it-suco', ordered: 8, received: 8, expected: 890, actual: 890 },
      { itemId: 'it-agua', ordered: 48, received: 48, expected: 180, actual: 180 },
      { itemId: 'it-guarana', ordered: 48, received: 48, expected: 260, actual: 260 },
    ],
  },
  {
    id: 'pu-1041', code: 'PC-1041', supplierId: 'sup-central', status: 'received',
    createdAt: daysAgoISO(8, 7, 50), expectedDeliveryAt: daysAgoISO(8, 8), receivedAt: daysAgoISO(8, 8, 35),
    receivedBy: 'u-marina',
    note: '',
    lines: [
      { itemId: 'it-tomate', ordered: 3, received: 3, expected: 780, actual: 780 },
      { itemId: 'it-alface', ordered: 2, received: 2, expected: 620, actual: 620 },
      { itemId: 'it-cebola', ordered: 2, received: 2, expected: 540, actual: 540 },
      { itemId: 'it-batata', ordered: 20, received: 20, expected: 1150, actual: 1150 },
    ],
  },
  {
    id: 'pu-1040', code: 'PC-1040', supplierId: 'sup-litoral', status: 'received',
    createdAt: daysAgoISO(11, 9, 30), expectedDeliveryAt: daysAgoISO(11, 8), receivedAt: daysAgoISO(11, 8, 10),
    receivedBy: 'u-rafa',
    note: '',
    lines: [
      { itemId: 'it-carne', ordered: 20, received: 20, expected: 3620, actual: 3620 },
      { itemId: 'it-queijo', ordered: 10, received: 10, expected: 3190, actual: 3190 },
      { itemId: 'it-cheddar', ordered: 4, received: 4, expected: 3840, actual: 3840 },
      { itemId: 'it-manteiga', ordered: 2, received: 2, expected: 3420, actual: 3420 },
    ],
  },
  {
    id: 'pu-1039', code: 'PC-1039', supplierId: 'sup-costa', status: 'received',
    createdAt: daysAgoISO(14, 10, 0), expectedDeliveryAt: daysAgoISO(14, 8), receivedAt: daysAgoISO(14, 8, 55),
    receivedBy: 'u-marina',
    note: '',
    lines: [
      { itemId: 'it-pao', ordered: 120, received: 120, expected: 120, actual: 120 },
      { itemId: 'it-frango', ordered: 5, received: 5, expected: 1970, actual: 1970 },
      { itemId: 'it-molho', ordered: 10, received: 10, expected: 1430, actual: 1430 },
      { itemId: 'it-embalagem', ordered: 140, received: 140, expected: 85, actual: 85 },
      { itemId: 'it-sacola', ordered: 100, received: 100, expected: 42, actual: 42 },
    ],
  },
  {
    id: 'pu-1038', code: 'PC-1038', supplierId: 'sup-vale', status: 'cancelled',
    createdAt: daysAgoISO(15, 11, 10), expectedDeliveryAt: daysAgoISO(13, 8), receivedAt: null, receivedBy: null,
    note: 'Cancelado: a entrega não ocorreu no prazo combinado.',
    lines: [{ itemId: 'it-cerveja', ordered: 24, received: 0, expected: 420 }],
  },
  {
    id: 'pu-1037', code: 'PC-1037', supplierId: 'sup-litoral', status: 'received',
    createdAt: daysAgoISO(18, 9, 15), expectedDeliveryAt: daysAgoISO(18, 8), receivedAt: daysAgoISO(18, 8, 25),
    receivedBy: 'u-rafa',
    note: '',
    lines: [
      { itemId: 'it-carne', ordered: 26, received: 26, expected: 3580, actual: 3580 },
      { itemId: 'it-queijo', ordered: 12, received: 12, expected: 3190, actual: 3190 },
      { itemId: 'it-costela', ordered: 10, received: 10, expected: 4280, actual: 4280 },
    ],
  },
  {
    id: 'pu-1036', code: 'PC-1036', supplierId: 'sup-central', status: 'received',
    createdAt: daysAgoISO(20, 7, 40), expectedDeliveryAt: daysAgoISO(20, 8), receivedAt: daysAgoISO(20, 8, 10),
    receivedBy: 'u-marina',
    note: '',
    lines: [
      { itemId: 'it-tomate', ordered: 3, received: 3, expected: 760, actual: 760 },
      { itemId: 'it-alface', ordered: 2, received: 2, expected: 620, actual: 620 },
      { itemId: 'it-cebola', ordered: 4, received: 4, expected: 520, actual: 520 },
      { itemId: 'it-batata', ordered: 20, received: 20, expected: 1180, actual: 1180 },
    ],
  },
];

const LOSS_SEEDS: {
  itemId: string;
  qty: number;
  reason: LossReason;
  note: string;
  offset: number;
  hour: number;
  minute: number;
  userId: string;
}[] = [
  { itemId: 'it-carne', qty: 3.2, reason: 'Vencimento', note: 'Peça esquecida na câmara fria.', offset: 1, hour: 14, minute: 10, userId: 'u-rafa' },
  { itemId: 'it-queijo', qty: 2.4, reason: 'Qualidade', note: 'Lote chegou com odor alterado.', offset: 2, hour: 19, minute: 30, userId: 'u-marina' },
  { itemId: 'it-pao', qty: 48, reason: 'Sobra', note: 'Pães do serviço de domingo.', offset: 2, hour: 22, minute: 5, userId: 'u-rafa' },
  { itemId: 'it-frango', qty: 5.6, reason: 'Preparo errado', note: 'Lote queimado na fritadeira.', offset: 4, hour: 13, minute: 40, userId: 'u-rafa' },
  { itemId: 'it-cerveja', qty: 12, reason: 'Quebra', note: 'Garrafas quebradas no recebimento.', offset: 5, hour: 16, minute: 20, userId: 'u-marina' },
  { itemId: 'it-tomate', qty: 2.4, reason: 'Vencimento', note: '', offset: 6, hour: 21, minute: 10, userId: 'u-rafa' },
  { itemId: 'it-costela', qty: 6, reason: 'Erro operacional', note: 'Pedido de evento cancelado sem aviso.', offset: 7, hour: 12, minute: 15, userId: 'u-marina' },
  { itemId: 'it-batata', qty: 4, reason: 'Quebra', note: 'Embalagem violada no transporte.', offset: 8, hour: 18, minute: 45, userId: 'u-rafa' },
  { itemId: 'it-cheddar', qty: 1.8, reason: 'Vencimento', note: '', offset: 10, hour: 10, minute: 30, userId: 'u-marina' },
  { itemId: 'it-alface', qty: 2.5, reason: 'Qualidade', note: 'Folhas amassadas.', offset: 11, hour: 15, minute: 0, userId: 'u-rafa' },
  { itemId: 'it-embalagem', qty: 60, reason: 'Quebra', note: 'Caixa molhada.', offset: 12, hour: 20, minute: 20, userId: 'u-rafa' },
  { itemId: 'it-suco', qty: 4, reason: 'Vencimento', note: '', offset: 13, hour: 11, minute: 50, userId: 'u-marina' },
  { itemId: 'it-molho', qty: 3.2, reason: 'Sobra', note: 'Produção acima da demanda do fim de semana.', offset: 14, hour: 21, minute: 0, userId: 'u-marina' },
  { itemId: 'it-catupiry', qty: 2, reason: 'Vencimento', note: 'Último pote do lote.', offset: 15, hour: 17, minute: 30, userId: 'u-rafa' },
  { itemId: 'it-carne', qty: 1.5, reason: 'Preparo errado', note: 'Ponto passado além do pedido.', offset: 16, hour: 9, minute: 40, userId: 'u-rafa' },
];

const COUNT_LINES: { itemId: string; expected: number; counted: number }[] = [
  { itemId: 'it-carne', expected: 19.9, counted: 18.4 },
  { itemId: 'it-queijo', expected: 11.6, counted: 10.8 },
  { itemId: 'it-costela', expected: 22.5, counted: 16.0 },
  { itemId: 'it-frango', expected: 19.4, counted: 16.6 },
  { itemId: 'it-cheddar', expected: 8.0, counted: 6.4 },
  { itemId: 'it-molho', expected: 18.0, counted: 16.6 },
  { itemId: 'it-batata', expected: 32.0, counted: 29.0 },
  { itemId: 'it-pao', expected: 300, counted: 288 },
  { itemId: 'it-coca', expected: 300, counted: 296 },
  { itemId: 'it-cerveja', expected: 180, counted: 156 },
  { itemId: 'it-embalagem', expected: 640, counted: 520 },
  { itemId: 'it-tomate', expected: 6.4, counted: 5.8 },
  { itemId: 'it-alface', expected: 3.2, counted: 2.9 },
  { itemId: 'it-manteiga', expected: 4.4, counted: 4.0 },
];

const DAY_MS = 86_400_000;

function rng(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const RECIPE_MIX: [string, number][] = [
  ['rc-xburger', 24],
  ['rc-duplo', 15],
  ['rc-parmegiana', 8],
  ['rc-crispy', 12],
  ['rc-batata', 9],
  ['rc-costela', 5],
  ['rc-combo', 8],
  ['rc-coca', 8],
  ['rc-cerveja', 6],
  ['rc-suco', 3],
  ['rc-agua', 2],
];

export function createDemoState(): AppState {
  const items: InventoryItem[] = ITEM_SEEDS.map((seed) => ({
    id: seed.id,
    restaurantId: RID,
    name: seed.name,
    category: seed.category,
    unit: seed.unit,
    currentQty: seed.qty,
    minQty: seed.min,
    costCents: seed.cost,
    primarySupplierId: seed.primary,
    updatedAt: NOW_ISO,
  }));

  const recipes: Recipe[] = RECIPE_SEEDS.map((seed) => ({
    id: seed.id,
    restaurantId: RID,
    name: seed.name,
    salePriceCents: seed.salePriceCents,
    ingredients: seed.ingredients,
    createdAt: daysAgoISO(150, 10),
    updatedAt: daysAgoISO(12, 10),
  }));

  const purchases: Purchase[] = PURCHASE_SEEDS.map((seed) => ({
    id: seed.id,
    restaurantId: RID,
    code: seed.code,
    supplierId: seed.supplierId,
    status: seed.status,
    createdAt: seed.createdAt,
    expectedDeliveryAt: seed.expectedDeliveryAt,
    receivedAt: seed.receivedAt,
    receivedBy: seed.receivedBy,
    note: seed.note,
    lines: seed.lines.map<PurchaseLine>((line, index) => ({
      id: `${seed.id}-l${index + 1}`,
      itemId: line.itemId,
      qtyOrdered: line.ordered,
      qtyReceived: line.received,
      expectedUnitCostCents: line.expected,
      receivedUnitCostCents: line.actual ?? null,
    })),
  }));

  const supplierItems: SupplierItem[] = [];
  for (const seed of ITEM_SEEDS) {
    for (const offer of seed.offers) {
      supplierItems.push({
        id: `si-${seed.id}-${offer.supplierId}`,
        restaurantId: RID,
        supplierId: offer.supplierId,
        itemId: seed.id,
        lastPriceCents: offer.price,
        lastPurchaseAt: null,
        leadTimeDays: offer.lead,
        minOrderCents: offer.min,
      });
    }
  }

  const pricePoints: PricePoint[] = [];
  for (const seed of ITEM_SEEDS) {
    const offsets = [90, 60, 30, 2];
    seed.history.forEach((price, index) => {
      pricePoints.push({
        id: `pp-${seed.id}-h${index}`,
        restaurantId: RID,
        itemId: seed.id,
        supplierId: seed.offers[0].supplierId,
        unitCostCents: price,
        at: daysAgoISO(offsets[index], 10, 15),
        source: 'history',
      });
    });
  }

  for (const purchase of purchases) {
    if (!purchase.receivedAt) continue;
    for (const line of purchase.lines) {
      if (line.qtyReceived <= 0 || purchase.status === 'cancelled') continue;
      pricePoints.push({
        id: `pp-${line.id}`,
        restaurantId: RID,
        itemId: line.itemId,
        supplierId: purchase.supplierId,
        unitCostCents: line.receivedUnitCostCents ?? line.expectedUnitCostCents,
        at: purchase.receivedAt,
        source: 'purchase',
      });
    }
  }

  for (const supplierItem of supplierItems) {
    const receipt = purchases
      .filter(
        (p) =>
          p.supplierId === supplierItem.supplierId &&
          p.receivedAt &&
          p.lines.some((l) => l.itemId === supplierItem.itemId && l.qtyReceived > 0),
      )
      .sort((a, b) => new Date(b.receivedAt ?? '').getTime() - new Date(a.receivedAt ?? '').getTime())[0];
    supplierItem.lastPurchaseAt = receipt?.receivedAt ?? daysAgoISO(30, 10);
  }

  const losses: Loss[] = LOSS_SEEDS.map((seed, index) => {
    const item = items.find((i) => i.id === seed.itemId)!;
    return {
      id: `ls-${index + 1}`,
      restaurantId: RID,
      itemId: seed.itemId,
      qty: seed.qty,
      reason: seed.reason,
      note: seed.note,
      valueCents: Math.round(seed.qty * item.costCents),
      at: daysAgoISO(seed.offset, seed.hour, seed.minute),
      userId: seed.userId,
    };
  });

  const counts: CountSession[] = [
    {
      id: 'ct-0042',
      restaurantId: RID,
      code: 'CT-0042',
      status: 'approved',
      startedAt: daysAgoISO(1, 17, 10),
      approvedAt: daysAgoISO(1, 18, 40),
      createdBy: 'u-marina',
      approvedBy: 'u-carlos',
      lines: COUNT_LINES.map((line) => ({
        itemId: line.itemId,
        expectedQty: line.expected,
        countedQty: line.counted,
      })),
    },
    {
      id: 'ct-0041',
      restaurantId: RID,
      code: 'CT-0041',
      status: 'approved',
      startedAt: daysAgoISO(25, 18, 30),
      approvedAt: daysAgoISO(25, 19, 5),
      createdBy: 'u-rafa',
      approvedBy: 'u-marina',
      lines: [
        { itemId: 'it-carne', expectedQty: 31.2, countedQty: 31.2 },
        { itemId: 'it-queijo', expectedQty: 14.4, countedQty: 14.4 },
        { itemId: 'it-pao', expectedQty: 260, countedQty: 260 },
        { itemId: 'it-coca', expectedQty: 180, countedQty: 180 },
        { itemId: 'it-embalagem', expectedQty: 420, countedQty: 420 },
        { itemId: 'it-batata', expectedQty: 26, countedQty: 26 },
      ],
    },
  ];

  const recipeSnapshots = recipes.flatMap((recipe, index) =>
    [
      { days: 60, factor: 0.92 },
      { days: 30, factor: 0.96 },
      { days: 8, factor: 0.99 },
    ].map((snapshot, snapIndex) => {
      const currentCost = RECIPE_SEEDS[index].ingredients.reduce((sum, ing) => {
        const item = items.find((i) => i.id === ing.itemId)!;
        const factor = ing.unit === 'g' ? 0.001 : ing.unit === 'ml' ? 0.001 : 1;
        return sum + ing.qty * factor * item.costCents;
      }, 0);
      return {
        id: `rs-${recipe.id}-${snapIndex + 1}`,
        restaurantId: RID,
        recipeId: recipe.id,
        costCents: Math.round(currentCost * snapshot.factor),
        salePriceCents: recipe.salePriceCents,
        at: daysAgoISO(snapshot.days, 11),
        trigger: snapIndex === 1 ? 'Contagem aprovada' : 'Recálculo de custo',
      };
    }),
  );

  /* ------- Ledger de movimentações: compras, consumo, perdas e ajustes ------- */

  interface Op {
    itemId: string;
    direction: 'in' | 'out';
    qty: number;
    at: string;
    type: Movement['type'];
    unitCostCents: Cents | null;
    reason: string;
    origin: string;
    userId: string;
  }

  const ops: Op[] = [];

  for (const purchase of purchases) {
    if (!purchase.receivedAt || purchase.status === 'cancelled') continue;
    for (const line of purchase.lines) {
      if (line.qtyReceived <= 0) continue;
      ops.push({
        itemId: line.itemId,
        direction: 'in',
        qty: line.qtyReceived,
        at: purchase.receivedAt,
        type: 'PURCHASE',
        unitCostCents: line.receivedUnitCostCents ?? line.expectedUnitCostCents,
        reason: `Recebimento ${purchase.code}`,
        origin: purchase.code,
        userId: purchase.receivedBy ?? 'u-marina',
      });
    }
  }

  for (const loss of losses) {
    ops.push({
      itemId: loss.itemId,
      direction: 'out',
      qty: loss.qty,
      at: loss.at,
      type: 'LOSS',
      unitCostCents: Math.round(loss.valueCents / loss.qty),
      reason: loss.reason,
      origin: `Perda ${loss.id.toUpperCase()}`,
      userId: loss.userId,
    });
  }

  for (const count of counts) {
    if (!count.approvedAt) continue;
    for (const line of count.lines) {
      if (line.countedQty == null) continue;
      const diff = line.countedQty - line.expectedQty;
      if (Math.abs(diff) < 0.0001) continue;
      const item = items.find((i) => i.id === line.itemId)!;
      ops.push({
        itemId: line.itemId,
        direction: diff > 0 ? 'in' : 'out',
        qty: Math.abs(diff),
        at: count.approvedAt,
        type: 'ADJUSTMENT',
        unitCostCents: item.costCents,
        reason: `Contagem física ${count.code}`,
        origin: count.code,
        userId: count.approvedBy ?? 'u-marina',
      });
    }
  }

  const random = rng(73);
  const consumptionByDay: { date: string; quantities: Map<string, number>; orders: number }[] = [];
  for (let offset = 29; offset >= 0; offset--) {
    const day = new Date(NOW_ISO);
    day.setDate(day.getDate() - offset);
    const weekday = day.getDay();
    let orders = 36 + Math.round((random() - 0.5) * 8);
    if (weekday === 5 || weekday === 6) orders += 12;
    if (weekday === 0) orders += 2;
    const at =
      offset === 0
        ? daysAgoISO(0, 19, 30)
        : daysAgoISO(offset, 23, 20);
    const quantities = new Map<string, number>();

    for (let i = 0; i < orders; i++) {
      const roll = random() * 100;
      let acc = 0;
      let chosen = RECIPE_MIX[0][0];
      for (const [recipeId, weight] of RECIPE_MIX) {
        acc += weight;
        if (roll <= acc) {
          chosen = recipeId;
          break;
        }
      }
      const recipe = recipes.find((r) => r.id === chosen)!;
      for (const ingredient of recipe.ingredients) {
        const item = items.find((it) => it.id === ingredient.itemId)!;
        const factor = ingredient.unit === 'g' || ingredient.unit === 'ml' ? 0.001 : 1;
        const used = ingredient.qty * factor;
        quantities.set(item.id, (quantities.get(item.id) ?? 0) + used);
      }
    }

    for (const [itemId, quantity] of quantities) {
      if (quantity <= 0) continue;
      const item = items.find((i) => i.id === itemId)!;
      ops.push({
        itemId,
        direction: 'out',
        qty: Math.round(quantity * 1000) / 1000,
        at,
        type: 'CONSUMPTION',
        unitCostCents: item.costCents,
        reason: `Consumo por vendas · ${orders} pedidos`,
        origin: 'DACOT Pedidos · ORDER_DELIVERED',
        userId: 'u-sistema',
      });
    }

    if (offset <= 1) {
      consumptionByDay.push({ date: at, quantities, orders });
    }
  }

  /* ------- Abertura implícita para fechar no estoque atual ------- */

  const opening = new Map<string, number>();
  for (const item of items) {
    const ins = ops
      .filter((op) => op.itemId === item.id && op.direction === 'in')
      .reduce((sum, op) => sum + op.qty, 0);
    const outs = ops
      .filter((op) => op.itemId === item.id && op.direction === 'out')
      .reduce((sum, op) => sum + op.qty, 0);
    opening.set(item.id, item.currentQty - ins + outs);
  }

  const sortedOps = [...ops].sort((a, b) => {
    const delta = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (delta !== 0) return delta;
    return a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1;
  });

  const balances = new Map(opening);
  const movements: Movement[] = sortedOps.map((op, index) => {
    const item = items.find((i) => i.id === op.itemId)!;
    const next = (balances.get(op.itemId) ?? 0) + (op.direction === 'in' ? op.qty : -op.qty);
    balances.set(op.itemId, Math.round(next * 1000) / 1000);
    return {
      id: `mv-${String(index + 1).padStart(4, '0')}`,
      restaurantId: RID,
      itemId: op.itemId,
      type: op.type,
      direction: op.direction,
      qty: op.qty,
      unit: item.unit,
      unitCostCents: op.unitCostCents,
      occurredAt: op.at,
      reason: op.reason,
      origin: op.origin,
      userId: op.userId,
      balanceAfter: Math.round(next * 1000) / 1000,
    };
  });

  for (const item of items) {
    const last = movements
      .filter((m) => m.itemId === item.id)
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];
    if (last) item.updatedAt = last.occurredAt;
  }

  /* ------- Eventos de pedidos (arquitetura de integração) ------- */

  const orderEvents: OrderEvent[] = [];
  const processedEventIds: string[] = [];
  const lastOrders = consumptionByDay[consumptionByDay.length - 1];
  for (let i = 1; i <= 8; i++) {
    const roll = (i * 37) % 100;
    let acc = 0;
    let chosen = RECIPE_MIX[0][0];
    for (const [recipeId, weight] of RECIPE_MIX) {
      acc += weight;
      if (roll <= acc) {
        chosen = recipeId;
        break;
      }
    }
    const eventId = `evt-${1000 + i}`;
    orderEvents.push({
      id: eventId,
      type: 'ORDER_DELIVERED',
      restaurantId: RID,
      orderId: `PD-${8620 + i}`,
      occurredAt: lastOrders?.date ?? NOW_ISO,
      lines: [{ recipeId: chosen, qty: 1 + (i % 2) }],
      processedAt: NOW_ISO,
    });
    processedEventIds.push(eventId);
  }
  orderEvents.reverse();

  const audit: AuditEntry[] = [
    {
      id: 'au-1',
      restaurantId: RID,
      userId: 'u-carlos',
      action: 'count.approve',
      entity: 'count',
      entityLabel: 'CT-0042',
      before: 'Esperado 22,5 kg',
      after: 'Contado 16 kg',
      reason: 'Contagem física de costela bovina',
      at: daysAgoISO(1, 18, 40),
    },
    {
      id: 'au-2',
      restaurantId: RID,
      userId: 'u-marina',
      action: 'purchase.receive',
      entity: 'purchase',
      entityLabel: 'PC-1045',
      before: 'Solicitado 100 pães / 16 kg frango',
      after: 'Recebido 90 pães / 15 kg frango',
      reason: 'Recebimento parcial com saldo pendente',
      at: daysAgoISO(2, 10, 30),
    },
    {
      id: 'au-3',
      restaurantId: RID,
      userId: 'u-marina',
      action: 'cost.change',
      entity: 'item',
      entityLabel: 'Peito de frango',
      before: 'R$ 19,40/kg',
      after: 'R$ 19,70/kg',
      reason: 'Preço atualizado no recebimento PC-1045',
      at: daysAgoISO(2, 10, 30),
    },
    {
      id: 'au-4',
      restaurantId: RID,
      userId: 'u-carlos',
      action: 'recipe.cost.snapshot',
      entity: 'recipe',
      entityLabel: 'X-Burger Artesanal',
      before: 'R$ 9,96',
      after: 'R$ 10,22',
      reason: 'Custo recalculado após alta do queijo',
      at: daysAgoISO(8, 11, 20),
    },
    {
      id: 'au-5',
      restaurantId: RID,
      userId: 'u-rafa',
      action: 'loss.register',
      entity: 'loss',
      entityLabel: 'Carne bovina · 3,2 kg',
      before: null,
      after: 'R$ 115,84',
      reason: 'Vencimento',
      at: daysAgoISO(1, 14, 10),
    },
    {
      id: 'au-6',
      restaurantId: RID,
      userId: 'u-carlos',
      action: 'purchase.cancel',
      entity: 'purchase',
      entityLabel: 'PC-1038',
      before: 'Solicitado',
      after: 'Cancelado',
      reason: 'Entrega não realizada pelo fornecedor',
      at: daysAgoISO(15, 11, 40),
    },
  ];

  return {
    restaurant: RESTAURANT,
    users: USERS,
    currentUserId: 'u-carlos',
    suppliers: SUPPLIERS,
    supplierItems,
    items,
    purchases,
    recipes,
    recipeSnapshots,
    counts,
    losses,
    movements,
    pricePoints,
    audit,
    events: orderEvents,
    processedEventIds,
  };
}

export const DAY = DAY_MS;
