const { readFileSync, existsSync, mkdirSync } = require('fs');
const { resolve } = require('path');
const AdmZip = require('adm-zip');

// Zips the production build (extension/build) into <repo>/release/.
try {
  const root = resolve(__dirname, '..');
  const { name } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const build = resolve(__dirname, 'build');
  const { version } = JSON.parse(
    readFileSync(resolve(build, 'manifest.json'), 'utf8')
  );

  const outdir = resolve(root, 'release');
  const filename = `${name}-v${version}.zip`;
  const zip = new AdmZip();
  zip.addLocalFolder(build);
  if (!existsSync(outdir)) {
    mkdirSync(outdir);
  }
  zip.writeZip(`${outdir}/${filename}`);

  console.log(
    `Success! Created a ${filename} file under ${outdir} directory. You can upload this file to web store.`
  );
} catch (e) {
  console.error('Error! Failed to generate a zip file.');
}
