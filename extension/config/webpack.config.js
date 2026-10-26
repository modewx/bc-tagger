

const { merge } = require('webpack-merge');

const common = require('./webpack.common.js');
const PATHS = require('./paths');

// Merge webpack configuration files
const config = (env, argv) =>
  merge(common, {
    entry: {
      popup: PATHS.src + '/popup.js',
      contentScript: PATHS.src + '/contentScript.js',
      background: PATHS.src + '/background.js',
      checkout: PATHS.src + '/checkout.js',
      createTag: PATHS.src + '/createTag.js',
      collection: PATHS.src + '/collection.js',
      popupCss: PATHS.src + '/popup.css',
      collectionCss: PATHS.src + '/collection.css',
    },
    devtool: argv.mode === 'production' ? false : 'source-map',
  });

module.exports = config;
