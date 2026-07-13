export function checkBearer(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!m && m[1] === token;
}
