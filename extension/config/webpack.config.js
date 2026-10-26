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
function transformManifest(dev, name) {
  return (content) => {
    const manifest = JSON.parse(content.toString());
    if (dev) {
      manifest.name = name;
      manifest.action = { ...(manifest.action || {}), default_title: name };
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

// Builds:
//   (default)   production, extension/build
//   --env dev   "Bc Tagger (dev)" into ../dev-extension-build (hot reload)
//   --env e2e   "Bc Tagger (e2e)" into .e2e/extension, for scripts/e2e (its own
//               server via BC_DEFAULT_SERVER_URL, so tests never reach :8765)
const config = (env, argv) => {
  const e2e = !!(env && env.e2e);
  const dev = e2e || !!(env && env.dev);
  const outDir = e2e && !process.env.BC_EXT_OUT ? PATHS.root + '/.e2e/extension' : PATHS.buildDir(dev);
  const defaultServer = process.env.BC_DEFAULT_SERVER_URL || 'http://127.0.0.1:8765';
  return merge(common, {
    entry: {
      popup: PATHS.src + '/popup.js',
      contentScript: PATHS.src + '/contentScript.js',
      appBridge: PATHS.src + '/appBridge.js',
      background: PATHS.src + '/background.js',
      checkout: PATHS.src + '/checkout.js',
      createTag: PATHS.src + '/createTag.js',
      collection: PATHS.src + '/collection.js',
      import: PATHS.src + '/import.js',
      popupCss: PATHS.src + '/popup.css',
      collectionCss: PATHS.src + '/collection.css',
    },
    output: {
      // the build folder to output bundles and assets in.
      path: outDir,
    },
    devtool: argv.mode === 'production' ? false : 'source-map',
    plugins: [
      new webpack.DefinePlugin({
        __DEV_BUILD__: JSON.stringify(dev),
        __DEFAULT_SERVER_URL__: JSON.stringify(defaultServer),
      }),
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
            transform: transformManifest(dev, e2e ? 'Bc Tagger (e2e)' : DEV_NAME),
          },
          { from: '**/*', context: PATHS.vendor },
        ],
      }),
      ...(dev ? [new DevBuildIdPlugin()] : []),
    ],
  });
};

module.exports = config;
