/** @jest-environment node */
const configModule: any = {exports:{}};
require('vm').runInNewContext(require('fs').readFileSync(require('path').resolve(__dirname, '../../app.config.js'), 'utf8'), {module:configModule,process,URL});
const configure = configModule.exports;
const config=require('../../app.json').expo;
const saved={...process.env};
afterEach(()=>{for(const key of ['EAS_BUILD_PROFILE','EXPO_PUBLIC_API_BASE','PIA_IOS_BUNDLE_ID','PIA_ANDROID_PACKAGE']) { if(saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }});
test('release requires HTTPS',()=>{process.env.EAS_BUILD_PROFILE='production';delete process.env.EXPO_PUBLIC_API_BASE;expect(()=>configure({config})).toThrow('HTTPS');});
test('release requires owned identifiers',()=>{process.env.EAS_BUILD_PROFILE='preview';process.env.EXPO_PUBLIC_API_BASE='https://pia.example.com';delete process.env.PIA_IOS_BUNDLE_ID;delete process.env.PIA_ANDROID_PACKAGE;expect(()=>configure({config})).toThrow('identifiers');});
test('release exports supplied endpoint and identifiers',()=>{process.env.EAS_BUILD_PROFILE='production';process.env.EXPO_PUBLIC_API_BASE='https://pia.example.com';process.env.PIA_IOS_BUNDLE_ID='com.example.pia';process.env.PIA_ANDROID_PACKAGE='com.example.pia';expect(configure({config})).toMatchObject({extra:{apiBase:'https://pia.example.com'},ios:{bundleIdentifier:'com.example.pia'},android:{package:'com.example.pia'}});});

test.each(['https://localhost', 'https://user:secret@pia.example.com', 'https://pia.example.com/app'])('release rejects unusable endpoint %s', endpoint => {process.env.EAS_BUILD_PROFILE='production'; process.env.EXPO_PUBLIC_API_BASE=endpoint; expect(()=>configure({config})).toThrow('HTTPS');});
