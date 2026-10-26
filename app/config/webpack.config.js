'use strict';

const path = require('path');
const webpack = require('webpack');
const { merge } = require('webpack-merge');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const common = require('../../extension/config/webpack.common.js');

const APP = path.resolve(__dirname, '..');
const VENDOR = path.resolve(APP, '../shared/vendor');

// Cache busting: the HTML pages reference assets as "/app.js?v=__BUILD__";
// replace that with this build's hash so a reload never mixes old and new files.
class BuildStampPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('BuildStampPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'BuildStampPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE },
        (assets) => {
          const stamp = (compilation.hash || String(Date.now())).slice(0, 12);
          Object.keys(assets)
            .filter((name) => name.endsWith('.html'))
            .forEach((name) => {
              const html = assets[name].source().toString().replace(/__BUILD__/g, stamp);
              compilation.updateAsset(name, new webpack.sources.RawSource(html));
            });
        }
      );
    });
  }
}

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
      new BuildStampPlugin(),
    ],
  });
