import { authError, normalizeServer } from '../ux';
test.each(['https://pia.example.com', 'http://192.168.1.3:8000', 'http://localhost:8000'])('accepts supported server %s', url => expect(normalizeServer(` ${url}/ `)).toBe(url));
test.each(['', 'pia.example.com', 'https://host/app', 'https://user:password@host', 'https://host?token=secret', 'ftp://host', 'http://public.example.com', 'http://192.168.evil.example', 'https://host:65536', 'http://010.0.0.1'])('rejects unsafe or unusable server %s', url => expect(() => normalizeServer(url)).toThrow());
test('translates actionable errors', () => {
  expect(authError('email_taken')).toContain('Войти'); expect(authError('Network request failed')).toContain('адрес сервера'); expect(authError('HTTP 422')).toContain('8 символов');
});
