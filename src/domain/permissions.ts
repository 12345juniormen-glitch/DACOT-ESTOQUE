import type { Role } from './types';

export type Permission =
  | 'overview.view'
  | 'stock.view'
  | 'stock.adjust'
  | 'stock.create'
  | 'count.view'
  | 'count.perform'
  | 'count.approve'
  | 'purchases.view'
  | 'purchases.manage'
  | 'purchases.receive'
  | 'suppliers.view'
  | 'suppliers.manage'
  | 'recipes.view'
  | 'recipes.manage'
  | 'losses.view'
  | 'losses.manage'
  | 'audit.view';

const ADMIN: Permission[] = [
  'overview.view',
  'stock.view',
  'stock.adjust',
  'stock.create',
  'count.view',
  'count.perform',
  'count.approve',
  'purchases.view',
  'purchases.manage',
  'purchases.receive',
  'suppliers.view',
  'suppliers.manage',
  'recipes.view',
  'recipes.manage',
  'losses.view',
  'losses.manage',
  'audit.view',
];

const MANAGER: Permission[] = [
  'overview.view',
  'stock.view',
  'stock.adjust',
  'stock.create',
  'count.view',
  'count.perform',
  'count.approve',
  'purchases.view',
  'purchases.manage',
  'purchases.receive',
  'suppliers.view',
  'recipes.view',
  'losses.view',
  'losses.manage',
  'audit.view',
];

const OPERATOR: Permission[] = [
  'overview.view',
  'stock.view',
  'count.view',
  'count.perform',
  'purchases.view',
  'purchases.receive',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ADMIN,
  manager: MANAGER,
  operator: OPERATOR,
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrador',
  manager: 'Gerente',
  operator: 'Operador de estoque',
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
