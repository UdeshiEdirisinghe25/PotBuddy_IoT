const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Firebase Auth relies on its React Native entry point. Metro's package
// exports resolution can select the wrong entry and leave the Auth component
// unregistered, so use Firebase's react-native package entry instead.
config.resolver.unstable_enablePackageExports = false;

// Firebase ships CommonJS modules that Metro must recognize explicitly.
if (!config.resolver.sourceExts.includes("cjs")) {
  config.resolver.sourceExts.push("cjs");
}

module.exports = config;
