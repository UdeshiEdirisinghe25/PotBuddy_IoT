const appJson = require("./app.json");

module.exports = ({ config }) => ({
  ...appJson.expo,
  ...config,
  extra: {
    ...appJson.expo.extra,
    ...config.extra,
    apiPort: Number(process.env.API_PORT),
  },
});
