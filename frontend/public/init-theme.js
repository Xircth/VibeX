(function () {
  try {
    if (location.pathname === '/desktop-toast') return;
    var theme = null;
    try {
      theme = localStorage.getItem('dimo:resolved-theme');
    } catch (e) {}
    if (theme !== 'light' && theme !== 'dark') {
      theme =
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    }
    var root = document.documentElement;
    root.classList.add(theme);
    var canvas = theme === 'dark' ? '#1b1b1b' : '#ffffff';
    root.style.backgroundColor = canvas;
    root.style.colorScheme = theme === 'dark' ? 'only dark' : 'only light';
  } catch (e) {}
})();
