export function authStartupMessage(status: number | null, detail = ''): string {
  const normalized = detail.toLowerCase();
  if (normalized.includes('vite_api_base_url') || normalized.includes('api_origin_missing')) {
    return 'A conexão com o serviço Estoque não está configurada. Avise o suporte DACOT.';
  }
  if (normalized.includes('api_origin_invalid')) {
    return 'A configuração de conexão do Estoque é inválida. Avise o suporte DACOT.';
  }
  if (status === 401) {
    return normalized.includes('handoff')
      ? 'O link de acesso expirou ou é inválido. Volte ao DACOT-HUB e abra o Estoque novamente.'
      : 'Sua sessão expirou. Entre novamente pelo DACOT-HUB.';
  }
  if (status === 403) {
    return normalized.includes('inactive') || normalized.includes('revoked')
      ? 'O acesso ao Estoque está inativo ou foi revogado. Verifique o módulo no DACOT-HUB.'
      : 'Seu usuário não tem permissão para acessar o Estoque. Verifique seu perfil no DACOT-HUB.';
  }
  if (status === 503) {
    return 'O serviço de autenticação ou o backend está indisponível. Tente novamente em instantes.';
  }
  if (status === null) {
    return 'Não foi possível conectar ao backend. Verifique sua conexão e tente novamente.';
  }
  return 'Não foi possível abrir o Estoque. Tente novamente ou entre pelo DACOT-HUB.';
}

export function hubAuthorizationUnavailable(status: number, detail: string): boolean {
  if (status !== 503) return false;
  const normalized = detail.toLowerCase();
  return normalized.includes('dacot-hub')
    || normalized.startsWith('invalid access response')
    || normalized.startsWith('invalid module status response');
}

export function responseEndsAuthenticatedSession(status: number, detail: string): boolean {
  return status === 401
    || (status === 403
      && detail !== 'Insufficient permissions'
      && detail !== 'Request origin is not authorized')
    || hubAuthorizationUnavailable(status, detail);
}
