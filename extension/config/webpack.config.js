'use strict';

const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const { merge } = require('webpack-merge');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const common = require('./webpack.common.js');
const PATHS = require('./paths');

const DEV_NAME = 'Bc Tagger (dev)';

// Dev builds (`--env dev`) go to the dev-extension-build folder and always keep
// the "(dev)" name so they never look like (or replace) the production install.
// No manifest `key`: the dev extension ID must keep coming from the folder path.
function transformManifest(dev) {
  return (content) => {
    const manifest = JSON.parse(content.toString());
    if (dev) {
      manifest.name = DEV_NAME;
      manifest.action = { ...(manifest.action || {}), default_title: DEV_NAME };
      manifest.description =
        'Development copy of Bc Tagger (separate storage from the main install)';
      delete manifest.key;
    }
    return JSON.stringify(manifest, null, 2);
  };
}

// Dev hot reload: write a fresh build id after every compile. The dev
// background script polls it and calls chrome.runtime.reload() on change.
class DevBuildIdPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('DevBuildIdPlugin', (compilation) => {
      const out = compilation.outputOptions.path;
      fs.writeFileSync(path.join(out, 'dev-build-id.txt'), String(Date.now()));
    });
  }
}

const config = (env, argv) => {
  const dev = !!(env && env.dev);
  return merge(common, {
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
    output: {
      // the build folder to output bundles and assets in.
      path: PATHS.buildDir(dev),
    },
    devtool: argv.mode === 'production' ? false : 'source-map',
    plugins: [
      new webpack.DefinePlugin({ __DEV_BUILD__: JSON.stringify(dev) }),
      // Copy static assets (extension pages + shared vendor libs) to the build root.
      new CopyWebpackPlugin({
        patterns: [
          {
            from: '**/*',
            context: PATHS.public,
            globOptions: { ignore: ['**/manifest.json'] },
          },
          {
            from: 'manifest.json',
            context: PATHS.public,
            transform: transformManifest(dev),
          },
          { from: '**/*', context: PATHS.vendor },
        ],
      }),
      ...(dev ? [new DevBuildIdPlugin()] : []),
    ],
  });
};

module.exports = config;
