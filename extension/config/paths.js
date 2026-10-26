'use strict';

const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

// Default output for dev builds: <repo parent>/dev-extension-build, i.e. the
// folder the dev copy ("Bc Tagger (dev)") is loaded unpacked from. Resolved via
// the git common dir so it is the same folder from the main checkout and from
// every worktree.
function defaultDevBuildDir() {
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return path.resolve(common, '..', '..', 'dev-extension-build');
  } catch (e) {
    return path.resolve(ROOT, '..', 'dev-extension-build');
  }
}

// BC_EXT_OUT overrides the output folder for any build.
function buildDir(dev) {
  if (process.env.BC_EXT_OUT) return path.resolve(process.env.BC_EXT_OUT);
  return dev ? defaultDevBuildDir() : path.resolve(__dirname, '../build');
}

const PATHS = {
  root: ROOT,
  src: path.resolve(__dirname, '../src'),
  public: path.resolve(__dirname, '../public'),
  shared: path.resolve(ROOT, 'shared'),
  vendor: path.resolve(ROOT, 'shared/vendor'),
  buildDir,
};

module.exports = PATHS;
