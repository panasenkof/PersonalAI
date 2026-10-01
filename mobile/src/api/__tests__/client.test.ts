import { api, configureApi } from '../client';
test('wrong password does not revoke mobile session or retry', async () => {
  const setTokens = jest.fn(async()=>{});
  configureApi({getBase:()=> 'https://pia.example.com',getTokens:()=>({access_token:'existing',refresh_token:'refresh'}),setTokens});
  const mock = jest.fn(async()=>({ok:false,status:401,json:async()=>({detail:'invalid_credentials'})}));
  const original = global.fetch; global.fetch=mock as unknown as typeof fetch;
  try {await expect(api.changePassword('wrong','new-password')).rejects.toMatchObject({detail:'invalid_credentials'});expect(mock).toHaveBeenCalledTimes(1);expect(setTokens).not.toHaveBeenCalled();} finally {global.fetch=original;}
});
