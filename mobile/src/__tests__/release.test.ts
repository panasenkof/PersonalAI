/** @jest-environment node */
const configModule: any = {exports:{}};
require('vm').runInNewContext(require('fs').readFileSync(require('path').resolve(__dirname, '../../app.config.js'), 'utf8'), {module:configModule,process,URL});
const configure = configModule.exports;
const config=require('../../app.json').expo;
const saved={...process.env};
afterEach(()=>{for(const key of ['EAS_BUILD_PROFILE','PIA_IOS_BUNDLE_ID','PIA_ANDROID_PACKAGE']) { if(saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }});
test('development config pins the published Android identity without a server',()=>{delete process.env.EAS_BUILD_PROFILE;delete process.env.PIA_ANDROID_PACKAGE;const built=configure({config});expect(built.extra?.apiBase).toBeUndefined();expect(built.name).toBe('PersAI');expect(built.android.package).toBe('com.persai.app');});
test('release requires owned identifiers',()=>{process.env.EAS_BUILD_PROFILE='preview';delete process.env.PIA_IOS_BUNDLE_ID;delete process.env.PIA_ANDROID_PACKAGE;expect(()=>configure({config})).toThrow('identifiers');});
test('release uses the pinned Android identity without a server endpoint',()=>{process.env.EAS_BUILD_PROFILE='production';process.env.PIA_IOS_BUNDLE_ID='com.example.pia';process.env.PIA_ANDROID_PACKAGE='com.persai.app';const built=configure({config});expect(built).toMatchObject({ios:{bundleIdentifier:'com.example.pia'},android:{package:'com.persai.app'}});expect(built.extra?.apiBase).toBeUndefined();});
test('wrong Actions variable cannot change the published Android package',()=>{process.env.PIA_ANDROID_PACKAGE='com.paigent.app';expect(()=>configure({config})).toThrow('PIA_ANDROID_PACKAGE must be com.persai.app');});
test('Android builds allow http:// to local models through a manifest plugin',()=>{delete process.env.EAS_BUILD_PROFILE;const built=configure({config});expect(built.plugins.some((p:any)=>typeof p==='function')).toBe(true);expect(built.plugins).toEqual(expect.arrayContaining(config.plugins));});
