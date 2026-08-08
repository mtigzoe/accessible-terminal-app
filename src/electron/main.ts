function createTray() {
  let icon: Electron.NativeImage;

  try {
    // Prefer a packaged resource path; fall back to development location
    const candidates = [
      path.join(process.resourcesPath || '', 'assets', 'icon.png'),
      path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      path.join(process.cwd(), 'assets', 'icon.png')
    ];

    let iconPath = '';
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        iconPath = candidate;
        break;
      }
    }

    icon = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Accessible Terminal');

  // … rest of the tray menu code remains the same
}
