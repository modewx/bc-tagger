'use strict';

const path = require('path');
const { merge } = require('webpack-merge');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const common = require('../../extension/config/webpack.common.js');

const APP = path.resolve(__dirname, '..');
const VENDOR = path.resolve(APP, '../shared/vendor');

// The local app, served by the bc-tagger server (server/) from app/dist at "/".
module.exports = (env, argv) =>
  merge(common, {
    entry: {
      app: APP + '/src/app.js',
      settings: APP + '/src/settings.js',
      appCss: APP + '/src/app.css',
      settingsCss: APP + '/src/settings.css',
    },
    output: {
      path: process.env.BC_APP_OUT ? path.resolve(process.env.BC_APP_OUT) : APP + '/dist',
      publicPath: '/',
    },
    devtool: argv.mode === 'production' ? false : 'source-map',
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: '**/*', context: APP + '/public' },
          { from: '**/*', context: VENDOR },
        ],
      }),
    ],
  });
