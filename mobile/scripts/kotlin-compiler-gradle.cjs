/** One deterministic compiler pin for Expo 57 generated Android builds.
 * Expo #49668: android.kotlinVersion alone leaves KGP on RN's 2.1 classpath.
 * Fail the prebuild rather than silently compiling with the wrong toolchain.
 */
const KOTLIN_VERSION = "2.4.21";
function pinKotlinGradlePlugin(source) {
  if (typeof source !== "string") throw new Error("kotlin_pin_not_groovy");
  const unversioned = /classpath\s*\(\s*['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin['"]\s*\)/g;
  const matches = source.match(unversioned);
  if (!matches || matches.length !== 1) {
    throw new Error("kotlin_pin_root_gradle_template_changed");
  }
  return source.replace(unversioned, "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:" + KOTLIN_VERSION + "')");
}
module.exports = { KOTLIN_VERSION, pinKotlinGradlePlugin };
