/** @jest-environment node */
const configModule: any = {exports:{}};
require('vm').runInNewContext(require('fs').readFileSync(require('path').resolve(__dirname, '../../app.config.js'), 'utf8'), {module:configModule,process,URL});
const configure = configModule.exports;
const config=require('../../app.json').expo;
const saved={...process.env};
afterEach(()=>{for(const key of ['EAS_BUILD_PROFILE','PIA_IOS_BUNDLE_ID','PIA_ANDROID_PACKAGE']) { if(saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }});
test('development config needs no server and no identifiers',()=>{delete process.env.EAS_BUILD_PROFILE;delete process.env.PIA_ANDROID_PACKAGE;const built=configure({config});expect(built.extra?.apiBase).toBeUndefined();expect(built.name).toBe('PersAI');});
test('release requires owned identifiers',()=>{process.env.EAS_BUILD_PROFILE='preview';delete process.env.PIA_IOS_BUNDLE_ID;delete process.env.PIA_ANDROID_PACKAGE;expect(()=>configure({config})).toThrow('identifiers');});
test('release exports supplied identifiers without a server endpoint',()=>{process.env.EAS_BUILD_PROFILE='production';process.env.PIA_IOS_BUNDLE_ID='com.example.pia';process.env.PIA_ANDROID_PACKAGE='com.example.pia';const built=configure({config});expect(built).toMatchObject({ios:{bundleIdentifier:'com.example.pia'},android:{package:'com.example.pia'}});expect(built.extra?.apiBase).toBeUndefined();});
test('Android builds allow http:// to local models through a manifest plugin',()=>{delete process.env.EAS_BUILD_PROFILE;const built=configure({config});expect(built.plugins.some((p:any)=>typeof p==='function')).toBe(true);expect(built.plugins).toEqual(expect.arrayContaining(config.plugins));});
