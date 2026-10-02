import { api, configureApi } from '../client';
test('wrong password does not revoke mobile session or retry', async () => {
  const setTokens = jest.fn(async()=>{});
  configureApi({getBase:()=> 'https://pia.example.com',getTokens:()=>({access_token:'existing',refresh_token:'refresh'}),setTokens});
  const mock = jest.fn(async()=>({ok:false,status:401,json:async()=>({detail:'invalid_credentials'})}));
  const original = global.fetch; global.fetch=mock as unknown as typeof fetch;
  try {await expect(api.changePassword('wrong','new-password')).rejects.toMatchObject({detail:'invalid_credentials'});expect(mock).toHaveBeenCalledTimes(1);expect(setTokens).not.toHaveBeenCalled();} finally {global.fetch=original;}
});

describe('refresh failure classification', () => {
  let tokens: {access_token: string; refresh_token: string} | null;
  let setTokens: jest.Mock;
  let original: typeof fetch;
  beforeEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    tokens = {access_token: 'old', refresh_token: 'refresh'};
    setTokens = jest.fn(async (value) => {tokens = value;});
    configureApi({getBase: () => 'https://pia.example.com', getTokens: () => tokens, setTokens});
    original = global.fetch;
  });
  afterEach(() => {global.fetch = original;});
  const response = (status: number, body = {}) => ({ok: status >= 200 && status < 300, status, json: async () => body});

  test.each([429, 500, 503])('HTTP %i on refresh preserves session for retry', async status => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(status)) as typeof fetch;
    await expect(api.me()).rejects.toMatchObject({status, detail: 'refresh_temporarily_unavailable'});
    expect(setTokens).not.toHaveBeenCalled();
    expect(tokens?.refresh_token).toBe('refresh');
    await new Promise(resolve => setTimeout(resolve, 1));
    global.fetch = jest.fn().mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, {access_token:'new', refresh_token:'new-refresh'}))
      .mockResolvedValueOnce(response(200, {id:'user'})) as typeof fetch;
    await expect(api.me()).resolves.toMatchObject({id:'user'});
    expect(tokens?.access_token).toBe('new');
  });

  test('network timeout preserves tokens', async () => {
    const error = new Error('Network request timed out');
    global.fetch = jest.fn().mockResolvedValueOnce(response(401)).mockRejectedValueOnce(error) as typeof fetch;
    await expect(api.me()).rejects.toBe(error);
    expect(setTokens).not.toHaveBeenCalled();
  });

  test.each([401, 403])('HTTP %i confirms session invalidation', async status => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(status)) as typeof fetch;
    await expect(api.me()).rejects.toMatchObject({detail:'session_expired'});
    expect(setTokens).toHaveBeenCalledWith(null);
  });

  test('concurrent unauthorized requests share refresh', async () => {
    let resolveRefresh: (value: unknown) => void = () => {};
    const refreshing = new Promise(resolve => {resolveRefresh = resolve;});
    const mock = jest.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/refresh')) return refreshing;
      return Promise.resolve(init.headers && (init.headers as Record<string,string>).Authorization === 'Bearer new'
        ? response(200, {id:'user'}) : response(401));
    });
    global.fetch = mock as unknown as typeof fetch;
    const requests = [api.me(), api.me()];
    await new Promise(resolve => setTimeout(resolve, 1));
    resolveRefresh(response(200, {access_token:'new',refresh_token:'new-refresh'}));
    await expect(Promise.all(requests)).resolves.toHaveLength(2);
    expect(mock.mock.calls.filter(([url]) => url.endsWith('/refresh'))).toHaveLength(1);
  });
});
