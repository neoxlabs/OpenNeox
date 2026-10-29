/* Synchronous pre-CSS initialization; external script keeps packaged CSP intact. */
(function () {
  try {
    var pack = localStorage.getItem('neox-theme-pack');
    var preset = localStorage.getItem('neox-theme-preset');
    var darkmode = localStorage.getItem('neox-darkmode');
    var color = localStorage.getItem('neox-color-theme');
    var legacyPresetToPack = {
      liuli: 'liulibasic', chenguang: 'chenguang', moye: 'anye',
      nuanyang: 'nuanyang', nailong: 'nuanyang'
    };
    if (!pack && legacyPresetToPack[preset]) {
      pack = legacyPresetToPack[preset];
      try { localStorage.setItem('neox-theme-pack', pack); } catch (e) { /* Read-only storage. */ }
    }
    var darkPacks = {
      anye: true, muyunqing: true, songyanmo: true, wumoyan: true, haiyue: true,
      neonlight: true, matrix: true, jiguang: true, vaporwave: true
    };
    var root = document.documentElement;
    if (pack) {
      root.setAttribute('data-theme-pack', pack);
      root.setAttribute('data-theme', darkPacks[pack] ? 'dark' : 'light');
    }
    var language = localStorage.getItem('neox-ui-language');
    if (language) root.setAttribute('lang', language);
    if (darkmode) root.setAttribute('data-darkmode', darkmode);
    if (color) root.setAttribute('data-color-theme', color);
    if (!pack) {
      if (darkmode === 'light') root.setAttribute('data-theme', 'light');
      else if (darkmode === 'dark' || darkmode === 'midnight' || darkmode === 'high-contrast') {
        root.setAttribute('data-theme', 'dark');
      } else {
        root.setAttribute('data-theme',
          window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      }
    }
  } catch (e) { /* Storage access must not block startup. */ }
})();
