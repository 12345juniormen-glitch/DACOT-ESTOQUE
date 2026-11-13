export type ApiOriginResult = { baseUrl: string; error: null }
  | { baseUrl: null; error: 'API_ORIGIN_MISSING' | 'API_ORIGIN_INVALID' };

export function resolveApiOrigin(rawValue: string | undefined, production: boolean): ApiOriginResult {
  const value = rawValue?.trim();
  if (!value) {
    return production
      ? { baseUrl: null, error: 'API_ORIGIN_MISSING' }
      : { baseUrl: 'http://localhost:8000', error: null };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { baseUrl: null, error: 'API_ORIGIN_INVALID' };
  }

  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
      || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    return { baseUrl: null, error: 'API_ORIGIN_INVALID' };
  }

  if (production) {
    const hostname = url.hostname.toLowerCase();
    const dacotHost = hostname === 'dacot.com.br' || hostname.endsWith('.dacot.com.br');
    if (url.protocol !== 'https:' || url.port || !dacotHost) {
      return { baseUrl: null, error: 'API_ORIGIN_INVALID' };
    }
  }

  return { baseUrl: url.origin, error: null };
}
