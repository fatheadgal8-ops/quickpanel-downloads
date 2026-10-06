'use strict';
/**
 * Runs after electron-builder has assembled the app folder, before installers are made.
 *  - Windows: stamps QuickPanel's icon + version info onto the .exe in pure JavaScript,
 *             so Windows builds work on any machine (no Wine needed).
 *  - macOS:   ad-hoc code-signs the .app so it launches on Apple Silicon.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function stampWindowsExe(exePath, context) {
  const mod = await import('resedit');
  const R = mod.NtExecutable ? mod : mod.default;
  const { NtExecutable, NtExecutableResource, Resource, Data } = R;

  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);

  // Icon: replace every icon group the Electron template ships with.
  const icoPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  const icon = Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups : [{ id: 1, lang: 1033 }];
  for (const g of targets) {
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map(i => i.data));
  }

  // Version info shown in Task Manager / file properties.
  const version = context.packager.appInfo.version;
  const [maj = 1, min = 0, pat = 0] = String(version).split('.').map(n => parseInt(n, 10) || 0);
  const infos = Resource.VersionInfo.fromEntries(res.entries);
  if (infos.length) {
    const vi = infos[0];
    const lang = (vi.lang !== undefined) ? vi.lang : 1033;
    vi.setFileVersion(maj, min, pat, 0, lang);
    vi.setProductVersion(maj, min, pat, 0, lang);
    vi.setStringValues({ lang, codepage: 1200 }, {
      FileDescription: 'QuickPanel Dashboard',
      ProductName: 'QuickPanel',
      CompanyName: 'QuickPanel',
      LegalCopyright: 'QuickPanel Dashboard',
      OriginalFilename: path.basename(exePath),
      InternalName: 'QuickPanel',
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  // Sanity check: the rewritten file must still parse as a valid Windows executable.
  NtExecutable.from(out);
  if (out.slice(0, 2).toString('latin1') !== 'MZ') throw new Error('Stamped .exe is not a valid PE file');
  fs.writeFileSync(exePath, out);
  console.log('  • stamped QuickPanel icon + version onto ' + path.basename(exePath));
}

function adhocSign(appPath) {
  if (process.platform !== 'darwin') return;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc signed ' + path.basename(appPath));
}

exports.default = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'win32') {
    await stampWindowsExe(path.join(context.appOutDir, name + '.exe'), context);
  } else if (context.electronPlatformName === 'darwin') {
    adhocSign(path.join(context.appOutDir, name + '.app'));
  }
};
