import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.hush.call',
  appName: 'Ekanto',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    SystemBars: { initialViewportFitValueHint: 'cover' },
  },
};

export default config;
