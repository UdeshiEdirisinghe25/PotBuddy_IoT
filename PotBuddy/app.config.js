const appJson = require("./app.json");

module.exports = ({ config }) => {
  // Keep any plugins already in app.json / config, then add expo-font once
  const basePlugins = config.plugins ?? appJson.expo.plugins ?? [];
  const hasExpoFont = basePlugins.some(
    (p) => (Array.isArray(p) ? p[0] : p) === "expo-font"
  );

  return {
    ...appJson.expo,
    ...config,
    plugins: hasExpoFont ? basePlugins : [...basePlugins, "expo-font"],
    extra: {
      ...appJson.expo.extra,
      ...config.extra,
      apiPort: process.env.API_PORT ? Number(process.env.API_PORT) : undefined,
      eas: {
        ...appJson.expo.extra?.eas,
        ...config.extra?.eas,
        ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID
          ? { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID }
          : {}),
      },
    },
  };
};