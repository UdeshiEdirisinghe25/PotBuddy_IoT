const appJson = require("./app.json");

module.exports = ({ config }) => ({
  ...appJson.expo,
  ...config,
  extra: {
    ...appJson.expo.extra,
    ...config.extra,
    apiPort: Number(process.env.API_PORT),
    eas: {
      ...appJson.expo.extra?.eas,
      ...config.extra?.eas,
      ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID
        ? { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID }
        : {}),
    },
  },
});
